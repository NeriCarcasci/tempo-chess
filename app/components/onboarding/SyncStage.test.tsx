import { render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Workflow } from "../../lib/v1/types";
import type { WorkflowLike } from "../../lib/onboarding/sync";

/**
 * The wait, at the points where it would go back to lying.
 *
 * The screen this replaced sat at 0% for the whole of a run. The one that
 * replaced *that* drew a single honest fill and still could not say what part
 * of the work was running or what had already finished — it said IMPORTING for
 * minutes over a caption naming a step that runs after the import. So the tests
 * that matter are about the four steps: that exactly one of them runs, that a
 * finished one is marked finished, that a fill appears only where the
 * denominator has settled, and that a games route which does not exist yet
 * costs the screen nothing else.
 *
 * Both dependencies are stubbed with plain functions rather than spies: a spy
 * holds on to every promise it hands out, so a rejecting one is reported as an
 * unhandled rejection whatever the code under test does with it.
 */

let workflows: WorkflowLike[] = [];
let recent: unknown[] = [];
let asked = 0;
vi.mock("../../lib/onboarding/api", () => ({ listWorkflows: async () => workflows }));
vi.mock("../../lib/v1/games", () => ({
  fetchRecentGames: async () => {
    asked += 1;
    return recent;
  },
}));

const { SyncStage } = await import("./SyncStage");

const wf = (
  kind: string,
  completed: number,
  total: number,
  stage: string | null = null,
  state = "running",
): WorkflowLike => ({
  kind,
  state,
  progress: { completedWeight: completed, totalWeight: total, stage },
});

/** The examination: one sync, then prepare, report, examine, advance. */
const exam = (completed: number, stage: string | null = null): WorkflowLike =>
  wf("initial_examination", completed, 5, stage);

const game = (completed: number): WorkflowLike => wf("game_analysis", completed, 100);

/** A batch of materialization: one item per game the sweep has found. */
const rebuilt = (completed: number, total: number, state = "running"): WorkflowLike =>
  wf("game_import", completed, total, null, state);

const examination = (stage: string | null): Workflow =>
  ({
    id: "wf-1",
    state: "running",
    kind: "initial_examination",
    progress: { completedWeight: 0, totalWeight: 5, percent: 0, stage, message: null },
  }) as Workflow;

const draw = (node: React.ReactElement) => render(<MemoryRouter>{node}</MemoryRouter>);

/** Every step on screen, as the facts a reader can take from one. */
const steps = (container: HTMLElement) =>
  [...container.querySelectorAll(".sync-step")].map((node) => {
    const fill = node.querySelector(".sync-step-fill") as HTMLElement | null;
    return {
      label: node.querySelector(".sync-step-label")?.textContent ?? null,
      detail: node.querySelector(".sync-step-detail")?.textContent ?? null,
      state: node.classList.contains("is-done")
        ? "done"
        : node.classList.contains("is-running")
          ? "running"
          : "waiting",
      width: fill?.style.width ?? null,
      unknown: fill?.classList.contains("is-unknown") ?? false,
    };
  });

const running = (container: HTMLElement) => steps(container).find((step) => step.state === "running");

beforeEach(() => {
  workflows = [];
  recent = [];
  asked = 0;
});

