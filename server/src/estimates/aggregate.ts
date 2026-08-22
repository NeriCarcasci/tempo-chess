import type { Sql } from "postgres";
import { requiredDate, type RawTimestamp } from "../db/timestamps.js";

import type { Queryable } from "../db/queryable.js";
import { describeConceptRole } from "../analysis/concepts/catalogue.js";
import { MAX_OPENING_PLIES } from "../openings/subject-explorer.js";
import { ESTIMATOR_POLICY, type Frame } from "./contract.js";
import { compare, estimate, type Estimate, type Observation } from "./estimator.js";
import {
  controlFalseDiscovery,
  dedupeAcrossFrames,
  deriveCandidates,
  derivePhaseContrast,
  selectPublished,
  type DimensionInput,
} from "./findings.js";
import { buildPhaseContrast, poolPhase, PHASE_ORDER } from "./phases.js";
import { moveNumberOf, phaseLabel, type Moment, type Phase } from "./specificity.js";
import { alignTrajectory, type TrajectoryGame } from "./trajectory.js";
import {
  ensureDimension,
  writeEstimate,
  writeFinding,
  writeTrajectory,
  type RegisteredEstimateVersions,
} from "./store.js";

/**
 * Build one subject report from one frozen snapshot.
 *
 * Frozen is the operative word. Everything here reads the snapshot's game list
 * rather than the subject's current games, so two runs over the same snapshot
 * produce the same report and a report can be reproduced months later from the
 * row that says which games it saw.
 */

export interface AggregateInput {
  analysisRunId: string;
  subjectId: string;
  subjectDataSnapshotId: string;
  versions: RegisteredEstimateVersions;
  /** The E12 versions the trajectory is attributed to. */
  phaseComponentVersionId: string;
  expectedScoreCalibrationVersionId: string;
  /** True when the subject's rating sits outside the calibrated band. */
  outsideCalibratedRange?: boolean;
  cutoff: Date;
}

export interface AggregateSummary {
  estimates: number;
  unavailableEstimates: number;
  trajectoryBins: number;
  findingsPublished: number;
  findingsWithheld: number;
  explanationsHeld: number;
  includedGames: number;
}

interface OpportunityRow {
  concept_version_id: string;
  concept_slug: string;
  role: string;
  speed: string | null;
  success: boolean | null;
  score: string | null;
  censored_reason: string | null;
  occurred_at: RawTimestamp;
  evidence_item_id: string | null;
  subject_game_id: string;
  opportunity_ply: number;
  phase: string | null;
  played_move_uci: string | null;
  best_move_uci: string | null;
}

/**
 * Read every scored opportunity the snapshot covers, and the moment it was.
 *
 * The join goes through `subject_data_snapshot_games` rather than through the
 * subject, which is what makes the report frozen: a game synced after the
 * snapshot was taken is not in it, and a report recomputed tomorrow sees the
 * same evidence as the one computed today.
 *
 * The ply, the phase and the two moves come along because a finding that cannot
 * say where it happened can only ever restate its own average. They cost one
 * left join each and no extra round trip.
 *
 * `context ->> 'evidenceItemId'` is the opportunity's own evidence row, written
 * beside it by the concept worker. The previous version of this query took
 * whichever `evidence_items` row for the same game sorted first, which is a
 * different row for every opportunity but the first one — so a finding's
 * "supporting evidence" was a list of arbitrary other moments in the same
 * games.
 *
 * The ordering is total. `order by occurred_at` alone left rows played in the
 * same second in whatever order the planner returned them, and the recent/
 * earlier split that the `personal_current` frame is built on cut that
 * arbitrary order in half — two runs over one frozen snapshot could disagree
 * about which games were "recent".
 */
