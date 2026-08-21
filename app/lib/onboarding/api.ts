/**
 * The onboarding calls, typed and with their rules attached.
 *
 * Thin on purpose — the point is not to hide `v1()` but to put the three things
 * a screen would otherwise have to remember in one place: which calls need an
 * idempotency key per intent, that reading the report is a write, and that a
 * 2xx from `startRun` does not mean the journey started.
 */

import { v1, v1Collect, v1Data, newIdempotencyKey } from "../v1/client";
import type { V1Result } from "../v1/client";
import type {
  BaselineReport,
  Dashboard,
  LinkedAccount,
  Me,
  OnboardingCoverage,
  OnboardingState,
  Workflow,
} from "../v1/types";

export function getMe(): Promise<Me> {
  return v1Data<Me>("/v1/me");
}

export function getOnboarding(): Promise<OnboardingState> {
  return v1Data<OnboardingState>("/v1/onboarding");
}

export function getWorkflow(workflowId: string): Promise<Workflow> {
  return v1Data<Workflow>(`/v1/workflows/${workflowId}`);
}

/**
 * Every workflow the caller owns.
 *
 * Walked to the end rather than read one page at a time, because the caller
 * wants the *sums*: an examination fans out into one `game_analysis` workflow
 * per game, and a page of twenty-five of two hundred is not a percentage of
 * anything. There is no endpoint that aggregates them and no endpoint that
 * exposes work items — `server/src/v1/routes/workflows.ts` refuses both on
 * purpose — so this is the finest honest picture the API offers.
 *
 * Six pages of a hundred covers a two-hundred-game baseline several times over.
 * The bound is what stops a runaway account turning a progress bar into a
 * hundred requests.
 */
export function listWorkflows(): Promise<Workflow[]> {
  return v1Collect<Workflow>("/v1/workflows", { query: { limit: 100 }, pages: 6 });
}

export function getCoverage(runId: string): Promise<OnboardingCoverage> {
  return v1Data<OnboardingCoverage>(`/v1/onboarding/runs/${runId}/coverage`);
}

/**
 * Every measurement behind the published profile.
 *
 * Unlike `getReport`, this is a plain read and safe to call from anywhere: it
 * does not record a view and does not advance the run. It exists because the
 * baseline report ships its items as *identifiers* -- a finding id, an estimate
 * id, a trajectory snapshot id -- and for a long time there was nothing to
 * dereference them against, so a profile screen could render the shape of an
 * answer and none of its numbers.
 *
 * 404 means no published profile yet, which is an empty account rather than a
 * missing resource. Callers should render that as "not measured yet".
 */
export function getDashboard(): Promise<V1Result<Dashboard>> {
  return v1<Dashboard>("/v1/dashboard");
}

/**
 * The baseline report.
 *
 * **This is a write.** Fetching it is what records `report_viewed_at` and moves
 * the run from `report_ready` to `goal_setting`; there is deliberately no
 * separate "mark as viewed" endpoint, and the write happens before the ETag
 * comparison, so even a 304 has marked it. Never prefetch it, never call it
 * from a hub, and never call it to decide whether to show a link to itself.
 *
 * The envelope comes back whole because `meta.redactions` names the withheld
 * sections, and dropping it would turn "you may not see this" into "this does
 * not exist".
 */
export function getReport(reportId: string): Promise<V1Result<BaselineReport>> {
  return v1<BaselineReport>(`/v1/baseline-reports/${reportId}`);
}

/**
 * Claim a provider account.
 *
 * `provider`/`handle`, not `platform`/`username` — the field names differ from
 * the legacy route even though the provider slugs are the same two strings.
 * Returns 201 for a new link and 200 when the caller already held it; both are
 * success, and the caller should treat them the same.
 */
export function linkAccount(input: {
  provider: "lichess" | "chesscom";
  handle: string;
  idempotencyKey: string;
}): Promise<LinkedAccount> {
  return v1Data<LinkedAccount>("/v1/me/accounts", {
    method: "POST",
    json: { provider: input.provider, handle: input.handle },
    idempotencyKey: input.idempotencyKey,
  });
}

/**
 * Start the examination, or resume the one already running.
 *
 * No `subjectId`: identity comes from the token and the kernel refuses a body
 * that names one.
 *
 * `diagnostic` is sent explicitly rather than defaulted. The default is
 * `adaptive`, and nothing in the product creates a diagnostic session yet — a
 * run that asks for one waits only if a session exists, so `adaptive` is now
 * safe, but asking for what cannot be delivered is still a promise this screen
 * should not make.
 *
 * **A 2xx does not mean the journey started.** With no active linked account
 * the planner marks the run failed inside the same request, and the 201 body
 * comes back `status: "failed"`. Read the body.
 */
export function startRun(input: {
  idempotencyKey: string;
  diagnostic?: "adaptive" | "skip";
}): Promise<OnboardingState> {
  return v1Data<OnboardingState>("/v1/onboarding/runs", {
    method: "POST",
    json: { diagnostic: input.diagnostic ?? "skip" },
    idempotencyKey: input.idempotencyKey,
  });
}

/**
 * Link, then start, as one intent.
 *
 * Two keys because they are two commands, but one call site because a link with
 * no run behind it leaves the person on a screen that says "connect an account"
 * when they just did.
 */
export async function linkAndStart(input: {
  provider: "lichess" | "chesscom";
  handle: string;
}): Promise<OnboardingState> {
  await linkAccount({ ...input, idempotencyKey: newIdempotencyKey() });
  return startRun({ idempotencyKey: newIdempotencyKey() });
}
