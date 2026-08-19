/**
 * The goal surface, per plans/v1-api-contract.md §10.
 *
 * Three shapes carry the epic's ethics onto the wire.
 *
 * A target that would sit inside the noise is moved out to the smallest thing
 * that can actually be measured, and the response says so. The user asked for
 * something too small to see; they are told the smallest visible thing rather
 * than being quietly given a goal that is already met.
 *
 * `GET /goals/{id}/progress` returns adherence, readiness and real-game
 * evidence as three separate members. A client cannot render "you are 80% of
 * the way there" from an activity counter, because the activity counter is in a
 * different field with a different name.
 *
 * `POST /goals/{id}/close` always closes the goal — it belongs to the user —
 * and separately reports whether the target was demonstrated. Closing something
 * as complete does not make the product record an achievement that did not
 * happen.
 */

import { ensureIdentity } from "../../identity/service.js";
import { activateGoal } from "../../goals/activate.js";
import { planProgressForSubject } from "../../goals/progress-worker.js";
import type { ResolvedTarget } from "../../goals/resolve.js";
import { isoOf, requiredIso } from "../../db/timestamps.js";
import { z } from "zod";

import { client } from "../../db/client.js";
import { withActorContext } from "../auth/context.js";
import { ProblemError } from "../problem.js";
import { POLICIES } from "../rate-limit.js";
import type { RouteDefinition } from "../registry.js";
import { GOAL_POLICY } from "../../goals/contract.js";
import { checkHorizon, resolveTarget } from "../../goals/resolve.js";
import { checkClose, type ProgressReading } from "../../goals/progress.js";
import {
  closeGoal,
  createGoal,
  currentCommitments,
  latestProgress,
  listGoals,
  loadGoal,
  recordCommitment,
  type GoalRow,
} from "../../goals/store.js";

const UUID = z.uuid();

function goalIdOf(params: Record<string, string>): string {
  const parsed = UUID.safeParse(params.goalId);
  if (!parsed.success) throw new ProblemError("NOT_FOUND", { detail: "No such goal." });
  return parsed.data;
}

const goalSchema = z.object({
  goalId: z.string(),
  subjectId: z.string(),
  status: z.string(),
  statedObjective: z.string(),
  comparisonFrame: z.string(),
  targetProvider: z.string().nullable(),
  targetSpeed: z.string().nullable(),
  horizonDays: z.number().int().nullable(),
  uncalibratedCaveat: z.string().nullable(),
  createdAt: z.string(),
  activatedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  closeOutcome: z.string().nullable(),
  closeNote: z.string().nullable(),
});

type GoalView = z.infer<typeof goalSchema>;

function viewOf(row: GoalRow): GoalView {
  return {
    goalId: row.id,
    subjectId: row.subject_id,
    status: row.status,
    statedObjective: row.stated_objective,
    comparisonFrame: row.comparison_frame,
    targetProvider: row.target_provider,
    targetSpeed: row.target_speed,
    horizonDays: row.horizon_days,
    uncalibratedCaveat: row.uncalibrated_caveat,
    createdAt: requiredIso(row.created_at, "goals.created_at"),
    activatedAt: isoOf(row.activated_at),
    closedAt: isoOf(row.closed_at),
    closeOutcome: row.close_outcome,
    closeNote: row.close_note,
  };
}

// ---------------------------------------------------------------------------
// GET /v1/goal-templates
// ---------------------------------------------------------------------------

const templateSchema = z.object({
  templateVersionId: z.string(),
  templateKey: z.string(),
  category: z.string(),
  displayName: z.string(),
  supportedOutcome: z.string(),
  requiresCalibratedCohort: z.boolean(),
});