async function readOpportunities(
  sql: Queryable,
  snapshotId: string,
): Promise<OpportunityRow[]> {
  return sql<OpportunityRow[]>`
    select o.concept_version_id, c.slug as concept_slug, o.role, o.speed,
           o.success, o.score, o.censored_reason, o.occurred_at,
           -- This observation's own evidence item, not the game's.
           --
           -- It used to be "the lowest-numbered opportunity evidence item in
           -- the same game", because the producer had nowhere typed to record
           -- which item belonged to which observation. For a game with one
           -- opportunity that was right by accident; for a game with thirty it
           -- attached all thirty findings to whichever item was inserted first,
           -- so "here is the evidence" showed the player a different moment
           -- from the one the claim was about. A citation pointing at the wrong
           -- thing is worse than none, because it looks checked.
           --
           -- The fallback is not a guess: rows written before FOR-123 recorded
           -- the correct id in the context blob, and simply had no column to
           -- put it in. Old rows therefore resolve to exactly the evidence they
           -- always meant.
           coalesce(o.evidence_item_id, (o.context->>'evidenceItemId')::bigint) as evidence_item_id,
           o.subject_game_id, o.opportunity_ply, o.phase,
           ta.played_move_uci, ta.best_move_uci
    from analysis.concept_opportunities o
    join analysis.subject_data_snapshot_games g
      on g.subject_game_id = o.subject_game_id and g.snapshot_id = ${snapshotId}
    join analysis.concept_versions cv on cv.id = o.concept_version_id
    join analysis.concepts c on c.id = cv.concept_id
    -- The published verdict on the move played at this ply, when the game has
    -- one. A left join: an opportunity the deterministic detectors found in an
    -- unanalysed game is still an observation, and it simply has no move to
    -- recommend.
    left join analysis.subject_game_publications pub
      on pub.subject_game_id = o.subject_game_id
    left join analysis.transition_assessments ta
      on ta.analysis_run_id = pub.run_id
     and ta.materialization_run_id = o.run_id
     and ta.from_ply = o.opportunity_ply
    order by o.occurred_at, o.subject_game_id, o.opportunity_ply, o.id
  `;
}

interface GameOpeningRow {
  subject_game_id: string;
  family: string | null;
  opening_name: string | null;
  first_off_book_ply: number | null;
}

export interface GameOpening {
  readonly family: string | null;
  readonly openingName: string | null;
  /** Ply of the move that left the book, or null if the game never did. */
  readonly departurePly: number | null;
}

/**
 * What each game in the snapshot was called, and where it left the book.
 *
 * One round trip for the whole snapshot rather than one per finding. The
 * opening is a property of the game, so it is resolved once per game and then
 * attached to every moment inside it.
 *
 * The name is the deepest position the catalogue still recognises on the game's
 * own move order, which is the answer a person would give: a player two moves
 * out of a Najdorf knows they are in a Najdorf, and "unknown" would be true and
 * useless. Departure is the first position with no catalogue row, minus one for
 * the move that reached it. Membership is tested by position rather than by
 * following `opening_edges`, because a position reached by an unusual move
 * order is still that position — testing edges would report every transposition
 * as off book, which is exactly the case a player most wants named.
 */
async function readGameOpenings(
  sql: Queryable,
  snapshotId: string,
): Promise<Map<string, GameOpening>> {
  const rows = await sql<GameOpeningRow[]>`
    with game as (
      select g.subject_game_id, sg.latest_replay_revision_id
      from analysis.subject_data_snapshot_games g
      join chess.subject_games sg on sg.id = g.subject_game_id
      where g.snapshot_id = ${snapshotId}
        and sg.latest_replay_revision_id is not null
    ),
    walked as (
      select game.subject_game_id, o.ply, cat.family, cat.opening_name,
             (cat.position_key is not null) as in_book
      from game
      join chess.materialization_runs mr
        on mr.replay_revision_id = game.latest_replay_revision_id
       and mr.state = 'published'
      -- Inclusive, unlike the explorer's bound: that one indexes the position a
      -- move is played *from*, and this one indexes the position reached.
      join chess.position_occurrences o on o.run_id = mr.id and o.ply <= ${MAX_OPENING_PLIES}
      join chess.core_positions cp on cp.id = o.core_position_id
      left join public.opening_positions cat on cat.position_key = cp.core_key
    )
    select subject_game_id,
           (array_agg(family order by ply desc) filter (where family is not null))[1] as family,
           (array_agg(opening_name order by ply desc) filter (where opening_name is not null))[1]
             as opening_name,
           min(ply) filter (where not in_book) as first_off_book_ply
    from walked
    group by subject_game_id
  `;

  const byGame = new Map<string, GameOpening>();
  for (const row of rows) {
    byGame.set(row.subject_game_id, {
      family: row.family,
      openingName: row.opening_name,
      // Ply 0 is the starting position, which the catalogue always contains, so
      // a real departure is at ply 1 or later and the departing move is one
      // before it. A zero here means the catalogue did not have the *starting*
      // position — an environment where it was never imported — and the honest
      // answer is that we do not know where the game left the book, not that it
      // left it on move one.
      departurePly:
        row.first_off_book_ply === null || row.first_off_book_ply <= 0
          ? null
          : row.first_off_book_ply - 1,
    });
  }
  return byGame;
}

