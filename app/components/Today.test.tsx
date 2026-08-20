import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, test, vi } from "vitest";
import type { OpeningShape } from "../lib/todayShape";
import type { RecentGame } from "../lib/v1/games";
import type { Destination } from "../lib/onboarding/nextScreen";

/**
 * The hub, tested where it would go back to claiming things.
 *
 * Every case here is a sentence the page used to print from the prototype API
 * and can no longer stand behind: a rating and a lifetime record, "no opening
 * mistakes" over a graph that has not been built yet, and a game result read
 * off the winning colour instead of the player's own outcome.
 *
 * `TopNav` is stubbed because it is chrome with its own settings menus, sound
 * and board-theme storage, none of which this page's honesty depends on.
 */

vi.mock("./TopNav", () => ({ TopNav: () => null }));

const { Today } = await import("./Today");

const shape = (over: Partial<OpeningShape> = {}): OpeningShape => ({
  bars: [{ moveNo: 1, mistakes: 0, moves: 4 }],
  total: 0,
  peak: null,
  ...over,
});

const game = (over: Partial<RecentGame> = {}): RecentGame => ({
  id: "g1",
  opponent: "someone",
  opponentRating: null,
  colour: "black",
  speed: "blitz",
  result: "white",
  outcome: "loss",
  playedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
  providerUrl: "https://lichess.org/g1",
  initialFen: null,
  moves: [{ uci: "e2e4" }],
  ...over,
});

function draw(props: Partial<Parameters<typeof Today>[0]> = {}) {
  return render(
    <MemoryRouter>
      <Today
        shape={shape()}
        lead={null}
        empty={null}
        games={40}
        unanalysed={0}
        lastGame={null}
        run={null}
        {...props}
      />
    </MemoryRouter>,
  );
}

describe("Today", () => {
  test("the standing line is a stated absence, not a figure", () => {
    draw();
    expect(screen.getByText(/No rating or record here yet/i)).toBeTruthy();
  });

  test("a graph that has not been built yet does not read as a clean sheet", () => {
    // The three reasons for an empty graph produced one sentence, and this was
    // the one that lied: work still running, reported as nothing found.
    draw({ empty: "not_materialized", games: 333 });
    expect(screen.queryByText(/No opening mistakes/i)).toBeNull();
    expect(screen.getByText(/have not been broken into positions yet/i)).toBeTruthy();
  });

  test("no games connected is its own sentence", () => {
    draw({ empty: "no_games", games: 0 });
    expect(screen.getByText(/No games yet/i)).toBeTruthy();
  });

  test("a graph with no mistakes says so, and says over how many games", () => {
    draw({ empty: null, games: 40 });
    expect(screen.getByText(/No opening mistakes found/i)).toBeTruthy();
  });

  test("the last game is reported by the player's outcome, not the winning colour", () => {
    // `result` is "white" here and `outcome` is "loss". Reading the first would
    // congratulate a player on a game they lost.
    draw({ lastGame: game() });
    expect(screen.getByText(/Lost against someone, 2d ago/)).toBeTruthy();
  });

  test("a game with no provider link still states the fact", () => {
    draw({ lastGame: game({ providerUrl: null, opponent: null, outcome: null }) });
    expect(screen.getByText(/Played, 2d ago/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open" })).toBeNull();
  });

  test("a written report is a row that goes to it", () => {
    const run: Destination = { kind: "report", reportId: "r1" };
    draw({ run });
    expect(screen.getByRole("link", { name: "Read it" }).getAttribute("href")).toBe("/report");
  });

  test("a dead sync is not reported as work in progress", () => {
    const run: Destination = { kind: "stuck", reason: null, workflowFailed: true };
    draw({ run });
    expect(screen.getByText(/The examination stopped/)).toBeTruthy();
    expect(screen.queryByText(/Forma is reading your games/)).toBeNull();
  });

  test("a run that could not be read produces no row at all", () => {
    draw({ run: null });
    expect(screen.queryByLabelText("Then")).toBeNull();
  });
});