const templatesRoute: RouteDefinition<never, never, z.infer<typeof templateSchema>[]> = {
  method: "GET",
  path: "/v1/goal-templates",
  operationId: "listGoalTemplates",
  summary: "The promoted goal templates and what each one needs",
  description:
    "`requiresCalibratedCohort` is the caveat made explicit: a template that needs a calibrated cohort cannot state a numeric target for a player outside the calibrated band, and the client should say so rather than offering a promise Forma cannot keep.",
  kind: "read",
  auth: "required",
  envelope: "collection",
  successStatus: 200,
  cacheControl: "private, max-age=60",
  dataSchema: z.array(templateSchema),
  rateLimits: [{ policy: POLICIES.onboardingRead, source: "actor" }],
  async handler({ auth }) {
    if (!auth) throw new ProblemError("AUTH_REQUIRED");
    const rows = await client<
      {
        id: string;
        template_key: string;
        category: string;
        display_name: string;
        supported_outcome: string;
        requires_calibrated_cohort: boolean;
      }[]
    >`
      select v.id, t.template_key, t.category, t.display_name, v.supported_outcome,
             v.requires_calibrated_cohort
      from coaching.goal_template_versions v
      join coaching.goal_templates t on t.id = v.template_id
      where v.promoted_at is not null
      order by t.category, t.template_key
    `;
    return {
      data: rows.map((row) => ({
        templateVersionId: row.id,
        templateKey: row.template_key,
        category: row.category,
        displayName: row.display_name,
        supportedOutcome: row.supported_outcome,
        requiresCalibratedCohort: row.requires_calibrated_cohort,
      })),
    };
  },
};

// ---------------------------------------------------------------------------
// GET /v1/goals
// ---------------------------------------------------------------------------

const listRoute: RouteDefinition<never, never, GoalView[]> = {
  method: "GET",
  path: "/v1/goals",
  operationId: "listGoals",
  summary: "The caller's goals",
  kind: "read",
  auth: "required",
  envelope: "collection",
  successStatus: 200,
  cacheControl: "private, max-age=0, must-revalidate",
  dataSchema: z.array(goalSchema),
  rateLimits: [{ policy: POLICIES.onboardingRead, source: "actor" }],
  async handler({ auth }) {
    if (!auth) throw new ProblemError("AUTH_REQUIRED");
    return withActorContext(auth.profileId, async (sql) => {
      const rows = await listGoals(sql, auth.profileId);
      return { data: rows.map(viewOf) };
    });
  },
};

// ---------------------------------------------------------------------------
// POST /v1/goals
// ---------------------------------------------------------------------------

/** No `subjectId`: the kernel refuses one, and identity comes from the token. */
const createBody = z.object({
  templateVersionId: z.uuid().nullable().default(null),
  statedObjective: z.string().min(3).max(500),
  comparisonFrame: z.enum(["personal_current", "peer_current", "peer_stretch", "objective"]),
  targetProvider: z.enum(["lichess", "chesscom"]).nullable().default(null),
  targetSpeed: z
    .enum(["bullet", "blitz", "rapid", "classical", "correspondence"])
    .nullable()
    .default(null),
  horizonDays: z.number().int().nullable().default(null),
  /** Optional named targets. Each is resolved against the current estimate. */
  targets: z
    .array(
      z.object({
        metricKey: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/),
        direction: z.enum(["increase", "decrease"]),
        requestedValue: z.number().nullable().default(null),
      }),
    )
    .max(6)
    .default([]),
});

const createdSchema = z.object({
  goal: goalSchema,
  targets: z.array(
    z.object({
      metricKey: z.string(),
      baselineValue: z.number(),
      targetValue: z.number(),
      direction: z.string(),
      adjustedFromRequested: z.number().nullable(),
    }),
  ),
  rejected: z.array(z.object({ metricKey: z.string(), code: z.string(), detail: z.string() })),
  /** The cycle this goal opened, or null when it could not open one yet. */
  cycleId: z.string().nullable(),
  /**
   * `unavailable` when there is no published analysis to anchor a cycle to.
   * Saying so is the honest answer: a cycle with a baseline of zero would
   * measure improvement against a number nobody produced.
   */
  planState: z.enum(["published", "unavailable"]),
});

