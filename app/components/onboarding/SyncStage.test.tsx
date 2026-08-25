import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Workflow } from "../../lib/v1/types";
import type { WorkflowLike } from "../../lib/onboarding/sync";

/**
 * The wait, at the points where it would go back to lying.
 *
 * The screen this replaced sat at 0% for the whole of a run, so the tests that
 * matter are about the fill: that it is a measurement of real weight rather
 * than a picture of which phase is running, that it has no number at all before
 * there is a denominator, and that a games route which does not exist yet costs
 * the screen nothing else.
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

const examination = (stage: string | null): Workflow =>
  ({
    id: "wf-1",
    state: "running",
    kind: "initial_examination",
    progress: { completedWeight: 0, totalWeight: 5, percent: 0, stage, message: null },
  }) as Workflow;

const draw = (node: React.ReactElement) => render(<MemoryRouter>{node}</MemoryRouter>);

const bar = (container: HTMLElement) => {
  const fill = container.querySelector(".sync-bar-fill") as HTMLElement | null;
  return {
    phase: container.querySelector(".sync-bar-phase")?.textContent ?? null,
    count: container.querySelector(".sync-bar-count")?.textContent ?? null,
    figure: container.querySelector(".sync-bar-figure")?.textContent ?? null,
    width: fill?.style.width ?? null,
    unknown: fill?.classList.contains("is-unknown") ?? false,
  };
};

beforeEach(() => {
  workflows = [];
  recent = [];
  asked = 0;
});

describe("SyncStage", () => {
  test("nothing weighed yet states no percentage and no countdown", () => {
    const { container } = draw(
      <SyncStage runStage="syncing" workflow={examination("provider_account_sync")} />,
    );
    expect(container.textContent).not.toContain("0%");
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBeNull();
    expect(container.textContent).toContain("Working out how long");
    // A travelling stripe, not a fill, because there is genuinely nothing to
    // measure while one indivisible work item runs.
    expect(bar(container).unknown).toBe(true);
    expect(bar(container).figure).toBe("—");
  });

  test("the bar is the analysis, measured on its own weight", async () => {
    workflows = [
      exam(2),
      wf("game_analysis", 100, 100, "stockfish_screen_game", "succeeded"),
      wf("game_analysis", 100, 100, "stockfish_screen_game", "succeeded"),
      wf("game_analysis", 20, 100),
      wf("game_analysis", 0, 100),
    ];
    const { container } = draw(<SyncStage runStage="analysing" workflow={examination(null)} />);

    await waitFor(() => expect(bar(container).width).toBe("55%"));
    const drawn = bar(container);
    expect(drawn.phase).toBe("Analysing");
    expect(drawn.figure).toBe("55%");
    // The concrete version of the same fact, and the one a person feels. It is
    // a raw tally, so it keeps moving through the moments the bar has to wait
    // for a newly planned batch to be absorbed.
    expect(drawn.count).toBe("2 of 4 games");
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("55");
  });

  test("the import reads as working, not as nought per cent", async () => {
    // A sync is one work item per account and an item scores only when it
    // finishes, so "0%" through the whole download is not a measurement — it is
    // the unit being bigger than anything that has happened yet.
    workflows = [exam(0, "provider_account_sync")];
    const { container } = draw(
      <SyncStage runStage="syncing" workflow={examination("provider_account_sync")} />,
    );
    await waitFor(() => expect(bar(container).unknown).toBe(true));
    expect(bar(container).phase).toBe("Importing");
    expect(bar(container).figure).toBe("—");
    expect(bar(container).width).toBe("");
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
    expect(screen.getByRole("progressbar")).toBeTruthy();
  });

  test("no examination workflow at all still draws a screen", () => {
    // The run can report `wait` before the workflow read lands. A blank page
    // for a poll's worth of time is the failure this whole screen is about.
    const { container } = draw(<SyncStage runStage="linking" workflow={null} />);
    expect(screen.getByRole("progressbar")).toBeTruthy();
    expect(bar(container).phase).toBe("Importing");
  });

  test("the caption is the server's words before it is ours", () => {
    // The task actually running wins; the run's own sentence stands in when
    // the examination workflow has nothing outstanding to name.
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

  test("no examination workflow at all still draws a screen", () => {
    // The run can report `wait` before the workflow read lands. A blank page
    // for a poll's worth of time is the failure this whole screen is about.
    const { container } = draw(<SyncStage runStage="linking" workflow={null} />);
    expect(screen.getByRole("progressbar")).toBeTruthy();
    expect(bar(container).phase).toBe("Importing");
  });

  test("a games route that answers with nothing costs the screen nothing else", async () => {
    workflows = [exam(2), game(20)];
    const { container } = draw(<SyncStage runStage="analysing" workflow={examination(null)} />);
    await waitFor(() => expect(bar(container).width).toBe("20%"));
    // Everything that carries the wait is still here; only the evidence is not.
    expect(container.querySelector(".sync-row")).toBeNull();
    expect(screen.getByRole("progressbar")).toBeTruthy();
    expect(container.textContent).toContain("Building your first report");
  });
});
