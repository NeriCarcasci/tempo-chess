/**
 * The onboarding surface, per plans/v1-api-contract.md §9.
 *
 * These are the first endpoints a new person's browser ever calls, and they are
 * shaped by two rules from platform spec 14.
 *
 * Nothing is created implicitly. `POST /onboarding/complete` requires a report
 * the user opened, a goal they chose and a commitment they accepted; when one
 * is missing it says which, and it does not manufacture the others.
 *
 * Nothing waits without saying what for. Every state carries a next action with
 * a reason, because an onboarding screen that can only say "please wait" for six
 * different situations is the failure mode the spec is written against.
 */

import { z } from "zod";

import { client } from "../../db/client.js";
import { withActorContext } from "../auth/context.js";
import { ProblemError } from "../problem.js";
import { POLICIES } from "../rate-limit.js";
import type { RouteDefinition } from "../registry.js";
import { recordAuditEvent } from "../audit.js";
import { DIAGNOSTIC_POLICY, PLAN_ENTITLEMENTS } from "../../onboarding/contract.js";
import { checkActivation, nextAction } from "../../onboarding/state.js";
import { describePurpose, scoreAttempt, sessionProgress } from "../../onboarding/diagnostic.js";
import { redactForPlan, type ReportItem } from "../../onboarding/baseline.js";
import {
  activate,
  currentRun,
  loadRun,
  markReportViewed,
  readCoverage,
  startRun,
} from "../../onboarding/store.js";

const UUID = z.uuid();