describe("SyncStage", () => {
  test("nothing weighed yet marks reading as the step running, and shows no percentage", () => {
    const { container } = draw(
      <SyncStage runStage="syncing" workflow={examination("provider_account_sync")} />,
    );
    expect(container.textContent).not.toContain("0%");
    const step = running(container)!;
    expect(step.label).toBe("Reading your games");
    // A travelling stripe, not a fill: a provider does not say how large an
    // archive is before it sends it, so any width here is a guess.
    expect(step.unknown).toBe(true);
    expect(step.width).toBe("");
  });

  test("exactly one step runs at a time", () => {
    const { container } = draw(<SyncStage runStage="syncing" workflow={examination(null)} />);
    expect(steps(container).filter((step) => step.state === "running")).toHaveLength(1);
  });

  test("studying fills from its own weight and counts whole games", async () => {
    workflows = [
      exam(2),
      rebuilt(4, 4, "succeeded"),
      wf("game_analysis", 100, 100, "stockfish_screen_game", "succeeded"),
      wf("game_analysis", 100, 100, "stockfish_screen_game", "succeeded"),
      wf("game_analysis", 20, 100),
      wf("game_analysis", 0, 100),
    ];
    const { container } = draw(<SyncStage runStage="analysing" workflow={examination(null)} />);

    await waitFor(() => expect(running(container)?.width).toBe("55%"));
    const step = running(container)!;
    expect(step.label).toBe("Studying every move");
    // The concrete version of the same fact, and the one a person feels. It is
    // a raw tally, so it keeps moving through the moments the fill has to wait
    // for a newly planned batch to be absorbed.
    expect(step.detail).toBe("2 of 4 games");
  });

  test("what has finished is marked finished", async () => {
    // The failure this whole model exists to fix: a screen that never says what
    // it has already done leaves a person unable to tell working from stuck.
    workflows = [exam(2), rebuilt(4, 4, "succeeded"), game(20)];
    const { container } = draw(<SyncStage runStage="analysing" workflow={examination(null)} />);

    await waitFor(() => expect(steps(container)[0]?.state).toBe("done"));
    expect(steps(container).map((step) => step.state)).toEqual([
      "done",
      "done",
      "running",
      "waiting",
    ]);
  });

  test("the import counts up and never draws a fill", async () => {
    // A sync is one work item per account and an item scores only when it
    // finishes, so "0%" through the whole download is not a measurement — it is
    // the unit being bigger than anything that has happened yet.
    workflows = [exam(0, "provider_account_sync"), rebuilt(0, 120)];
    const { container } = draw(
      <SyncStage runStage="syncing" workflow={examination("provider_account_sync")} />,
    );
    await waitFor(() => expect(running(container)?.detail).toBe("120 games"));
    const step = running(container)!;
    expect(step.label).toBe("Reading your games");
    expect(step.unknown).toBe(true);
    expect(step.width).toBe("");
  });

  test("rebuilding shows its tally while the archive is still arriving, and no fill", async () => {
    // Its denominator grows every time the sweep finds more games, so a fill
    // would slide backwards on a run going perfectly well.
    workflows = [exam(0, "provider_account_sync"), rebuilt(40, 120)];
    const { container } = draw(
      <SyncStage runStage="syncing" workflow={examination("provider_account_sync")} />,
    );
    await waitFor(() => expect(steps(container)[1]?.detail).toBe("40 of 120 games"));
    expect(steps(container)[1]?.state).toBe("waiting");
    expect(steps(container)[1]?.width).toBeNull();
  });

  test("boards are asked for while the archive is still arriving", async () => {
    // A game is readable as soon as a sync commits the page it arrived on, and
    // `/v1/games/recent` needs no analysis. Waiting for analysis weight left the
    // screen with nothing on it through the whole import, which is the stretch
    // a person is most likely to be watching.
    workflows = [exam(0, "provider_account_sync")];
    draw(<SyncStage runStage="syncing" workflow={examination("provider_account_sync")} />);
    await waitFor(() => expect(asked).toBeGreaterThan(0));
  });

  test("an empty games answer during the import draws no boards and no error", async () => {
    workflows = [exam(0, "provider_account_sync")];
    const { container } = draw(
      <SyncStage runStage="syncing" workflow={examination("provider_account_sync")} />,
    );
    await waitFor(() => expect(asked).toBeGreaterThan(0));
    expect(container.querySelector(".sync-row")).toBeNull();
    expect(steps(container)).toHaveLength(4);
  });

  test("no examination workflow at all still draws a screen", () => {
    // The run can report `wait` before the workflow read lands. A blank page
    // for a poll's worth of time is the failure this whole screen is about.
    const { container } = draw(<SyncStage runStage="linking" workflow={null} />);
    expect(steps(container)).toHaveLength(4);
    expect(running(container)?.label).toBe("Reading your games");
  });

  test("the caption is the server's words, and silent when they repeat the step", () => {
    // The task actually running wins. What it must not do is restate the step
    // above it: "IMPORTING" over "Gathering what to read" was one screen
    // contradicting itself at two sizes.
    const named = draw(
      <SyncStage
        runStage="syncing"
        workflow={examination("stockfish_screen_game")}
        waitReason="importing your games"
      />,
    );
    expect(named.container.querySelector(".sync-detail")!.textContent).toBe(
      "Looking over every move",
    );
    named.unmount();

    const fallback = draw(
      <SyncStage runStage="syncing" workflow={examination(null)} waitReason="importing your games" />,
    );
    expect(fallback.container.querySelector(".sync-detail")!.textContent).toBe(
      "Importing your games",
    );
  });

  test("a games route that answers with nothing costs the screen nothing else", async () => {
    workflows = [exam(2), rebuilt(4, 4, "succeeded"), game(20)];
    const { container } = draw(<SyncStage runStage="analysing" workflow={examination(null)} />);
    await waitFor(() => expect(running(container)?.width).toBe("20%"));
    // Everything that carries the wait is still here; only the evidence is not.
    expect(container.querySelector(".sync-row")).toBeNull();
    expect(steps(container)).toHaveLength(4);
    expect(container.textContent).toContain("Building your first report");
  });
});