const createRoute: RouteDefinition<never, z.infer<typeof createBody>, z.infer<typeof createdSchema>> = {
  method: "POST",
  path: "/v1/goals",
  operationId: "createGoal",
  summary: "Draft a goal and resolve its targets",
  description:
    "A requested target inside the noise floor is moved out to the smallest change that can actually be measured, and `adjustedFromRequested` says what was asked for. A target that cannot be resolved at all is returned in `rejected` with a stable code rather than silently dropped.",
  kind: "command",
  auth: "required",
  idempotency: "key",
  envelope: "resource",
  successStatus: 201,
  bodySchema: createBody,
  dataSchema: createdSchema,
  rateLimits: [{ policy: POLICIES.onboardingCommand, source: "actor" }],
  async handler({ auth, body }) {
    if (!auth) throw new ProblemError("AUTH_REQUIRED");
    // The caller's own personal subject, created on first sight.
    const subjectId = await ensureIdentity(auth.profileId);
    if (!subjectId) throw new ProblemError("NOT_FOUND", { detail: "No such subject." });
    const horizon = checkHorizon(body.horizonDays);
    if (!horizon.ok) {
      throw new ProblemError("VALIDATION_FAILED", { detail: horizon.detail });
    }

    return withActorContext(auth.profileId, async (sql) => {
      // Baselines come from the subject's published estimates. A target with no
      // baseline is refused rather than anchored to zero.
      const baselines = await sql<
        {
          dimension_key: string;
          estimate: string | null;
          interval_low: string | null;
          interval_high: string | null;
          raw_sample_size: number;
        }[]
      >`
        select d.dimension_key, e.estimate, e.interval_low, e.interval_high, e.raw_sample_size
        from analysis.player_skill_estimates e
        join analysis.skill_dimensions d on d.id = e.skill_dimension_id
        join analysis.subject_live_publications p on p.run_id = e.analysis_run_id
        where p.subject_id = ${subjectId} and e.window_kind = 'lifetime'
      `;
      const byMetric = new Map(baselines.map((row) => [row.dimension_key, row]));

      const resolved: z.infer<typeof createdSchema>["targets"] = [];
      // The full resolved target, kept beside the display shape: the cycle
      // pins `meaningfulChange` and `requiredEvidenceCount`, which are what
      // make "reached the target" a decidable question rather than a feeling.
      const resolvedTargets: ResolvedTarget[] = [];
      const rejected: z.infer<typeof createdSchema>["rejected"] = [];
      for (const target of body.targets) {
        const baseline = byMetric.get(target.metricKey);
        const result = resolveTarget({
          metricKey: target.metricKey,
          frame: body.comparisonFrame,
          baselineValue: baseline?.estimate === null || baseline === undefined
            ? Number.NaN
            : Number(baseline.estimate),
          baselineIntervalLow:
            baseline?.interval_low == null ? null : Number(baseline.interval_low),
          baselineIntervalHigh:
            baseline?.interval_high == null ? null : Number(baseline.interval_high),
          direction: target.direction,
          requestedValue: target.requestedValue,
          meaningfulChange: 0.05,
          requiredEvidenceCount: 3,
          baselineSampleSize: baseline?.raw_sample_size ?? 0,
        });
        if (result.resolved) {
          resolvedTargets.push(result);
          resolved.push({
            metricKey: result.metricKey,
            baselineValue: result.baselineValue,
            targetValue: result.targetValue,
            direction: result.direction,
            adjustedFromRequested: result.adjustedFromRequested,
          });
        } else {
          rejected.push({ metricKey: target.metricKey, code: result.code, detail: result.detail });
        }
      }

      const goalId = await createGoal(sql, {
        subjectId,
        templateVersionId: body.templateVersionId,
        statedObjective: body.statedObjective,
        comparisonFrame: body.comparisonFrame,
        targetProvider: body.targetProvider,
        targetPool: body.targetSpeed,
        targetSpeed: body.targetSpeed,
        horizonDays: body.horizonDays,
        uncalibratedCaveat: null,
      });
      // Creating a goal opens its cycle and writes its plan. Leaving it a draft
      // was E17's gap: the plan endpoint answered `unavailable` forever because
      // nothing ever created the cycle it reads.
      const activation = await activateGoal(sql, {
        goalId,
        subjectId,
        targets: resolvedTargets,
        horizonDays: body.horizonDays,
      });

      // One reading straight away, so the progress screen has something true to
      // show rather than "nothing has been measured yet" on the day somebody
      // set the goal. Planned here because only the API may create work.
      if (activation.activated) {
        await planProgressForSubject(client, {
          subjectId,
          ownerProfileId: auth.profileId,
          reason: `cycle-opened:${activation.cycleId}`,
        });
      }

      const row = await loadGoal(sql, { goalId, ownerProfileId: auth.profileId });
      if (!row) throw new ProblemError("NOT_FOUND", { detail: "No such goal." });
      return {
        status: 201,
        data: {
          goal: viewOf(row),
          targets: resolved,
          rejected,
          cycleId: activation.activated ? activation.cycleId : null,
          planState: activation.activated ? ("published" as const) : ("unavailable" as const),
        },
      };
    });
  },
};