function idOf(params: Record<string, string>, key: string, noun: string): string {
  const parsed = UUID.safeParse(params[key]);
  if (!parsed.success) throw new ProblemError("NOT_FOUND", { detail: `No such ${noun}.` });
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

const nextActionSchema = z.object({
  action: z.string(),
  reason: z.string().optional(),
  reportId: z.string().optional(),
});

const onboardingStateSchema = z.object({
  runId: z.string().nullable(),
  stage: z.string(),
  status: z.string(),
  diagnosticChoice: z.string().nullable(),
  syncWorkflowId: z.string().nullable(),
  baselineReportId: z.string().nullable(),
  failureReason: z.string().nullable(),
  nextAction: nextActionSchema,
});

type OnboardingStateView = z.infer<typeof onboardingStateSchema>;

const NOT_STARTED: OnboardingStateView = {
  runId: null,
  stage: "not_started",
  status: "not_started",
  diagnosticChoice: null,
  syncWorkflowId: null,
  baselineReportId: null,
  failureReason: null,
  nextAction: { action: "link_account", reason: "no account is linked yet" },
};

// ---------------------------------------------------------------------------
// GET /v1/onboarding
// ---------------------------------------------------------------------------

const stateRoute: RouteDefinition<never, never, OnboardingStateView> = {
  method: "GET",
  path: "/v1/onboarding",
  operationId: "getOnboarding",
  summary: "The caller's onboarding state and the one thing to do next",
  description:
    "The stage is derived from what has actually happened rather than read from a column, so a worker that finished its work and crashed before recording it does not leave the user on a spinner. `not_started` is a state, not a 404.",
  kind: "read",
  auth: "required",
  envelope: "resource",
  successStatus: 200,
  // Private and always revalidated: this is one person's journey, and it
  // changes underneath them while a sync runs.
  cacheControl: "private, max-age=0, must-revalidate",
  dataSchema: onboardingStateSchema,
  rateLimits: [{ policy: POLICIES.onboardingRead, source: "actor" }],
  async handler({ auth }) {
    if (!auth) throw new ProblemError("AUTH_REQUIRED");
    return withActorContext(auth.profileId, async (sql) => {
      const run = await currentRun(sql, auth.profileId);
      if (!run) return { data: NOT_STARTED };
      return { data: viewOf(run) };
    });
  },
};

function viewOf(run: NonNullable<Awaited<ReturnType<typeof loadRun>>>): OnboardingStateView {
  return {
    runId: run.row.id,
    stage: run.derivedStage,
    status: run.row.status,
    diagnosticChoice: run.row.diagnostic_choice,
    syncWorkflowId: run.row.sync_workflow_id,
    baselineReportId: run.baselineReportId,
    failureReason: run.row.failure_reason,
    nextAction: nextAction(run.state),
  };
}

// ---------------------------------------------------------------------------
// POST /v1/onboarding/runs
// ---------------------------------------------------------------------------

const startBody = z.object({
  subjectId: z.uuid(),
  diagnostic: z.enum(["adaptive", "skip"]).default("adaptive"),
});

const startRoute: RouteDefinition<never, z.infer<typeof startBody>, OnboardingStateView> = {
  method: "POST",
  path: "/v1/onboarding/runs",
  operationId: "startOnboarding",
  summary: "Start the examination, or resume the one already running",
  description:
    "A repeated request resumes rather than starting a second journey: at most one run per subject is active, enforced by a partial unique index rather than by the handler checking first.",
  kind: "command",
  auth: "required",
  idempotency: "key",
  envelope: "resource",
  successStatus: 201,
  bodySchema: startBody,
  dataSchema: onboardingStateSchema,
  rateLimits: [{ policy: POLICIES.onboardingCommand, source: "actor" }],
  async handler({ auth, body, traceId }) {
    if (!auth) throw new ProblemError("AUTH_REQUIRED");
    // Subject ownership is the caller's own list, never the request's claim.
    if (!auth.subjects.includes(body.subjectId)) {
      throw new ProblemError("NOT_FOUND", { detail: "No such subject." });
    }
    const started = await startRun(client, {
      userId: auth.profileId,
      subjectId: body.subjectId,
      diagnosticChoice: body.diagnostic,
    });
    const run = await withActorContext(auth.profileId, (sql) =>
      loadRun(sql, { runId: started.runId, ownerProfileId: auth.profileId }),
    );
    if (!run) throw new ProblemError("NOT_FOUND", { detail: "No such run." });
    return { status: started.created ? 201 : 200, data: viewOf(run) };
  },
};

// ---------------------------------------------------------------------------
// GET /v1/onboarding/runs/{runId}
// ---------------------------------------------------------------------------

const runRoute: RouteDefinition<never, never, OnboardingStateView> = {
  method: "GET",
  path: "/v1/onboarding/runs/:runId",
  operationId: "getOnboardingRun",
  summary: "One onboarding run",
  kind: "read",
  auth: "required",
  envelope: "resource",
  successStatus: 200,
  // Private and always revalidated: this is one person's journey, and it
  // changes underneath them while a sync runs.
  cacheControl: "private, max-age=0, must-revalidate",
  dataSchema: onboardingStateSchema,
  rateLimits: [{ policy: POLICIES.onboardingRead, source: "actor" }],
  async handler({ auth, params }) {
    if (!auth) throw new ProblemError("AUTH_REQUIRED");
    const runId = idOf(params, "runId", "run");
    return withActorContext(auth.profileId, async (sql) => {
      const run = await loadRun(sql, { runId, ownerProfileId: auth.profileId });
      if (!run) throw new ProblemError("NOT_FOUND", { detail: "No such run." });
      return { data: viewOf(run) };
    });
  },
};

// ---------------------------------------------------------------------------
// GET /v1/onboarding/runs/{runId}/coverage
// ---------------------------------------------------------------------------

const coverageSchema = z.object({
  state: z.enum(["published", "unavailable"]),
  overallState: z.string().nullable(),
  totalGames: z.number().int().nullable(),
  eligibleGames: z.number().int().nullable(),
  limitations: z.array(z.string()),
  dimensions: z.array(
    z.object({
      dimensionKey: z.string(),
      observationCount: z.number().int(),
      state: z.string(),
      limitationReason: z.string().nullable(),
    }),
  ),
});

const coverageRoute: RouteDefinition<never, never, z.infer<typeof coverageSchema>> = {
  method: "GET",
  path: "/v1/onboarding/runs/:runId/coverage",
  operationId: "getOnboardingCoverage",
  summary: "What Forma has, and what it is missing",
  description:
    "Limitations are named rather than scored. A user with thin evidence sees the exact missing evidence, which is what platform spec 14.5 requires instead of a failure screen.",
  kind: "read",
  auth: "required",
  envelope: "resource",
  successStatus: 200,
  // Private and always revalidated: this is one person's journey, and it
  // changes underneath them while a sync runs.
  cacheControl: "private, max-age=0, must-revalidate",
  dataSchema: coverageSchema,
  rateLimits: [{ policy: POLICIES.onboardingRead, source: "actor" }],
  async handler({ auth, params }) {
    if (!auth) throw new ProblemError("AUTH_REQUIRED");
    const runId = idOf(params, "runId", "run");
    return withActorContext(auth.profileId, async (sql) => {
      const run = await loadRun(sql, { runId, ownerProfileId: auth.profileId });
      if (!run) throw new ProblemError("NOT_FOUND", { detail: "No such run." });

      const [row] = await sql<{ id: string }[]>`
        select c.id from coaching.data_coverage_snapshots c
        where c.subject_data_snapshot_id = ${run.row.subject_data_snapshot_id}
        order by c.created_at desc limit 1
      `;
      if (!row) {
        // Named rather than 404: the coverage has not been computed yet, which
        // is a different fact from "this run has no coverage".
        return {
          data: {
            state: "unavailable" as const,
            overallState: null,
            totalGames: null,
            eligibleGames: null,
            limitations: [],
            dimensions: [],
          },
        };
      }
      const coverage = await readCoverage(sql, row.id);
      if (!coverage) throw new ProblemError("NOT_FOUND", { detail: "No such run." });
      return { data: { state: "published" as const, ...coverage } };
    });
  },
};

// ---------------------------------------------------------------------------
// GET /v1/diagnostic-sessions/{sessionId}
// ---------------------------------------------------------------------------

const sessionSchema = z.object({
  sessionId: z.string(),
  status: z.string(),
  preExplanationGuaranteed: z.boolean(),
  progress: z.object({
    total: z.number().int(),
    answered: z.number().int(),
    complete: z.boolean(),
    nextOrdinal: z.number().int().nullable(),
  }),
  currentItem: z
    .object({
      itemId: z.string(),
      ordinal: z.number().int(),
      fen: z.string(),
      purpose: z.string(),
      explanation: z.string(),
    })
    .nullable(),
});

const sessionRoute: RouteDefinition<never, never, z.infer<typeof sessionSchema>> = {
  method: "GET",
  path: "/v1/diagnostic-sessions/:sessionId",
  operationId: "getDiagnosticSession",
  summary: "A diagnostic session and its current item",
  description:
    "The current item carries the explanation of what it is testing and never the expected move. Platform spec 14.7's pre-explanation guarantee costs a little signal and buys the difference between an examination and a trap.",
  kind: "read",
  auth: "required",
  envelope: "resource",
  successStatus: 200,
  // Private and always revalidated: this is one person's journey, and it
  // changes underneath them while a sync runs.
  cacheControl: "private, max-age=0, must-revalidate",
  dataSchema: sessionSchema,
  rateLimits: [{ policy: POLICIES.onboardingRead, source: "actor" }],
  async handler({ auth, params }) {
    if (!auth) throw new ProblemError("AUTH_REQUIRED");
    const sessionId = idOf(params, "sessionId", "session");
    return withActorContext(auth.profileId, async (sql) => {
      const [session] = await sql<
        { id: string; status: string; pre_explanation_guaranteed: boolean }[]
      >`
        select s.id, s.status, s.pre_explanation_guaranteed
        from coaching.diagnostic_sessions s
        join coaching.onboarding_runs r on r.id = s.onboarding_run_id
        where s.id = ${sessionId} and r.user_id = ${auth.profileId}
      `;
      if (!session) throw new ProblemError("NOT_FOUND", { detail: "No such session." });

      const items = await sql<
        {
          id: string;
          ordinal: number;
          fen: string;
          purpose: string;
          investigates_dimension_key: string;
          answered: boolean;
        }[]
      >`
        select i.id, i.ordinal, i.fen, i.purpose, i.investigates_dimension_key,
               exists (select 1 from coaching.diagnostic_attempts a where a.session_item_id = i.id)
                 as answered
        from coaching.diagnostic_session_items i
        where i.session_id = ${sessionId}
        order by i.ordinal
      `;

      const progress = sessionProgress(
        items.map((item) => ({ ordinal: item.ordinal })),
        items.filter((item) => item.answered).map((item) => item.ordinal),
      );
      const current = items.find((item) => item.ordinal === progress.nextOrdinal) ?? null;

      return {
        data: {
          sessionId: session.id,
          status: session.status,
          preExplanationGuaranteed: session.pre_explanation_guaranteed,
          progress,
          currentItem: current
            ? {
                itemId: current.id,
                ordinal: current.ordinal,
                fen: current.fen,
                purpose: current.purpose,
                explanation: describePurpose(
                  current.purpose as never,
                  current.investigates_dimension_key,
                ),
              }
            : null,
        },
      };
    });
  },
};

// ---------------------------------------------------------------------------
// POST /v1/diagnostic-sessions/{sessionId}/attempts
// ---------------------------------------------------------------------------

const attemptBody = z.object({
  itemId: z.uuid(),
  moveUci: z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/),
  thinkTimeMs: z.number().int().min(0).max(3_600_000).nullable().default(null),
  hintsUsed: z.number().int().min(0).max(3).default(0),
  clientAttemptId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
});