const PHASES: ReadonlySet<string> = new Set(["opening", "middlegame", "endgame"]);

/** One recorded chance, in all three of the forms this module needs it in. */
interface Evidence {
  readonly row: OpportunityRow;
  readonly observation: Observation;
  readonly moment: Moment;
}

function momentOf(row: OpportunityRow, opening: GameOpening | undefined, occurredAt: Date): Moment {
  const censored = row.censored_reason !== null;
  return {
    gameId: row.subject_game_id,
    ply: row.opportunity_ply,
    phase: row.phase !== null && PHASES.has(row.phase) ? (row.phase as Phase) : null,
    openingFamily: opening?.family ?? null,
    occurredAt,
    censored,
    // Null exactly when censored: §17.5 again, one layer further out. A
    // censored chance that arrived here as `false` would become a failure in
    // every location claim built on top of it.
    success: censored ? null : row.success === true,
    playedMoveUci: row.played_move_uci,
    bestMoveUci: row.best_move_uci,
    departurePly: opening?.departurePly ?? null,
    openingName: opening?.openingName ?? null,
    evidenceItemId: row.evidence_item_id,
  };
}

/** Read the transition series the trajectory is aligned from. */
async function readTrajectoryGames(
  sql: Queryable,
  snapshotId: string,
): Promise<TrajectoryGame[]> {
  const rows = await sql<
    {
      subject_game_id: string;
      from_ply: number;
      phase: string | null;
      expected_score_after: string;
    }[]
  >`
    select g.subject_game_id, ta.from_ply, ta.phase, ta.expected_score_after
    from analysis.subject_data_snapshot_games g
    join analysis.subject_game_publications pub on pub.subject_game_id = g.subject_game_id
    join analysis.transition_assessments ta on ta.analysis_run_id = pub.run_id
    where g.snapshot_id = ${snapshotId} and ta.phase is not null
    order by g.subject_game_id, ta.from_ply
  `;

  const byGame = new Map<string, TrajectoryGame>();
  for (const row of rows) {
    const game = byGame.get(row.subject_game_id) ?? {
      gameKey: row.subject_game_id,
      points: [] as TrajectoryGame["points"],
    };
    (game.points as { ply: number; phase: "opening" | "middlegame" | "endgame"; expectedScore: number }[]).push({
      ply: row.from_ply,
      phase: row.phase as "opening" | "middlegame" | "endgame",
      expectedScore: Number(row.expected_score_after),
    });
    byGame.set(row.subject_game_id, game);
  }
  return [...byGame.values()];
}

/**
 * The frames v1 measures.
 *
 * `objective` and `personal_current` only. `peer_current` and `peer_stretch`
 * need the rating-pool calibration a cohort model supplies, and publishing them
 * from the same evidence under a different label would be the same number
 * wearing three hats — which is exactly what platform spec 3.2's separation
 * exists to prevent.
 */
const MEASURED_FRAMES: readonly Frame[] = ["objective", "personal_current"];

