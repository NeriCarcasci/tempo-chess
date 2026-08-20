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
): WorkflowLike => ({
  kind,
  state: "running",
  progress: { completedWeight: completed, totalWeight: total, stage },
});

const game = (completed: number): WorkflowLike => wf("game_analysis", completed, 100);

const examination = (stage: string | null): Workflow =>
  ({
    id: "wf-1",
    state: "running",
    kind: "initial_examination",
    progress: { completedWeight: 0, totalWeight: 5, percent: 0, stage, message: null },
  }) as Workflow;

const draw = (node: React.ReactElement) => render(<MemoryRouter>{node}</MemoryRouter>);

const segments = (container: HTMLElement) =>
  [...container.querySelectorAll(".sync-seg")].map((segment) => ({
    label: segment.querySelector(".sync-seg-label")!.textContent,
    figure: segment.querySelector(".sync-seg-figure")!.textContent,
    width: (segment.querySelector(".sync-seg-fill") as HTMLElement).style.width,
    unknown: segment.querySelector(".sync-seg-fill")!.classList.contains("is-unknown"),
    active: segment.classList.contains("is-active"),
  }));

beforeEach(() => {
  workflows = [];
  recent = [];
  asked = 0;
});

describe("SyncStage", () => {
  test("nothing weighed yet states no percentage and no countdown", async () => {
    const { container } = draw(
      <SyncStage runStage="syncing" workflow={examination("provider_account_sync")} />,
    );
    expect(container.textContent).not.toContain("0%");
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBeNull();
    expect(container.textContent).toContain("Working out how long");
    // Only the section that is running gets the travelling stripe. An empty
    // track further down the bar is the truth about a section not yet started.
    const drawn = segments(container);
    expect(drawn.map((segment) => segment.unknown)).toEqual([true, false, false]);
    expect(drawn.map((segment) => segment.figure)).toEqual(["—", "—", "—"]);
  });

  test("every section fills from its own weight, not from which phase is live", async () => {
    workflows = [
      wf("initial_examination", 1, 5, "coaching_examination_report"),
      wf("game_import", 40, 40),
      game(100),
      game(100),
      game(20),
      game(0),
    ];
    const { container } = draw(<SyncStage runStage="analysing" workflow={examination(null)} />);

    await waitFor(() => expect(segments(container)[1]!.width).not.toBe(""));
    const drawn = segments(container);
    expect(drawn.map((segment) => segment.label)).toEqual(["Importing", "Analysing", "Writing"]);
    // Importing is finished, analysis is 220 of 400, and the report has done
    // one of its five items. All three are readable at once.
    expect(drawn.map((segment) => segment.width)).toEqual(["100%", "55%", "20%"]);
    expect(drawn.map((segment) => segment.figure)).toEqual(["100%", "55%", "20%"]);
    // The live section is the one with engine work outstanding.
    expect(drawn.map((segment) => segment.active)).toEqual([false, true, false]);
    // And the overall figure is the same weights added up: 261 of 445.
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("59");
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
    expect(container.querySelector(".sync-seg.is-active .sync-seg-label")?.textContent).toBe(
      "Importing",
    );
  });

  test("boards are never asked for while no game has been analysed", async () => {
    workflows = [wf("initial_examination", 0, 5, "provider_account_sync")];
    const { container } = draw(
      <SyncStage runStage="syncing" workflow={examination("provider_account_sync")} />,
    );
    await waitFor(() => expect(segments(container)[0]!.width).toBe("0%"));
    expect(asked).toBe(0);
    expect(container.querySelector(".sync-row")).toBeNull();
  });

  test("a games route that answers with nothing costs the screen nothing else", async () => {
    workflows = [game(20)];
    const { container } = draw(<SyncStage runStage="analysing" workflow={examination(null)} />);
    await waitFor(() => expect(segments(container)[1]!.width).toBe("20%"));
    // Everything that carries the wait is still here; only the evidence is not.
    expect(container.querySelector(".sync-row")).toBeNull();
    expect(screen.getByRole("progressbar")).toBeTruthy();
    expect(container.textContent).toContain("Building your first report");
  });
});
