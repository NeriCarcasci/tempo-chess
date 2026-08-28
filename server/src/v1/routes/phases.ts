import { z } from "zod";
import { resolveAnalysisSubject, withActorContext } from "../auth/context.js";
import { ProblemError } from "../problem.js";
import { POLICIES } from "../rate-limit.js";
import type { RouteDefinition } from "../registry.js";
import { moveNumberOf, sideOf } from "../../estimates/specificity.js";

/**
 * One phase of the game, in detail.
 *
 * The dashboard's phase cards say how a phase went as one pooled figure. This
 * route says what is *inside* that figure: the same frozen opportunities,
 * split by the concept and role each one belonged to, plus where in the game
 * the misses fall. It is the read behind `/middlegame` and `/endgame`, which
 * until now were placeholders saying "the data exists and the page does not".
 *
 * ## Counts and published estimates
 *
 * The counts remain the literal accounting of the frozen opportunities. The
 * estimates beside them are rows published by the estimator at this exact
 * concept × role × phase grain; a thin cell stays present with a null estimate
 * and an unavailable reason. The route never turns the raw share into a claim.
 *
 * ## The same frozen cohort
 *
 * Everything is read through the live-publication pointer and its snapshot,
 * exactly as `readDashboard` reads: a game synced after the report was
 * published is not counted here, and the concept totals sum to the published
 * card's chances by construction. That is what lets both screens print one
 * date and one denominator.
 */

const PHASES = ["opening", "middlegame", "endgame"] as const;
type Phase = (typeof PHASES)[number];

function phaseOf(params: Record<string, string>): Phase {
  const parsed = z.enum(PHASES).safeParse(params.phase);
  // A phase chess does not have is not a hint about the ones it does.
  if (!parsed.success) throw new ProblemError("NOT_FOUND", { detail: "No such phase." });
  return parsed.data;
}

const exampleSchema = z.object({
  subjectGameId: z.string(),
  moveNumber: z.number().int(),
  side: z.enum(["white", "black"]),
  fen: z.string(),
  /** Null when the game carries no published analysis for this ply. */
  playedMoveUci: z.string().nullable(),
  bestMoveUci: z.string().nullable(),
});

const estimateCoverageSchema = z.object({
  success: z.number().int(),
  failure: z.number().int(),
  graded: z.number().int(),
  /** Chances the player never got. Never counted as failures. */
  censored: z.number().int(),
});

const conceptEstimateSchema = z.object({
  frame: z.enum(["objective", "personal_current"]),
  windowKind: z.enum(["lifetime", "recent_form"]),
  estimate: z.number().nullable(),
  intervalLow: z.number().nullable(),
  intervalHigh: z.number().nullable(),
  rawSampleSize: z.number().int(),
  effectiveSampleSize: z.number(),
  coverage: estimateCoverageSchema,
  coverageStatus: z.string(),
  unavailableReason: z.string().nullable(),
  /** Present only when the personal current window has a valid baseline. */
  delta: z.number().nullable(),
  improvementProbability: z.number().nullable(),
});

const conceptSchema = z.object({
  slug: z.string(),
  role: z.string(),
  /** The catalogue's own name, resolved at read time. Never a key. */
  label: z.string(),
  roleLabel: z.string().nullable(),
  category: z.string().nullable(),
  /** One sentence for the player, or empty when the catalogue has none. */
  definition: z.string(),
  chances: z.number().int(),
  observed: z.number().int(),
  taken: z.number().int(),
  /** Chances that ended before the player was on move. Never failures. */
  setAside: z.number().int(),
  /**
   * `taken / observed`, or null with nothing observed. A counted share of
   * these exact rows, not an estimate: it carries no interval because the
   * estimator publishes none at this grain.
   */
  share: z.number().nullable(),
  /** Estimator-published rows at this exact concept, role and phase grain. */
  estimates: z.array(conceptEstimateSchema),
  /** The most recent miss, with the position it happened in. */
  example: exampleSchema.nullable(),
});

const missesByMoveSchema = z.object({
  moveNumber: z.number().int(),
  missed: z.number().int(),
  observed: z.number().int(),
});

const cardSchema = z.object({
  chances: z.number().int(),
  observed: z.number().int(),
  taken: z.number().int(),
  setAside: z.number().int(),
  rate: z.number().nullable(),
  intervalLow: z.number().nullable(),
  intervalHigh: z.number().nullable(),
  coverageStatus: z.string(),
  unavailableReason: z.string().nullable(),
  baselineRate: z.number().nullable(),
  recentRate: z.number().nullable(),
  delta: z.number().nullable(),
  improvementProbability: z.number().nullable(),
});