export async function aggregateSubjectReport(
  sql: Sql,
  input: AggregateInput,
): Promise<AggregateSummary> {
  const summary: AggregateSummary = {
    estimates: 0,
    unavailableEstimates: 0,
    trajectoryBins: 0,
    findingsPublished: 0,
    findingsWithheld: 0,
    explanationsHeld: 0,
    includedGames: 0,
  };

  const opportunities = await readOpportunities(sql, input.subjectDataSnapshotId);
  const openings = await readGameOpenings(sql, input.subjectDataSnapshotId);
  const games = await readTrajectoryGames(sql, input.subjectDataSnapshotId);
  summary.includedGames = games.length;

  // The observation and the moment are built together and stay paired.
  // Estimating from one list and locating from another that had been filtered
  // separately is how a report ends up describing where a problem is using
  // evidence the number never saw.
  const evidence: Evidence[] = opportunities.map((row) => {
    const occurredAt = requiredDate(row.occurred_at, "concept_opportunities.occurred_at");
    return {
      row,
      observation: {
        occurredAt,
        score: row.score !== null ? Number(row.score) : row.success ? 1 : 0,
        censored: row.censored_reason !== null,
        graded: row.score !== null,
      },
      moment: momentOf(row, openings.get(row.subject_game_id), occurredAt),
    };
  });

  // Group by the slice a dimension describes: concept and role. Speed is left
  // out of v1's dimension key on purpose — splitting a thin corpus by speed as
  // well produces four dimensions that each say "insufficient evidence".
  const byDimension = new Map<string, Evidence[]>();
  for (const item of evidence) {
    const key = `${item.row.concept_slug}_${item.row.role}`;
    byDimension.set(key, [...(byDimension.get(key) ?? []), item]);
  }

  const dimensionInputs: DimensionInput[] = [];
  const estimateIds = new Map<string, string>();
  const evidenceByDimension = new Map<string, string[]>();
  const conceptVersionByDimension = new Map<string, string>();
  let phaseContrastEvidence: string[] = [];

  for (const frame of MEASURED_FRAMES) {
    for (const [dimensionKey, rows] of byDimension) {
      const observations = rows.map((item) => item.observation);

      // `personal_current` compares the player to their own earlier evidence, so
      // it is measured on the recent window; `objective` is measured over
      // everything the snapshot holds.
      const windowKind = frame === "personal_current" ? "recent_form" : "lifetime";
      const scopedEvidence = frame === "personal_current" ? recentHalf(rows) : rows;
      const scoped = scopedEvidence.map((item) => item.observation);
      const moments = scopedEvidence.map((item) => item.moment);

      const result = estimate(scoped, input.cutoff, {
        outsideCalibratedRange:
          frame !== "objective" && input.outsideCalibratedRange === true,
      });

      const first = rows[0]!.row;
      const description = describeConceptRole(first.concept_slug, first.role);
      const dimensionId = await ensureDimension(sql, {
        dimensionKey: `${dimensionKey}_${frame}`,
        version: ESTIMATOR_POLICY.version,
        conceptVersionId: first.concept_version_id,
        role: first.role,
        speed: null,
        phase: null,
        frame,
        // The catalogue's own words. `skill_dimensions.display_name` is read
        // straight onto the dashboard, so "material_safety (respond)" was a
        // second place a database key was reaching a customer.
        displayName: description.label,
      });

      // The comparison is persisted before the estimate that cites it. A delta
      // with nothing to be a delta from is refused by the schema, and rightly:
      // "you improved by 0.12" is unreadable without the row saying from what.
      let comparison = null;
      let comparisonEstimateId: string | null = null;
      if (frame === "personal_current" && result.status === "available") {
        const earlier = estimate(
          earlierHalf(rows).map((item) => item.observation),
          input.cutoff,
        );
        if (earlier.status === "available") {
          comparison = compare(earlier, result as Estimate);
          comparisonEstimateId = await writeEstimate(
            sql,
            {
              analysisRunId: input.analysisRunId,
              subjectId: input.subjectId,
              subjectDataSnapshotId: input.subjectDataSnapshotId,
              estimatorComponentVersionId: input.versions.estimatorVersionId,
            },
            {
              skillDimensionId: dimensionId,
              windowKind: "baseline",
              result: earlier,
              comparisonEstimateId: null,
              delta: null,
              improvementProbability: null,
            },
          );
          summary.estimates += 1;
        }
      }

      const estimateId = await writeEstimate(
        sql,
        {
          analysisRunId: input.analysisRunId,
          subjectId: input.subjectId,
          subjectDataSnapshotId: input.subjectDataSnapshotId,
          estimatorComponentVersionId: input.versions.estimatorVersionId,
        },
        {
          skillDimensionId: dimensionId,
          windowKind,
          result,
          comparisonEstimateId,
          delta: comparison?.delta ?? null,
          improvementProbability: comparison?.improvementProbability ?? null,
        },
      );
      estimateIds.set(`${dimensionKey}_${frame}`, estimateId);
      evidenceByDimension.set(
        `${dimensionKey}_${frame}`,
        moments.map((moment) => moment.evidenceItemId).filter((id): id is string => id !== null),
      );
      conceptVersionByDimension.set(`${dimensionKey}_${frame}`, first.concept_version_id);

      summary.estimates += 1;
      if (result.status === "unavailable") summary.unavailableEstimates += 1;

      dimensionInputs.push({
        dimensionKey: `${dimensionKey}_${frame}`,
        frame,
        conceptSlug: first.concept_slug,
        role: first.role,
        claimFamily: frame === "objective" ? "objective_quality" : "personal_change",
        result,
        comparison,
        failureCount: moments.filter((moment) => !moment.censored && moment.success === false)
          .length,
        description,
        moments,
      });
    }
  }

  // ---------------------------------------------------------------------
  // Phase, as a dimension in its own right.
  //
  // Everything above is per concept, so the report could describe six ideas in
  // detail and never say the thing a player would notice first: that their
  // opening and their endgame are not the same standard. The pooled per-phase
  // estimate is what a phase card shows; the contrast below is what a finding
  // is allowed to claim, and it is computed differently on purpose.
  // ---------------------------------------------------------------------
  const phaseStrata = new Map<Phase, Map<string, Observation[]>>();
  const phaseMoments = new Map<Phase, Moment[]>();
  const strataLabels = new Map<string, string>();
  for (const item of evidence) {
    const phase = item.moment.phase;
    if (phase === null) continue;
    const key = `${item.row.concept_slug}_${item.row.role}`;
    strataLabels.set(key, describeConceptRole(item.row.concept_slug, item.row.role).label);
    const strata = phaseStrata.get(phase) ?? new Map<string, Observation[]>();
    strata.set(key, [...(strata.get(key) ?? []), item.observation]);
    phaseStrata.set(phase, strata);
    phaseMoments.set(phase, [...(phaseMoments.get(phase) ?? []), item.moment]);
  }

  for (const phase of PHASE_ORDER) {
    const strata = phaseStrata.get(phase);
    if (strata === undefined) continue;
    const result = poolPhase(strata, input.cutoff);
    const dimensionId = await ensureDimension(sql, {
      dimensionKey: `phase_${phase}`,
      version: ESTIMATOR_POLICY.version,
      conceptVersionId: null,
      role: null,
      speed: null,
      phase,
      frame: "objective",
      // Named as a pooled rate rather than as a skill. It mixes concepts, so
      // "your endgame is 67%" would invite a comparison with the per-concept
      // numbers beside it that the two quantities do not support.
      displayName: `Every chance in ${phaseLabel(phase)}`,
    });
    await writeEstimate(
      sql,
      {
        analysisRunId: input.analysisRunId,
        subjectId: input.subjectId,
        subjectDataSnapshotId: input.subjectDataSnapshotId,
        estimatorComponentVersionId: input.versions.estimatorVersionId,
      },
      {
        skillDimensionId: dimensionId,
        windowKind: "lifetime",
        result,
        comparisonEstimateId: null,
        delta: null,
        improvementProbability: null,
      },
    );
    summary.estimates += 1;
    if (result.status === "unavailable") summary.unavailableEstimates += 1;
  }

  const contrast = buildPhaseContrast(phaseStrata, input.cutoff);
  const phaseCandidates =
    contrast === null
      ? []
      : [
          derivePhaseContrast({
            contrast,
            sharedConceptLabels: [
              ...new Set(
                contrast.sharedStrata.map((key) => strataLabels.get(key) ?? "an unnamed concept"),
              ),
            ],
            claimFamily: "phase_contrast",
          }),
        ];
  if (contrast !== null) {
    // The finding is about the weaker phase, so its evidence is the moments in
    // that phase. Most recent first, matching how every other finding chooses
    // what to show.
    phaseContrastEvidence = [...(phaseMoments.get(contrast.weakest) ?? [])]
      .filter((moment) => !moment.censored && moment.success === false)
      .sort(
        (a, b) =>
          b.occurredAt.getTime() - a.occurredAt.getTime() ||
          a.gameId.localeCompare(b.gameId) ||
          a.ply - b.ply,
      )
      .map((moment) => moment.evidenceItemId)
      .filter((id): id is string => id !== null)
      .slice(0, 5);
  }

  if (games.length > 0) {
    const bins = alignTrajectory(games, { seed: seedFrom(input.subjectDataSnapshotId) });
    await writeTrajectory(
      sql,
      {
        analysisRunId: input.analysisRunId,
        subjectId: input.subjectId,
        subjectDataSnapshotId: input.subjectDataSnapshotId,
        phaseComponentVersionId: input.phaseComponentVersionId,
        alignmentComponentVersionId: input.versions.alignmentVersionId,
        expectedScoreCalibrationVersionId: input.expectedScoreCalibrationVersionId,
        includedGameCount: games.length,
        speed: null,
        color: null,
      },
      bins,
    );
    summary.trajectoryBins = bins.length;
  }

  // Collapse first, correct second. The two measured frames read overlapping
  // evidence about the same concept, so leaving both in would roughly double
  // the number of hypotheses each family's correction divides by, and every
  // real finding would be harder to publish because the report had asked the
  // same question twice.
  const candidates = controlFalseDiscovery(
    dedupeAcrossFrames([
      ...dimensionInputs.flatMap((dimension) => deriveCandidates(dimension)),
      ...phaseCandidates,
    ]),
  );
  const { published, withheld } = selectPublished(candidates);
  summary.findingsWithheld = withheld.length;

  for (const candidate of published) {
    const findingEvidence = evidenceFor(
      candidate.claim,
      candidate.findingType === "inconsistency"
        ? phaseContrastEvidence
        : evidenceByDimension.get(candidate.dimensionKey),
    );
    // A factual finding with no evidence rows would be refused at commit by
    // 0028's deferred trigger. Skipping it here names the reason instead of
    // failing the whole publication for one unlinkable claim.
    if (findingEvidence.length === 0 && candidate.findingType !== "insufficient_evidence") {
      summary.findingsWithheld += 1;
      continue;
    }
    const written = await writeFinding(
      sql,
      {
        analysisRunId: input.analysisRunId,
        subjectId: input.subjectId,
        correctionComponentVersionId: input.versions.correctionVersionId,
        rendererComponentVersionId: input.versions.rendererVersionId,
      },
      {
        candidate,
        playerSkillEstimateId: estimateIds.get(candidate.dimensionKey) ?? null,
        // These two columns have existed since 0028 and were being written as
        // null on every row, which left `analysis.findings` unable to answer
        // "which findings are about keeping pieces safe" without parsing a
        // dimension key out of jsonb.
        conceptVersionId: conceptVersionByDimension.get(candidate.dimensionKey) ?? null,
        role: candidate.role,
        evidence: findingEvidence,
      },
    );
    summary.findingsPublished += 1;
    if (written.safetyState !== "passed") summary.explanationsHeld += 1;
  }

  return summary;
}