const attemptSchema = z.object({
  attemptId: z.string(),
  correct: z.boolean(),
  score: z.number(),
  withinTimedWindow: z.boolean(),
  expectedUci: z.string(),
  progress: z.object({
    total: z.number().int(),
    answered: z.number().int(),
    complete: z.boolean(),
    nextOrdinal: z.number().int().nullable(),
  }),
});

const attemptRoute: RouteDefinition<never, z.infer<typeof attemptBody>, z.infer<typeof attemptSchema>> = {
  method: "POST",
  path: "/v1/diagnostic-sessions/:sessionId/attempts",
  operationId: "submitDiagnosticAttempt",
  summary: "Answer one diagnostic item",
  description:
    "One attempt per item, forever. A second try is practice, and platform spec 3.4 forbids practice performance from becoming a chess-strength claim; the unique constraint is what makes that true rather than the handler remembering.",
  kind: "command",
  auth: "required",
  idempotency: "key",
  envelope: "resource",
  successStatus: 201,
  bodySchema: attemptBody,
  dataSchema: attemptSchema,
  rateLimits: [{ policy: POLICIES.onboardingCommand, source: "actor" }],
  async handler({ auth, body, params }) {
    if (!auth) throw new ProblemError("AUTH_REQUIRED");
    const sessionId = idOf(params, "sessionId", "session");

    return withActorContext(auth.profileId, async (sql) => {
      const [item] = await sql<
        {
          id: string;
          expected_uci: string;
          acceptable_uci: string[];
          rubric_component_version_id: string;
          already_answered: boolean;
        }[]
      >`
        select i.id, i.expected_uci, i.acceptable_uci, s.rubric_component_version_id,
               exists (select 1 from coaching.diagnostic_attempts a where a.session_item_id = i.id)
                 as already_answered
        from coaching.diagnostic_session_items i
        join coaching.diagnostic_sessions s on s.id = i.session_id
        join coaching.onboarding_runs r on r.id = s.onboarding_run_id
        where i.id = ${body.itemId} and i.session_id = ${sessionId}
          and r.user_id = ${auth.profileId} and s.status = 'open'
      `;
      if (!item) throw new ProblemError("NOT_FOUND", { detail: "No such item." });
      if (item.already_answered) {
        throw new ProblemError("CONFLICT", {
          detail: "This item has already been answered. A second attempt would be practice.",
        });
      }

      const outcome = scoreAttempt(
        { expectedUci: item.expected_uci, acceptableUci: item.acceptable_uci },
        { moveUci: body.moveUci, thinkTimeMs: body.thinkTimeMs, hintsUsed: body.hintsUsed },
      );

      const [attempt] = await sql<{ id: string }[]>`
        insert into coaching.diagnostic_attempts (
          session_item_id, client_attempt_id, move_uci, think_time_ms, hints_used,
          correct, score, rubric_component_version_id
        ) values (
          ${item.id}, ${body.clientAttemptId}, ${body.moveUci}, ${body.thinkTimeMs},
          ${body.hintsUsed}, ${outcome.correct}, ${outcome.score},
          ${item.rubric_component_version_id}
        )
        returning id
      `;

      const items = await sql<{ ordinal: number; answered: boolean }[]>`
        select i.ordinal,
               exists (select 1 from coaching.diagnostic_attempts a where a.session_item_id = i.id)
                 as answered
        from coaching.diagnostic_session_items i
        where i.session_id = ${sessionId}
        order by i.ordinal
      `;
      const progress = sessionProgress(
        items.map((row) => ({ ordinal: row.ordinal })),
        items.filter((row) => row.answered).map((row) => row.ordinal),
      );
      if (progress.complete) {
        await sql`
          update coaching.diagnostic_sessions
          set status = 'completed', completed_at = now()
          where id = ${sessionId} and status = 'open'
        `;
      }

      return {
        status: 201,
        data: {
          attemptId: String(attempt!.id),
          correct: outcome.correct,
          score: outcome.score,
          withinTimedWindow: outcome.withinTimedWindow,
          // Returned only now, after the answer is recorded and can no longer
          // change. Before submission the expected move is never on the wire.
          expectedUci: item.expected_uci,
          progress,
        },
      };
    });
  },
};

