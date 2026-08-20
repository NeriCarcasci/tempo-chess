import { describe, expect, test } from "vitest";
import { nextScreen, reportAlreadyOpened, shouldPoll, workflowFailed } from "./nextScreen";
import type { OnboardingState } from "../v1/types";

/**
 * The routing decision, which is where a journey silently hangs.
 *
 * The single most valuable test in this file is "a dead sync stops the wait":
 * when the sync workflow fails, the run's own status stays `active` and its
 * next action stays `wait` for ever, so a screen that trusted the run alone
 * would spin until the person gave up.
 */

const state = (over: Partial<OnboardingState> = {}): OnboardingState =>
  ({
    runId: "run-1",
    stage: "syncing",
    status: "active",
    diagnosticChoice: "skip",
    syncWorkflowId: "wf-1",
    baselineReportId: null,
    diagnosticSessionId: null,
    failureReason: null,
    nextAction: { action: "wait", reason: "importing your games" },
    ...over,
  }) as OnboardingState;

const ACTIONS = [
  "link_account",
  "wait",
  "start_diagnostic",
  "skip_diagnostic",
  "view_report",
  "select_goal",
  "accept_commitment",
  "complete_onboarding",
  "none",
] as const;

describe("nextScreen", () => {
  test("every declared action maps to a destination", () => {
    for (const action of ACTIONS) {
      const destination = nextScreen({
        state: state({ nextAction: { action } as OnboardingState["nextAction"] }),
      });
      expect(destination, `${action} produced nothing`).toBeTruthy();
      expect(typeof destination.kind).toBe("string");
    }
  });

  test("an action this build has never seen is a stop, never a success", () => {
    const destination = nextScreen({
      state: state({ nextAction: { action: "invent_a_goal" } as never }),
    });
    expect(destination.kind).toBe("stuck");
  });

  test("a failed run is never a wait", () => {
    const destination = nextScreen({
      state: state({
        status: "failed",
        failureReason: "no_linked_account",
        nextAction: { action: "none", reason: "this journey failed and needs a new run" },
      }),
    });
    expect(destination.kind).toBe("stuck");
    expect(destination.kind === "stuck" && destination.reason).toBe("no_linked_account");
  });

  test("an abandoned run is a stop, and keeps its reason", () => {
    const destination = nextScreen({
      state: state({
        status: "abandoned",
        failureReason: "abandoned_by_user",
        nextAction: { action: "none", reason: "this journey was abandoned" },
      }),
    });
    expect(destination).toEqual({
      kind: "stuck",
      reason: "abandoned_by_user",
      workflowFailed: false,
    });
  });

  test("an activated run is done", () => {
    expect(nextScreen({ state: state({ status: "activated" }) }).kind).toBe("done");
  });

  test("a written report is never a wait, whatever the action says", () => {
    // The one that reached a real person: a run at `report_ready`, with a
    // report published days earlier, still coming back with `action: "wait"`.
    // Trusting the action alone showed them an importing bar for work that was
    // long over.
    const destination = nextScreen({
      state: state({
        stage: "report_ready",
        baselineReportId: "report-1",
        nextAction: { action: "wait", reason: "importing your games" },
      }),
    });
    expect(destination).toEqual({ kind: "report", reportId: "report-1" });
  });

  test("a written report also beats a dead sync", () => {
    // The sync the report was built from can have died since. What it was for
    // exists, so there is nothing to send anybody back to fix.
    const input = {
      state: state({ stage: "report_ready", baselineReportId: "report-1" }),
      workflow: { state: "failed" as const },
    };
    expect(nextScreen(input).kind).toBe("report");
    expect(shouldPoll(input)).toBe(false);
  });

  test("the stage alone is not enough: a report needs an id to send anybody to", () => {
    const destination = nextScreen({
      state: state({ stage: "report_ready", baselineReportId: null }),
    });
    expect(destination.kind).toBe("wait");
  });

  test("the run's own reason beats a dead workflow", () => {
    // Both stopped, but only one of them knows why. Reporting "the sync died"
    // over "none of your games could be read" would send somebody to retry a
    // sync that will produce the same nothing.
    const destination = nextScreen({
      state: state({
        status: "failed",
        failureReason: "no_eligible_games",
        nextAction: { action: "none" },
      }),
      workflow: { state: "failed" },
    });
    expect(destination).toEqual({
      kind: "stuck",
      reason: "no_eligible_games",
      workflowFailed: false,
    });
  });

  test("a dead sync stops the wait", () => {
    // The run still says `wait`, because nothing tells it otherwise.
    const input = { state: state(), workflow: { state: "failed" as const } };
    expect(input.state.nextAction.action).toBe("wait");
    expect(workflowFailed(input.workflow)).toBe(true);
    expect(nextScreen(input).kind).toBe("stuck");
    expect(shouldPoll(input)).toBe(false);
  });

  test("a cancelled sync stops the wait too", () => {
    const input = { state: state(), workflow: { state: "cancelled" as const } };
    expect(nextScreen(input).kind).toBe("stuck");
    expect(shouldPoll(input)).toBe(false);
  });

  test("a live sync keeps the wait going", () => {
    for (const live of ["queued", "running", "cancelling"]) {
      const input = { state: state(), workflow: { state: live } as never };
      expect(nextScreen(input).kind, live).toBe("wait");
      expect(shouldPoll(input), live).toBe(true);
    }
  });

  test("a succeeded workflow with more to do still waits, but stops polling it", () => {
    // The sync finished; the analysis has not. The run says wait, and the
    // workflow is done, so there is nothing left to poll on this one.
    const input = {
      state: state({ nextAction: { action: "wait", reason: "analysing your games" } }),
      workflow: { state: "succeeded" as const },
    };
    expect(nextScreen(input).kind).toBe("wait");
    expect(shouldPoll(input)).toBe(false);
  });

  test("polling never continues once the report is ready", () => {
    const input = {
      state: state({
        stage: "report_ready",
        baselineReportId: "report-1",
        nextAction: { action: "view_report", reportId: "report-1" },
      }),
    };
    expect(nextScreen(input).kind).toBe("report");
    expect(shouldPoll(input)).toBe(false);
  });

  test("the diagnostic destination carries whatever ids exist", () => {
    const destination = nextScreen({
      state: state({
        diagnosticChoice: "adaptive",
        diagnosticSessionId: "session-1",
        baselineReportId: "report-1",
        nextAction: { action: "start_diagnostic", reason: "the diagnostic can reduce uncertainty" },
      }),
    });
    expect(destination).toEqual({
      kind: "diagnostic",
      sessionId: "session-1",
      reportId: "report-1",
    });
  });
});

describe("reportAlreadyOpened", () => {
  test("a run sitting on report_ready has not opened it", () => {
    // The one that matters. Fetching the report is what moves the run off this
    // stage, so a screen that read it here would have opened it on the
    // person's behalf and then reported that they had.
    expect(reportAlreadyOpened(state({ stage: "report_ready" }))).toBe(false);
  });

  test("every stage before the report is not opened either", () => {
    for (const stage of ["linking", "syncing", "analysing", "diagnostic"] as const) {
      expect(reportAlreadyOpened(state({ stage })), stage).toBe(false);
    }
  });

  test("the stages only reachable by opening it say so", () => {
    expect(reportAlreadyOpened(state({ stage: "goal_setting" }))).toBe(true);
    expect(reportAlreadyOpened(state({ stage: "activated" }))).toBe(true);
  });

  test("an activated run counts however its stage reads", () => {
    // Activation requires `report_viewed_at`, so the status alone is evidence.
    expect(reportAlreadyOpened(state({ stage: "report_ready", status: "activated" }))).toBe(true);
  });
});