// ---------------------------------------------------------------------------
// GET /v1/goals/{goalId}
// ---------------------------------------------------------------------------

const getRoute: RouteDefinition<never, never, GoalView> = {
  method: "GET",
  path: "/v1/goals/:goalId",
  operationId: "getGoal",
  summary: "One goal",
  kind: "read",
  auth: "required",
  envelope: "resource",
  successStatus: 200,
  cacheControl: "private, max-age=0, must-revalidate",
  etag: true,
  dataSchema: goalSchema,
  rateLimits: [{ policy: POLICIES.onboardingRead, source: "actor" }],
  async handler({ auth, params }) {
    if (!auth) throw new ProblemError("AUTH_REQUIRED");
    const goalId = goalIdOf(params);
    return withActorContext(auth.profileId, async (sql) => {
      const row = await loadGoal(sql, { goalId, ownerProfileId: auth.profileId });
      if (!row) throw new ProblemError("NOT_FOUND", { detail: "No such goal." });
      return { data: viewOf(row) };
    });
  },
};

// ---------------------------------------------------------------------------
// GET /v1/goals/{goalId}/plan
// ---------------------------------------------------------------------------

const planSchema = z.object({
  state: z.enum(["published", "unavailable"]),
  cycleId: z.string().nullable(),
  requirements: z.array(
    z.object({
      requirementKey: z.string(),
      kind: z.string(),
      quantity: z.number(),
      unit: z.string(),
      windowDays: z.number().int(),
      essential: z.boolean(),
      rationale: z.string(),
      displayRank: z.number().int(),
    }),
  ),
  commitments: z.array(
    z.object({
      commitmentKey: z.string(),
      revision: z.number().int(),
      target: z.number(),
      cadence: z.string(),
      unit: z.string(),
      enabled: z.boolean(),
      confirmedAt: z.string(),
    }),
  ),
});

