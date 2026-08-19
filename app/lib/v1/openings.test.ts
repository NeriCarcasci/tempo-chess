/**
 * The claims the explorer's client layer keeps.
 *
 * Each test is one way this screen could quietly start lying: three different
 * reasons for an empty graph collapsed into one sentence, an expected-score
 * loss dressed up as centipawns, or a queued engine job rendered as an answer.
 */

import { describe, expect, test } from "vitest";
import {
  explorerEmptyCopy,
  explorerEmptyReason,
  type ExplorerEmptyReason,
} from "./openings";

const NO_FILTERS = { color: null, speed: null, provider: null, family: null };

describe("explorerEmptyReason", () => {
  test("no games and no filters is an empty archive", () => {
    expect(explorerEmptyReason({ coverage: { games: 0 }, filters: NO_FILTERS })).toBe("no_games");
  });

  test("no games behind a filter is the filter, not the archive", () => {
    // The distinction that matters: telling someone with 400 games that they
    // have none because they clicked "Black" is the worst of the three.
    const reason = explorerEmptyReason({
      coverage: { games: 0 },
      filters: { ...NO_FILTERS, color: "black" },
    });
    expect(reason).toBe("filtered_out");
  });

  test("every filter alone is enough to change the reason", () => {
    for (const key of ["color", "speed", "provider", "family"] as const) {
      const reason = explorerEmptyReason({
        coverage: { games: 0 },
        filters: { ...NO_FILTERS, [key]: "x" },
      });
      expect(reason, `${key} did not register as a filter`).toBe("filtered_out");
    }
  });

  test("games with no walkable move are waiting, not empty", () => {
    // Games reached the join but produced no position rows, which means the
    // materializer has not run. It resolves on its own and must say so.
    expect(explorerEmptyReason({ coverage: { games: 12 }, filters: NO_FILTERS })).toBe(
      "not_materialized",
    );
  });
});

describe("explorerEmptyCopy", () => {
  const REASONS: ExplorerEmptyReason[] = ["no_games", "filtered_out", "not_materialized"];

  test("no two reasons produce the same sentence", () => {
    const titles = REASONS.map((reason) => explorerEmptyCopy(reason, 3).title);
    expect(new Set(titles).size).toBe(REASONS.length);
    const details = REASONS.map((reason) => explorerEmptyCopy(reason, 3).detail);
    expect(new Set(details).size).toBe(REASONS.length);
  });

  test("every reason is a sentence, never a blank", () => {
    for (const reason of REASONS) {
      const copy = explorerEmptyCopy(reason, 3);
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.detail.length).toBeGreaterThan(0);
    }
  });

  test("the waiting state counts the games it is waiting on", () => {
    expect(explorerEmptyCopy("not_materialized", 12).detail).toContain("12 games are");
    expect(explorerEmptyCopy("not_materialized", 1).detail).toContain("1 game is");
  });

  test("an empty archive never blames a filter", () => {
    expect(explorerEmptyCopy("no_games", 0).detail).not.toContain("filter");
  });
});