// ---------------------------------------------------------------------------
// GET /v1/baseline-reports/{reportId}
// ---------------------------------------------------------------------------

const reportSchema = z.object({
  reportId: z.string(),
  publishedAt: z.string(),
  manifestSha256: z.string(),
  plan: z.string(),
  items: z.array(
    z.object({
      section: z.string(),
      displayOrder: z.number().int(),
      itemKind: z.string(),
      findingId: z.string().nullable(),
      estimateId: z.string().nullable(),
      trajectorySnapshotId: z.string().nullable(),
      coverageDimensionKey: z.string().nullable(),
    }),
  ),
  withheld: z.array(
    z.object({ section: z.string(), count: z.number().int(), entitlementKey: z.string() }),
  ),
});

const reportRoute: RouteDefinition<never, never, z.infer<typeof reportSchema>> = {
  method: "GET",
  path: "/v1/baseline-reports/:reportId",
  operationId: "getBaselineReport",
  summary: "The immutable baseline report",
  description:
    "Redaction removes depth and never removes doubt: coverage items carry the `always` entitlement, every plan includes it, and the database refuses a coverage item that does not. Withheld items are counted and named rather than silently dropped.",
  kind: "read",
  auth: "required",
  envelope: "resource",
  successStatus: 200,
  // Private and always revalidated: this is one person's journey, and it
  // changes underneath them while a sync runs.
  cacheControl: "private, max-age=0, must-revalidate",
  etag: true,
  dataSchema: reportSchema,
  rateLimits: [{ policy: POLICIES.onboardingRead, source: "actor" }],
  async handler({ auth, params, traceId }) {
    if (!auth) throw new ProblemError("AUTH_REQUIRED");
    const reportId = idOf(params, "reportId", "report");

    return withActorContext(auth.profileId, async (sql) => {
      const [report] = await sql<
        {
          id: string;
          published_at: Date;
          manifest_sha256: string;
          onboarding_run_id: string;
        }[]
      >`
        select b.id, b.published_at, b.manifest_sha256, b.onboarding_run_id
        from coaching.baseline_reports b
        join coaching.onboarding_runs r on r.id = b.onboarding_run_id
        where b.id = ${reportId} and r.user_id = ${auth.profileId}
      `;
      if (!report) throw new ProblemError("NOT_FOUND", { detail: "No such report." });

      const rows = await sql<
        {
          section: string;
          display_order: number;
          item_kind: string;
          finding_id: string | null;
          player_skill_estimate_id: string | null;
          trajectory_snapshot_id: string | null;
          coverage_dimension_key: string | null;
          entitlement_key: string;
        }[]
      >`
        select section, display_order, item_kind, finding_id, player_skill_estimate_id,
               trajectory_snapshot_id, coverage_dimension_key, entitlement_key
        from coaching.baseline_report_items
        where baseline_report_id = ${reportId}
        order by section, display_order
      `;

      const items: ReportItem[] = rows.map((row) => ({
        section: row.section as ReportItem["section"],
        displayOrder: row.display_order,
        itemKind: row.item_kind as ReportItem["itemKind"],
        findingId: row.finding_id,
        playerSkillEstimateId: row.player_skill_estimate_id,
        trajectorySnapshotId: row.trajectory_snapshot_id,
        coverageDimensionKey: row.coverage_dimension_key,
        entitlementKey: row.entitlement_key as ReportItem["entitlementKey"],
      }));
      const redacted = redactForPlan(items, auth.plan);

      // Opening the report is a precondition for activation, so reading it is
      // what records that it was read. A separate "mark as viewed" call would
      // be a button the product could quietly press on the user's behalf.
      await markReportViewed(sql, {
        runId: report.onboarding_run_id,
        ownerProfileId: auth.profileId,
      });

      return {
        data: {
          reportId: report.id,
          publishedAt: report.published_at.toISOString(),
          manifestSha256: report.manifest_sha256,
          plan: auth.plan as string,
          items: redacted.items.map((item) => ({
            section: item.section as string,
            displayOrder: item.displayOrder,
            itemKind: item.itemKind as string,
            findingId: item.findingId ?? null,
            estimateId: item.playerSkillEstimateId ?? null,
            trajectorySnapshotId: item.trajectorySnapshotId ?? null,
            coverageDimensionKey: item.coverageDimensionKey ?? null,
          })),
          withheld: redacted.withheld.map((entry) => ({
            section: entry.section as string,
            count: entry.count,
            entitlementKey: entry.entitlementKey as string,
          })),
        },
        // The envelope's own redaction block, beside the counted `withheld`
        // list in the body: one is machine-readable metadata, the other is the
        // sentence a reader is shown. Both say the same thing on purpose.
        redactions: redacted.withheld.map((entry) => ({
          path: `data.items.${entry.section}`,
          reason: "entitlement" as const,
        })),
      };
    });
  },
};