const planRoute: RouteDefinition<never, never, z.infer<typeof planSchema>> = {
  method: "GET",
  path: "/v1/goals/:goalId/plan",
  operationId: "getGoalPlan",
  summary: "The ranked plan for a goal's active cycle",
  description:
    "Every requirement carries the rationale it was generated with. There is no universal rule here: the plan is derived from the gaps this person's own report found, and a requirement that cannot say which gap it addresses would be a chore rather than coaching.",
  kind: "read",
  auth: "required",
  envelope: "resource",
  successStatus: 200,
  cacheControl: "private, max-age=0, must-revalidate",
  dataSchema: planSchema,
  rateLimits: [{ policy: POLICIES.onboardingRead, source: "actor" }],
  async handler({ auth, params }) {
    if (!auth) throw new ProblemError("AUTH_REQUIRED");
    const goalId = goalIdOf(params);
    return withActorContext(auth.profileId, async (sql) => {
      const goal = await loadGoal(sql, { goalId, ownerProfileId: auth.profileId });
      if (!goal) throw new ProblemError("NOT_FOUND", { detail: "No such goal." });

      const [cycle] = await sql<{ id: string }[]>`
        select id from coaching.coaching_cycles
        where goal_id = ${goalId} and status = 'active'
      `;
      if (!cycle) {
        return {
          data: { state: "unavailable" as const, cycleId: null, requirements: [], commitments: [] },
        };
      }

      const requirements = await sql<
        {
          requirement_key: string;
          kind: string;
          quantity: string;
          unit: string;
          window_days: number;
          essential: boolean;
          rationale: string;
          display_rank: number;
        }[]
      >`
        select requirement_key, kind, quantity, unit, window_days, essential, rationale,
               display_rank
        from coaching.goal_requirements
        where cycle_id = ${cycle.id}
        order by display_rank
      `;
      const commitments = await currentCommitments(sql, cycle.id);

      return {
        data: {
          state: "published" as const,
          cycleId: cycle.id,
          requirements: requirements.map((row) => ({
            requirementKey: row.requirement_key,
            kind: row.kind,
            quantity: Number(row.quantity),
            unit: row.unit,
            windowDays: row.window_days,
            essential: row.essential,
            rationale: row.rationale,
            displayRank: row.display_rank,
          })),
          commitments: commitments.map((row) => ({
            commitmentKey: row.commitment_key,
            revision: row.revision,
            target: Number(row.target),
            cadence: row.cadence,
            unit: row.unit,
            enabled: row.enabled,
            confirmedAt: requiredIso(row.confirmed_at, "goal_commitments.confirmed_at"),
          })),
        },
      };
    });
  },
};

// ---------------------------------------------------------------------------
// PUT /v1/goals/{goalId}/commitments/{commitmentKey}
// ---------------------------------------------------------------------------

const commitmentBody = z.object({
  target: z.number().positive().max(1000),
  cadence: z.enum(["daily", "weekly", "fortnightly"]),
  unit: z.enum(["games", "reviews", "sessions", "minutes"]),
  enabled: z.boolean().default(true),
  acceptedRequirementKeys: z.array(z.string().regex(/^[a-z][a-z0-9_]{2,63}$/)).max(20).default([]),
});

const commitmentSchema = z.object({
  commitmentKey: z.string(),
  revision: z.number().int(),
  confirmedAt: z.string(),
});

const commitmentRoute: RouteDefinition<never, z.infer<typeof commitmentBody>, z.infer<typeof commitmentSchema>> = {
  method: "PUT",
  path: "/v1/goals/:goalId/commitments/:commitmentKey",
  operationId: "setGoalCommitment",
  summary: "Record what the user is committing to",
  description:
    "Append-only: a change writes a new revision rather than editing the last one, and the confirmation time is required. A commitment is never inferred from what somebody actually did — that would be the product deciding what they signed up for and then holding them to it.",
  kind: "command",
  auth: "required",
  idempotency: "key",
  envelope: "resource",
  successStatus: 200,
  bodySchema: commitmentBody,
  dataSchema: commitmentSchema,
  rateLimits: [{ policy: POLICIES.onboardingCommand, source: "actor" }],
  async handler({ auth, body, params }) {
    if (!auth) throw new ProblemError("AUTH_REQUIRED");
    const goalId = goalIdOf(params);
    const commitmentKey = params.commitmentKey ?? "";
    if (!/^[a-z][a-z0-9_]{2,63}$/.test(commitmentKey)) {
      throw new ProblemError("NOT_FOUND", { detail: "No such commitment." });
    }

    return withActorContext(auth.profileId, async (sql) => {
      const goal = await loadGoal(sql, { goalId, ownerProfileId: auth.profileId });
      if (!goal) throw new ProblemError("NOT_FOUND", { detail: "No such goal." });

      const [cycle] = await sql<{ id: string }[]>`
        select id from coaching.coaching_cycles
        where goal_id = ${goalId} and status = 'active'
      `;
      if (!cycle) {
        throw new ProblemError("CONFLICT", {
          detail: "This goal has no active cycle to commit to.",
        });
      }

      const confirmedAt = new Date();
      const revision = await recordCommitment(sql, {
        cycleId: cycle.id,
        commitmentKey,
        target: body.target,
        cadence: body.cadence,
        unit: body.unit,
        enabled: body.enabled,
        acceptedRequirementKeys: body.acceptedRequirementKeys,
        effectiveFrom: confirmedAt.toISOString().slice(0, 10),
        confirmedAt,
      });
      return {
        data: { commitmentKey, revision, confirmedAt: confirmedAt.toISOString() },
      };
    });
  },
};

