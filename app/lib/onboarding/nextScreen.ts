/**
 * Where an onboarding state should put the person, and whether to keep polling.
 *
 * One pure function, so the routing decision is testable without a browser and
 * cannot drift between the three screens that make it. Every screen asks this;
 * none of them reads `nextAction.action` directly.
 *
 * The trap it exists to close: **a dead sync never fails the run**. When the
 * sync workflow fails, the run's own status stays `active` and `nextAction`
 * stays `wait`, so a screen that trusted the run alone would spin for ever. The
 * workflow's state is the only evidence, which is why it is an argument here.
 */

import type { OnboardingState, Workflow } from "../v1/types";
import type { FailureReason } from "./copy";

export type Destination =
  /** No chess account is linked. */
  | { kind: "welcome" }
  /** Work is running. Show it, and keep polling. */
  | { kind: "wait"; reason: string }
  /** The report exists and has not been read. */
  | { kind: "report"; reportId: string | null }
  /** Nothing more can happen without a person, and no screen exists for it. */
  | { kind: "stuck"; reason: FailureReason | null; workflowFailed: boolean }
  /** The diagnostic is offered but not built. */
  | { kind: "diagnostic"; sessionId: string | null; reportId: string | null }
  /** Onboarding is over. */
  | { kind: "done" };

export interface JourneyInput {
  state: OnboardingState;
  /** The sync workflow, when one has been fetched. */
  workflow?: Pick<Workflow, "state"> | null;
}

const LIVE_WORKFLOW_STATES = new Set(["queued", "running", "cancelling"]);

/**
 * The stage at which the examination has already produced a report.
 *
 * `deriveStage` reaches `report_ready` only once `baselineReportId` is set, so
 * this is evidence rather than a guess. It has to be checked *before*
 * `nextAction`, because the two can disagree: a run whose report was written
 * days ago can still come back with `action: "wait"`, and trusting the action
 * alone is how somebody with a finished report gets shown an importing bar for
 * work that is long over.
 */
const REPORT_WRITTEN = "report_ready";

/** A workflow that has stopped for a bad reason. */
export function workflowFailed(workflow: JourneyInput["workflow"]): boolean {
  if (!workflow) return false;
  return workflow.state === "failed" || workflow.state === "cancelled";
}

export function nextScreen(input: JourneyInput): Destination {
  const { state } = input;
  const action = state.nextAction.action;

  // A failed run is never a wait, whatever the action says.
  if (state.status === "failed" || state.status === "abandoned") {
    return {
      kind: "stuck",
      reason: (state.failureReason as FailureReason | null) ?? null,
      workflowFailed: false,
    };
  }
  if (state.status === "activated") return { kind: "done" };

  // The report exists. Nothing below this line can be worth showing instead —
  // not a wait, and not a dead sync either, since the thing the sync was for
  // has already been produced.
  if (state.stage === REPORT_WRITTEN && state.baselineReportId !== null) {
    return { kind: "report", reportId: state.baselineReportId };
  }

  // The sync died. The run does not know, and never will.
  if (workflowFailed(input.workflow)) {
    return { kind: "stuck", reason: null, workflowFailed: true };
  }

  switch (action) {
    case "link_account":
      return { kind: "welcome" };
    case "wait":
      return { kind: "wait", reason: state.nextAction.reason ?? "Working" };
    case "start_diagnostic":
    case "skip_diagnostic":
      // Declared in the union; `skip_diagnostic` is never returned by any
      // branch. Handled identically so the switch stays exhaustive.
      return {
        kind: "diagnostic",
        sessionId: state.diagnosticSessionId ?? null,
        reportId: state.baselineReportId,
      };
    case "view_report":
      return { kind: "report", reportId: state.nextAction.reportId ?? state.baselineReportId };
    case "select_goal":
    case "accept_commitment":
    case "complete_onboarding":
      // The report has been read. Goal setting is not built, so this is a
      // stopping point rather than a step — and saying so is better than a
      // button that cannot do anything.
      return { kind: "done" };
    case "none":
      return { kind: "done" };
    default:
      // An action this build has never seen. Treat it as a stopping point
      // rather than guessing, and never as success.
      return { kind: "stuck", reason: null, workflowFailed: false };
  }
}

/**
 * Whether to ask again.
 *
 * Both conditions matter: something must still be running *and* the thing
 * running must be alive. Polling a dead workflow is the infinite wait.
 */
export function shouldPoll(input: JourneyInput): boolean {
  const destination = nextScreen(input);
  if (destination.kind !== "wait") return false;
  if (workflowFailed(input.workflow)) return false;
  // No workflow fetched yet, or one that is still going.
  if (!input.workflow) return true;
  return LIVE_WORKFLOW_STATES.has(input.workflow.state);
}
