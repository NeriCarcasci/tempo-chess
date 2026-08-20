import {
  TRANSITIONS,
  type FailureReason,
  type RunStatus,
  type Stage,
} from "./contract.js";

/**
 * The onboarding state machine.
 *
 * Pure, so the whole journey — including the awkward parts, like a user who
 * abandons during a sync and comes back a week later — is testable without a
 * database, a provider or a clock.
 *
 * The rule that shapes it: nothing is created implicitly. Activation requires a
 * report the user actually saw, a goal they actually chose and a commitment
 * they actually accepted, and if any is missing the machine says which one
 * rather than manufacturing it.
 */

export interface RunState {
  stage: Stage;
  status: RunStatus;
  diagnosticChoice: "adaptive" | "skip";
  hasLinkedAccount: boolean;
  syncComplete: boolean;
  analysisComplete: boolean;
  diagnosticComplete: boolean;
  /**
   * The open diagnostic session, when there is one.
   *
   * A run waits on the diagnostic only if a session actually exists. Waiting on
   * one that was never created is how `adaptive` — the default — used to hang a
   * journey permanently: nothing in the product creates a session yet, so every
   * run that reached this point sat on `start_diagnostic` for ever, report
   * built and unread. When the selector lands, this branch starts working again
   * with no further change.
   */
  diagnosticSessionId: string | null;
  baselineReportId: string | null;
  reportViewedAt: Date | null;
  goalSelectedAt: Date | null;
  commitmentAcceptedAt: Date | null;
}

/** Something the user or the system may do next. */
export type NextAction =
  | { action: "link_account"; reason: "no account is linked yet" }
  | { action: "wait"; reason: string }
  | { action: "start_diagnostic"; reason: "the diagnostic can reduce uncertainty" }
  | { action: "skip_diagnostic"; reason: "the diagnostic is optional" }
  | { action: "view_report"; reportId: string }
  | { action: "select_goal"; reason: "activation needs a goal" }
  | { action: "accept_commitment"; reason: "activation needs an accepted commitment" }
  | { action: "complete_onboarding"; reason: "everything activation requires is present" }
  | { action: "none"; reason: string };

export function canTransition(from: Stage, to: Stage): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * The stage a run should be in, given what has actually happened.
 *
 * Derived rather than stored-and-trusted: a worker that crashed between
 * finishing analysis and writing the stage would otherwise leave a run stuck in
 * `analysing` forever with all its work already done.
 */
export function deriveStage(state: RunState): Stage {
  if (state.status === "activated") return "activated";
  if (!state.hasLinkedAccount) return "linking";
  if (!state.syncComplete) return "syncing";
  if (!state.analysisComplete) return "analysing";
  if (
    state.diagnosticChoice === "adaptive" &&
    typeof state.diagnosticSessionId === "string" &&
    !state.diagnosticComplete
  ) {
    return "diagnostic";
  }
  // The report is built after the diagnostic, so a run with the diagnostic done
  // and no report yet is still doing analysis work rather than waiting on a
  // person.
  if (state.baselineReportId === null) return "analysing";
  if (state.reportViewedAt === null) return "report_ready";
  return "goal_setting";
}

/**
 * What may happen next, and why.
 *
 * The reason is part of the contract, not decoration: an onboarding UI that can
 * only say "please wait" for six different situations is the failure mode
 * platform spec 14.5 is written against.
 */
export function nextAction(state: RunState): NextAction {
  if (state.status === "activated") {
    return { action: "none", reason: "onboarding is complete" };
  }
  if (state.status === "failed") {
    return { action: "none", reason: "this journey failed and needs a new run" };
  }
  if (state.status === "abandoned") {
    return { action: "none", reason: "this journey was abandoned" };
  }
  if (!state.hasLinkedAccount) {
    return { action: "link_account", reason: "no account is linked yet" };
  }
  if (!state.syncComplete) {
    return { action: "wait", reason: "importing your games" };
  }
  if (!state.analysisComplete) {
    return { action: "wait", reason: "analysing your games" };
  }
  if (
    state.diagnosticChoice === "adaptive" &&
    typeof state.diagnosticSessionId === "string" &&
    !state.diagnosticComplete
  ) {
    return { action: "start_diagnostic", reason: "the diagnostic can reduce uncertainty" };
  }
  if (state.baselineReportId === null) {
    return { action: "wait", reason: "building your baseline report" };
  }
  if (state.reportViewedAt === null) {
    return { action: "view_report", reportId: state.baselineReportId };
  }
  if (state.goalSelectedAt === null) {
    return { action: "select_goal", reason: "activation needs a goal" };
  }
  if (state.commitmentAcceptedAt === null) {
    return { action: "accept_commitment", reason: "activation needs an accepted commitment" };
  }
  return {
    action: "complete_onboarding",
    reason: "everything activation requires is present",
  };
}

export interface ActivationRefusal {
  activated: false;
  missing: readonly ("baseline_report" | "report_viewed" | "goal" | "commitment")[];
}

export interface ActivationAllowed {
  activated: true;
}

/**
 * Whether activation may be recorded.
 *
 * Returns every missing precondition rather than the first, because a client
 * that has to make three round trips to discover three missing things will show
 * the user three separate errors.
 *
 * Nothing here creates what is missing. Platform spec 14 is explicit that
 * onboarding completion does not implicitly create a goal or a commitment: a
 * user who never chose a goal does not have one, and inventing a default would
 * make the whole coaching cycle a thing that happened to them.
 */
export function checkActivation(state: RunState): ActivationAllowed | ActivationRefusal {
  const missing: ActivationRefusal["missing"][number][] = [];
  if (state.baselineReportId === null) missing.push("baseline_report");
  if (state.reportViewedAt === null) missing.push("report_viewed");
  if (state.goalSelectedAt === null) missing.push("goal");
  if (state.commitmentAcceptedAt === null) missing.push("commitment");
  return missing.length === 0 ? { activated: true } : { activated: false, missing };
}

/** Whether a failure is worth retrying, or needs the user to do something. */
export function isRetryable(reason: FailureReason): boolean {
  return reason === "provider_unavailable" || reason === "analysis_failed";
}