// ---------------------------------------------------------------------------
// GET /v1/goals/{goalId}/progress
// ---------------------------------------------------------------------------

const progressSchema = z.object({
  state: z.enum(["published", "unavailable"]),
  metrics: z.array(
    z.object({
      metricKey: z.string(),
      currentValue: z.number().nullable(),
      readiness: z.number().nullable(),
      claimState: z.string(),
      targetAchieved: z.boolean(),
      unavailableReason: z.string().nullable(),
    }),
  ),
  adherence: z.object({
    ratio: z.number().nullable(),
    note: z.string(),
  }),
  realGameEvidence: z.number().int(),
  practiceEvidence: z.number().int(),
});

const progressRoute: RouteDefinition<never, never, z.infer<typeof progressSchema>> = {
  method: "GET",
  path: "/v1/goals/:goalId/progress",
  operationId: "getGoalProgress",
  summary: "Metric progress, adherence and real-game evidence, kept apart",
  description:
    "Three separate members on purpose. Adherence is what the user did against what they committed to; readiness is how close the estimate is to the target; real-game evidence is the only thing that can complete a goal. A client cannot render progress from the activity counter, because the activity counter is a different field.",
  kind: "read",
  auth: "required",
  envelope: "resource",
  successStatus: 200,
  cacheControl: "private, max-age=0, must-revalidate",
  dataSchema: progressSchema,
  rateLimits: [{ policy: POLICIES.onboardingRead, source: "actor" }],
  async handler({ auth, params }) {
    if (!auth) throw new ProblemError("AUTH_REQUIRED");
    const goalId = goalIdOf(params);
    return withActorContext(auth.profileId, async (sql) => {
      const goal = await loadGoal(sql, { goalId, ownerProfileId: auth.profileId });
      if (!goal) throw new ProblemError("NOT_FOUND", { detail: "No such goal." });

      const rows = await latestProgress(sql, goalId);
      if (rows.length === 0) {
        return {
          data: {
            state: "unavailable" as const,
            metrics: [],
            adherence: {
              ratio: null,
              note: "Nothing has been measured on this goal yet.",
            },
            realGameEvidence: 0,
            practiceEvidence: 0,
          },
        };
      }

      const adherenceValues = rows
        .map((row) => (row.adherence_ratio === null ? null : Number(row.adherence_ratio)))
        .filter((value): value is number => value !== null);
      const adherence =
        adherenceValues.length === 0
          ? null
          : adherenceValues.reduce((sum, value) => sum + value, 0) / adherenceValues.length;

      return {
        data: {
          state: "published" as const,
          metrics: rows.map((row) => ({
            metricKey: row.metric_key,
            currentValue: row.current_value === null ? null : Number(row.current_value),
            readiness: row.readiness === null ? null : Number(row.readiness),
            claimState: row.claim_state,
            targetAchieved: row.target_achieved,
            unavailableReason: row.unavailable_reason,
          })),
          adherence: {
            ratio: adherence,
            note:
              adherence === null
                ? "You have not committed to anything on this goal, so there is nothing to measure adherence against."
                : "This is how much of what you committed to you did. It is not a measure of improvement.",
          },
          realGameEvidence: rows.reduce((sum, row) => sum + row.real_game_evidence_count, 0),
          practiceEvidence: rows.reduce((sum, row) => sum + row.practice_evidence_count, 0),
        },
      };
    });
  },
};