const phaseDetailSchema = z.object({
  phase: z.enum(PHASES),
  /** The publication every number below was read from. */
  publicationId: z.string(),
  publishedAt: z.string(),
  /** The frozen cohort, so the page can state its denominator once. */
  gamesInCohort: z.number().int(),
  /** The published pooled figure, identical to the dashboard's card. */
  card: cardSchema.nullable(),
  /** Worst-off first is the client's job; these arrive in catalogue order. */
  concepts: z.array(conceptSchema),
  missesByMove: z.array(missesByMoveSchema),
});

/** What a role is called on screen. Mirrors the dashboard's resolution. */
function roleLabelOf(role: string | null): string | null {
  if (role === "recognize") return "Recognising the chance";
  if (role === "execute") return "Following it through";
  if (role === "respond") return "Responding to it";
  if (role === "convert") return "Converting it";
  return null;
}

const phaseRoute: RouteDefinition<never, never, z.infer<typeof phaseDetailSchema>> = {
  method: "GET",
  path: "/v1/phases/:phase",
  operationId: "getPhaseDetail",
  summary: "What is inside one phase's published figure",
  description:
    "The published pooled figure for one phase of the game, and the same frozen chances split by "
    + "the concept and role each belonged to, with where in the game the misses fall. Everything is "
    + "read through the live publication's snapshot, so these counts sum to the dashboard card's "
    + "chances and the two screens quote one date. Each concept row carries estimator-published "
    + "objective and personal-current readings at this exact phase grain. Thin evidence remains "
    + "present with a null estimate and an unavailable reason; `share` remains only a raw count ratio.",
  kind: "read",
  auth: "required",
  envelope: "resource",
  successStatus: 200,
  dataSchema: phaseDetailSchema,
  etag: true,
  cacheControl: "private, max-age=0, must-revalidate",
  rateLimits: [{ policy: POLICIES.onboardingRead, source: "actor" }],
  async handler({ auth, params }) {
    if (!auth) throw new ProblemError("AUTH_REQUIRED");
    const phase = phaseOf(params);

    return withActorContext(auth.profileId, async (sql) => {
      // Not `auth.subjects[0]` — that is the profile id, always.
      const subjectId = await resolveAnalysisSubject(sql, auth.profileId);
      if (!subjectId) {
        throw new ProblemError("NOT_FOUND", { detail: "No published profile yet." });
      }

      const [publication] = await sql<
        { run_id: string; publication_id: string; published_at: string; snapshot_id: string }[]
      >`
        select p.run_id, p.publication_id, p.published_at,
               p.subject_data_snapshot_id as snapshot_id
        from analysis.subject_live_publications p
        join app.analysis_subjects s on s.id = p.subject_id
        where p.subject_id = ${subjectId} and s.owner_user_id = ${auth.profileId}
      `;
      if (!publication) {
        throw new ProblemError("NOT_FOUND", { detail: "No published profile yet." });
      }

      // The pooled card, from the same published estimate row the dashboard
      // reads. Re-deriving it from the opportunities below would let the two
      // screens disagree the day the estimator's exclusions change.
      const cardRows = await sql<
        {
          frame: string;
          window_kind: string;
          estimate: string | null;
          interval_low: string | null;
          interval_high: string | null;
          raw_sample_size: number;
          success_count: number;
          censored_count: number;
          coverage_status: string;
          unavailable_reason: string | null;
          delta: string | null;
          improvement_probability: string | null;
        }[]
      >`
        select d.frame, e.window_kind, e.estimate, e.interval_low, e.interval_high,
               e.raw_sample_size, e.success_count, e.censored_count,
               e.coverage_status, e.unavailable_reason, e.delta, e.improvement_probability
        from analysis.player_skill_estimates e
        join analysis.skill_dimensions d on d.id = e.skill_dimension_id
        where e.analysis_run_id = ${publication.run_id}
          and d.phase = ${phase}
          and d.concept_version_id is null
          and (
            (d.frame = 'objective' and e.window_kind = 'lifetime')
            or
            (d.frame = 'personal_current' and e.window_kind in ('baseline', 'recent_form'))
          )
      `;
      const cardRow = cardRows.find(
        (row) => row.frame === "objective" && row.window_kind === "lifetime",
      );
      const personalCardRow = cardRows.find(
        (row) => row.frame === "personal_current" && row.window_kind === "recent_form",
      );
      const baselineCardRow = cardRows.find(
        (row) => row.frame === "personal_current" && row.window_kind === "baseline",
      );

      const [cohort] = await sql<{ included_game_count: number }[]>`
        select included_game_count from analysis.player_trajectory_snapshots
        where analysis_run_id = ${publication.run_id} and speed is null and color is null
        limit 1
      `;

      // The same rows the estimator aggregated, grouped by what each chance
      // was. Grouped by the concept rather than its version: versions are how
      // the detector evolves, not something a reader tells apart.
      const conceptRows = await sql<
        {
          slug: string;
          role: string;
          label: string;
          category: string | null;
          definition: string | null;
          chances: number;
          observed: number;
          taken: number;
        }[]
      >`
        select c.slug, o.role,
               c.display_name as label, c.category,
               (array_agg(cv.human_definition order by cv.id desc))[1] as definition,
               count(*)::int as chances,
               count(*) filter (where o.success is not null)::int as observed,
               count(*) filter (where o.success)::int as taken
        from analysis.concept_opportunities o
        join analysis.subject_data_snapshot_games g
          on g.subject_game_id = o.subject_game_id and g.snapshot_id = ${publication.snapshot_id}
        join analysis.concept_versions cv on cv.id = o.concept_version_id
        join analysis.concepts c on c.id = cv.concept_id
        where o.phase = ${phase}
        group by c.slug, o.role, c.display_name, c.category
        order by c.display_name, o.role
      `;

      const estimateRows = await sql<
        {
          slug: string;
          role: string;
          frame: "objective" | "personal_current";
          window_kind: "lifetime" | "recent_form";
          estimate: string | null;
          interval_low: string | null;
          interval_high: string | null;
          raw_sample_size: number;
          effective_sample_size: string;
          success_count: number;
          failure_count: number;
          graded_count: number;
          censored_count: number;
          coverage_status: string;
          unavailable_reason: string | null;
          delta: string | null;
          improvement_probability: string | null;
        }[]
      >`
        select c.slug, d.role, d.frame, e.window_kind, e.estimate,
               e.interval_low, e.interval_high, e.raw_sample_size, e.effective_sample_size,
               e.success_count, e.failure_count, e.graded_count, e.censored_count,
               e.coverage_status, e.unavailable_reason, e.delta, e.improvement_probability
        from analysis.player_skill_estimates e
        join analysis.skill_dimensions d on d.id = e.skill_dimension_id
        join analysis.concept_versions cv on cv.id = d.concept_version_id
        join analysis.concepts c on c.id = cv.concept_id
        where e.analysis_run_id = ${publication.run_id}
          and d.phase = ${phase}
          and (
            (d.frame = 'objective' and e.window_kind = 'lifetime')
            or
            (d.frame = 'personal_current' and e.window_kind = 'recent_form')
          )
        order by c.slug, d.role,
                 case d.frame when 'objective' then 0 else 1 end
      `;

      // One example per concept and role: the most recent miss, with the
      // position it happened in. The played and best moves come from the
      // published analysis when the game has one, exactly as the estimator
      // reads them; the fen comes from the same materialization run the
      // opportunity indexes, so the board is the position the claim is about.
      const exampleRows = await sql<
        {
          slug: string;
          role: string;
          subject_game_id: string;
          opportunity_ply: number;
          fen: string;
          played_move_uci: string | null;
          best_move_uci: string | null;
        }[]
      >`
        select distinct on (c.slug, o.role)
               c.slug, o.role, o.subject_game_id, o.opportunity_ply, po.fen,
               ta.played_move_uci, ta.best_move_uci
        from analysis.concept_opportunities o
        join analysis.subject_data_snapshot_games g
          on g.subject_game_id = o.subject_game_id and g.snapshot_id = ${publication.snapshot_id}
        join analysis.concept_versions cv on cv.id = o.concept_version_id
        join analysis.concepts c on c.id = cv.concept_id
        join chess.position_occurrences po
          on po.run_id = o.run_id and po.ply = o.opportunity_ply
        left join analysis.subject_game_publications pub
          on pub.subject_game_id = o.subject_game_id
        left join analysis.transition_assessments ta
          on ta.analysis_run_id = pub.run_id
         and ta.materialization_run_id = o.run_id
         and ta.from_ply = o.opportunity_ply
        where o.phase = ${phase} and o.success = false
        order by c.slug, o.role, o.occurred_at desc
      `;

      const missRows = await sql<
        { move_number: number; missed: number; observed: number }[]
      >`
        select (floor(o.opportunity_ply / 2) + 1)::int as move_number,
               count(*) filter (where o.success = false)::int as missed,
               count(*) filter (where o.success is not null)::int as observed
        from analysis.concept_opportunities o
        join analysis.subject_data_snapshot_games g
          on g.subject_game_id = o.subject_game_id and g.snapshot_id = ${publication.snapshot_id}
        where o.phase = ${phase}
        group by move_number
        order by move_number
      `;

      const exampleByKey = new Map(
        exampleRows.map((row) => [`${row.slug}:${row.role}`, row]),
      );
      const estimatesByKey = new Map<string, z.infer<typeof conceptEstimateSchema>[]>();
      for (const row of estimateRows) {
        const key = `${row.slug}:${row.role}`;
        estimatesByKey.set(key, [
          ...(estimatesByKey.get(key) ?? []),
          {
            frame: row.frame,
            windowKind: row.window_kind,
            estimate: row.estimate === null ? null : Number(row.estimate),
            intervalLow: row.interval_low === null ? null : Number(row.interval_low),
            intervalHigh: row.interval_high === null ? null : Number(row.interval_high),
            rawSampleSize: row.raw_sample_size,
            effectiveSampleSize: Number(row.effective_sample_size),
            coverage: {
              success: row.success_count,
              failure: row.failure_count,
              graded: row.graded_count,
              censored: row.censored_count,
            },
            coverageStatus: row.coverage_status,
            unavailableReason: row.unavailable_reason,
            delta: row.delta === null ? null : Number(row.delta),
            improvementProbability:
              row.improvement_probability === null
                ? null
                : Number(row.improvement_probability),
          },
        ]);
      }

      return {
        data: {
          phase,
          publicationId: publication.publication_id,
          publishedAt: publication.published_at,
          gamesInCohort: cohort?.included_game_count ?? 0,
          card: cardRow
            ? {
                chances: cardRow.raw_sample_size,
                observed: cardRow.raw_sample_size - cardRow.censored_count,
                taken: cardRow.success_count,
                setAside: cardRow.censored_count,
                rate: cardRow.estimate === null ? null : Number(cardRow.estimate),
                intervalLow: cardRow.interval_low === null ? null : Number(cardRow.interval_low),
                intervalHigh:
                  cardRow.interval_high === null ? null : Number(cardRow.interval_high),
                coverageStatus: cardRow.coverage_status,
                unavailableReason: cardRow.unavailable_reason,
                baselineRate:
                  baselineCardRow?.estimate === null || baselineCardRow?.estimate === undefined
                    ? null
                    : Number(baselineCardRow.estimate),
                recentRate:
                  personalCardRow?.estimate === null || personalCardRow?.estimate === undefined
                    ? null
                    : Number(personalCardRow.estimate),
                delta:
                  personalCardRow?.delta === null || personalCardRow?.delta === undefined
                    ? null
                    : Number(personalCardRow.delta),
                improvementProbability:
                  personalCardRow?.improvement_probability === null
                    || personalCardRow?.improvement_probability === undefined
                    ? null
                    : Number(personalCardRow.improvement_probability),
              }
            : null,
          concepts: conceptRows.map((row) => {
            const example = exampleByKey.get(`${row.slug}:${row.role}`) ?? null;
            return {
              slug: row.slug,
              role: row.role,
              label: row.label,
              roleLabel: roleLabelOf(row.role),
              category: row.category,
              definition: row.definition ?? "",
              chances: row.chances,
              observed: row.observed,
              taken: row.taken,
              setAside: row.chances - row.observed,
              share: row.observed > 0 ? row.taken / row.observed : null,
              estimates: estimatesByKey.get(`${row.slug}:${row.role}`) ?? [],
              example: example
                ? {
                    subjectGameId: example.subject_game_id,
                    moveNumber: moveNumberOf(example.opportunity_ply),
                    side: sideOf(example.opportunity_ply),
                    fen: example.fen,
                    playedMoveUci: example.played_move_uci,
                    bestMoveUci: example.best_move_uci,
                  }
                : null,
            };
          }),
          missesByMove: missRows.map((row) => ({
            moveNumber: row.move_number,
            missed: row.missed,
            observed: row.observed,
          })),
        },
      };
    });
  },
};

export const PHASE_ROUTES = [phaseRoute] as const;
