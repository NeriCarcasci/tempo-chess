/**
 * The claims the play screen's client layer keeps.
 *
 * Each test is a way this screen could quietly start lying: offering an
 * opponent that cannot answer, opening on a strength nobody chose, or printing
 * a rating the engine is not actually playing at.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import { newIdempotencyKey, v1Data } from "./client";
import { availableFamilies, nearestLevel, requestOpponentMove, strengthNote } from "./play";
import type { OpponentCatalogue, OpponentFamilyEntry, OpponentFamilyLevel } from "./types";

vi.mock("./client", () => ({
  newIdempotencyKey: vi.fn(),
  v1Data: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(v1Data).mockReset();
  vi.mocked(newIdempotencyKey).mockReset();
});

const level = (
  key: OpponentFamilyLevel["key"],
  nominalRating: number,
  playsAt = nominalRating,
): OpponentFamilyLevel => ({ key, nominalRating, playsAt, clamped: playsAt !== nominalRating });

const STOCKFISH: OpponentFamilyEntry = {
  family: "stockfish",
  available: true,
  unavailableReason: null,
  levels: [level("800", 800, 1320), level("1400", 1400), level("2000", 2000)],
};

const MAIA: OpponentFamilyEntry = {
  family: "maia",
  available: false,
  unavailableReason: "not_configured",
  levels: [level("800", 800), level("1400", 1400), level("2000", 2000)],
};

const CATALOGUE: OpponentCatalogue = { families: [STOCKFISH, MAIA] };

describe("availableFamilies", () => {
  test("a family the server cannot serve is never offered", () => {
    // The failure this prevents is the worst one available: offering Maia and
    // having Stockfish answer, which would label a machine move as the move a
    // human of that rating plays.
    expect(availableFamilies(CATALOGUE).map((entry) => entry.family)).toEqual(["stockfish"]);
  });

  test("configuring a family is all it takes to offer it", () => {
    const configured = { families: [STOCKFISH, { ...MAIA, available: true, unavailableReason: null }] };
    expect(availableFamilies(configured)).toHaveLength(2);
  });
});

describe("nearestLevel", () => {
  test("opens on the level closest to the player's rating", () => {
    expect(nearestLevel(STOCKFISH.levels, 1380)?.key).toBe("1400");
    expect(nearestLevel(STOCKFISH.levels, 900)?.key).toBe("800");
  });

  test("a tie goes to the lower level", () => {
    // Guessing someone weaker costs them an easy game; guessing stronger costs
    // them the feature.
    expect(nearestLevel(STOCKFISH.levels, 1100)?.key).toBe("800");
  });

  test("no levels is null rather than a guess", () => {
    expect(nearestLevel([], 1500)).toBeNull();
  });
});

describe("strengthNote", () => {
  test("says nothing when the engine can play the level it was asked for", () => {
    expect(strengthNote(level("1400", 1400))).toBeNull();
    expect(strengthNote(null)).toBeNull();
  });

  test("names the strength really played when the engine cannot reach the level", () => {
    // The prototype offered an "800 Elo bot" that was Stockfish's 1320 floor,
    // so a player losing to it drew a false conclusion about their own rating.
    const note = strengthNote(STOCKFISH.levels[0]);
    expect(note).toContain("1320");
    expect(note).not.toContain("800");
  });
});

describe("requestOpponentMove", () => {
  test("waits for Maia work and retries with one stable turn seed", async () => {
    vi.mocked(newIdempotencyKey).mockReturnValue("retry_command_key");
    vi.mocked(v1Data)
      .mockResolvedValueOnce({
        state: "scheduled",
        workflowId: "workflow-1",
        reply: null,
        position: { fen: "current", turn: "black", status: "in_play" },
        opponent: {
          family: "maia",
          level: "1600",
          nominalRating: 1600,
          playsAt: 1600,
          clamped: false,
          engine: null,
        },
      })
      .mockResolvedValueOnce({ state: "succeeded", error: null })
      .mockResolvedValueOnce({
        state: "ready",
        workflowId: null,
        reply: { uci: "e7e5", san: "e5" },
        position: { fen: "after", turn: "white", status: "in_play" },
        opponent: {
          family: "maia",
          level: "1600",
          nominalRating: 1600,
          playsAt: 1600,
          clamped: false,
          engine: "Maia-3 5M",
        },
      });

    const result = await requestOpponentMove(
      {
        position: { fen: "root", moves: ["e2e4"] },
        opponent: { family: "maia", level: "1600" },
      },
      "turn_command_key",
    );

    expect(result.reply?.uci).toBe("e7e5");
    expect(v1Data).toHaveBeenNthCalledWith(1, "/v1/play/moves", {
      json: {
        position: { fen: "root", moves: ["e2e4"] },
        opponent: { family: "maia", level: "1600" },
        turnKey: "turn_command_key",
      },
      idempotencyKey: "turn_command_key",
    });
    expect(v1Data).toHaveBeenNthCalledWith(2, "/v1/workflows/workflow-1");
    expect(v1Data).toHaveBeenNthCalledWith(3, "/v1/play/moves", {
      json: expect.objectContaining({ turnKey: "turn_command_key" }),
      idempotencyKey: "retry_command_key",
    });
  });
});