// ---------------------------------------------------------------------------
// POST /v1/goals/{goalId}/close
// ---------------------------------------------------------------------------

const closeBody = z.object({
  outcome: z.enum(["completed", "abandoned", "replaced"]),
  note: z.string().max(500).nullable().default(null),
});

const closeSchema = z.object({
  closed: z.boolean(),
  demonstrated: z.boolean(),
  note: z.string().nullable(),
  goal: goalSchema,
});

const closeRoute: RouteDefinition<never, z.infer<typeof closeBody>, z.infer<typeof closeSchema>> = {
  method: "POST",
  path: "/v1/goals/:goalId/close",
  operationId: "closeGoal",
  summary: "Close a goal, and say whether the target was actually demonstrated",
  description:
    "The goal closes as the user asked — it is theirs. What the product will not do is record `achieved` when the evidence does not support it: closing something as complete without demonstrated real-game evidence closes it with a note saying exactly that.",
  kind: "command",
  auth: "required",
  idempotency: "key",
  envelope: "resource",
  successStatus: 200,
  bodySchema: closeBody,
  dataSchema: closeSchema,
  rateLimits: [{ policy: POLICIES.onboardingCommand, source: "actor" }],
  async handler({ auth, body, params }) {
    if (!auth) throw new ProblemError("AUTH_REQUIRED");
    const goalId = goalIdOf(params);

    return withActorContext(auth.profileId, async (sql) => {
      const goal = await loadGoal(sql, { goalId, ownerProfileId: auth.profileId });
      if (!goal) throw new ProblemError("NOT_FOUND", { detail: "No such goal." });

      const rows = await latestProgress(sql, goalId);
      const readings = rows.map(
        (row): ProgressReading => ({
          metricKey: row.metric_key,
          currentValue: row.current_value === null ? null : Number(row.current_value),
          intervalLow: null,
          intervalHigh: null,
          progressFromBaseline: null,
          readiness: row.readiness === null ? null : Number(row.readiness),
          adherenceRatio: row.adherence_ratio === null ? null : Number(row.adherence_ratio),
          requirementsMet: 0,
          requirementsTotal: 0,
          realGameEvidenceCount: row.real_game_evidence_count,
          practiceEvidenceCount: row.practice_evidence_count,
          coverageState: "limited",
          claimState: row.claim_state as ProgressReading["claimState"],
          targetAchieved: row.target_achieved,
          unavailableReason: row.unavailable_reason,
        }),
      );

      const check = checkClose({ outcome: body.outcome, readings });
      const closed = await closeGoal(sql, {
        goalId,
        ownerProfileId: auth.profileId,
        outcome: body.outcome,
        demonstrated: check.demonstrated,
        note: check.note ?? body.note,
      });
      const after = await loadGoal(sql, { goalId, ownerProfileId: auth.profileId });

      return {
        data: {
          closed,
          demonstrated: check.demonstrated,
          note: check.note ?? body.note,
          goal: viewOf(after ?? goal),
        },
      };
    });
  },
};

export const GOAL_ROUTES = [
  templatesRoute,
  listRoute,
  createRoute,
  getRoute,
  planRoute,
  commitmentRoute,
  progressRoute,
  closeRoute,
];

/** Exported so a gate can assert the policy without re-deriving it. */
export const GOAL_POLICY_VERSION = GOAL_POLICY.version;