/**
 * The evidence rows a finding cites, with the moment it shows put first.
 *
 * `finding_evidence.display_rank` is what a screen orders by, so the example
 * named in the prose has to be rank zero or the reader is shown a sentence
 * about move 23 above a list starting somewhere else. Its role is `example`
 * rather than `supports` because that is what it is; 0028 keeps the roles
 * distinct so a claim can carry evidence that cuts against it.
 */
function evidenceFor(
  claim: Record<string, unknown>,
  available: readonly string[] | undefined,
): { evidenceItemId: string; role: string; weight: number | null }[] {
  const pool = available ?? [];
  const example = claim.example as { evidenceItemId?: unknown } | null | undefined;
  const exampleId =
    example && typeof example.evidenceItemId === "string" ? example.evidenceItemId : null;

  const ordered: { evidenceItemId: string; role: string; weight: number | null }[] = [];
  const seen = new Set<string>();
  if (exampleId !== null) {
    ordered.push({ evidenceItemId: exampleId, role: "example", weight: null });
    seen.add(exampleId);
  }
  for (const evidenceItemId of pool) {
    if (ordered.length >= 5) break;
    if (seen.has(evidenceItemId)) continue;
    seen.add(evidenceItemId);
    ordered.push({ evidenceItemId, role: "supports", weight: null });
  }
  return ordered;
}

/** The later half of the evidence, by date. Empty when there is too little. */
function recentHalf<T extends { observation: Observation }>(evidence: readonly T[]): T[] {
  return sortedByDate(evidence).slice(Math.floor(evidence.length / 2));
}

function earlierHalf<T extends { observation: Observation }>(evidence: readonly T[]): T[] {
  return sortedByDate(evidence).slice(0, Math.floor(evidence.length / 2));
}

/**
 * Chronological, and total.
 *
 * The tie-break is not decoration: several games are recorded with the same
 * `occurred_at` to the second, and a sort that leaves them in an arbitrary
 * order puts a different set of games in the recent window on every run of the
 * same frozen snapshot.
 */
function sortedByDate<T extends { observation: Observation }>(evidence: readonly T[]): T[] {
  return [...evidence]
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        a.item.observation.occurredAt.getTime() - b.item.observation.occurredAt.getTime() ||
        a.index - b.index,
    )
    .map((entry) => entry.item);
}

/** A stable seed from the snapshot, so the bootstrap is reproducible per report. */
function seedFrom(snapshotId: string): number {
  let hash = 0;
  for (let i = 0; i < snapshotId.length; i += 1) {
    hash = (Math.imul(hash, 31) + snapshotId.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}