// ---------------------------------------------------------------------------
// POST /v1/onboarding/complete
// ---------------------------------------------------------------------------

const completeBody = z.object({ runId: z.uuid() });

const completeSchema = z.object({
  activated: z.boolean(),
  missing: z.array(z.string()),
  state: onboardingStateSchema,
});

const completeRoute: RouteDefinition<never, z.infer<typeof completeBody>, z.infer<typeof completeSchema>> = {
  method: "POST",
  path: "/v1/onboarding/complete",
  operationId: "completeOnboarding",
  summary: "Activate, if everything activation requires is genuinely present",
  description:
    "Requires a baseline report the user opened, a goal they selected and a commitment they accepted. It creates none of them: a user who never chose a goal does not have one, and inventing a default would make the coaching cycle something that happened to them.",
  kind: "command",
  auth: "required",
  idempotency: "key",
  envelope: "resource",
  successStatus: 200,
  bodySchema: completeBody,
  dataSchema: completeSchema,
  rateLimits: [{ policy: POLICIES.onboardingCommand, source: "actor" }],
  async handler({ auth, body, traceId }) {
    if (!auth) throw new ProblemError("AUTH_REQUIRED");

    return withActorContext(auth.profileId, async (sql) => {
      const run = await loadRun(sql, { runId: body.runId, ownerProfileId: auth.profileId });
      if (!run) throw new ProblemError("NOT_FOUND", { detail: "No such run." });

      const check = checkActivation(run.state);
      if (!check.activated) {
        // 200 with the missing list rather than a 4xx: this is a legitimate
        // state of a legitimate journey, and the client's next screen is
        // "choose a goal", not an error.
        return {
          data: { activated: false, missing: [...check.missing], state: viewOf(run) },
        };
      }

      const activated = await activate(sql, {
        runId: body.runId,
        ownerProfileId: auth.profileId,
      });
      const after = await loadRun(sql, { runId: body.runId, ownerProfileId: auth.profileId });
      if (activated) {
      }
      return {
        data: {
          activated,
          missing: [],
          state: after ? viewOf(after) : viewOf(run),
        },
      };
    });
  },
};

export const ONBOARDING_ROUTES = [
  stateRoute,
  startRoute,
  runRoute,
  coverageRoute,
  sessionRoute,
  attemptRoute,
  reportRoute,
  completeRoute,
];

/** Exported so the gates can assert the session bound without re-deriving it. */
export const DIAGNOSTIC_ITEM_COUNT = DIAGNOSTIC_POLICY.itemCount;
export const PLAN_TIERS = PLAN_ENTITLEMENTS;
