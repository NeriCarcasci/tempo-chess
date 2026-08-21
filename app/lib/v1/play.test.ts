/**
 * The claims the play screen's client layer keeps.
 *
 * Each test is a way this screen could quietly start lying: offering an
 * opponent that cannot answer, opening on a strength nobody chose, or printing
 * a rating the engine is not actually playing at.
 */

import { describe, expect, test } from "vitest";
import { availableFamilies, nearestLevel, strengthNote } from "./play";
import type { OpponentCatalogue, OpponentFamilyEntry, OpponentFamilyLevel } from "./types";

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
  levels: [level("800", 800, 1100), level("1400", 1400), level("2000", 2000, 1900)],
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
