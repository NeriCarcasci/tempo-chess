/**
 * The three ways a concept panel can be empty, and why they must not look alike.
 *
 * "We have never synced this game", "we have not analysed it yet", and "we
 * measured it and this move was quiet" are three different things to be told.
 * An interface that renders all three as an empty panel tells the reader none
 * of them, and the third one — the honest, common case — is the one that reads
 * as a broken feature.
 *
 * The ply arithmetic gets a test for the same reason it is easy to get wrong in
 * one direction and never notice: the API numbers plies from the position
 * before a move and the move reel numbers them from one, so an off-by-one shows
 * concepts against the wrong move rather than against no move.
 */

import { describe, expect, test } from "vitest";
import { conceptSectionState, conceptsAtPly, lichessIdFrom } from "./review";
import type { GameReview } from "./types";

function review(over: Partial<GameReview> = {}): GameReview {
  return {
    sections: { events: "published", concepts: "published" },
    events: [],
    ...over,
  } as unknown as GameReview;
}

const event = (startPly: number, endPly: number) => ({
  eventType: "double_attack",
  startPly,
  focalPly: startPly,
  endPly,
  actorColor: "white",
  affectedColor: "black",
  completeness: "complete",
  confidence: 0.6,
  facts: {},
  concepts: [],
});

describe("what the panel says when it has nothing", () => {
  test("a game Forma never synced says so", () => {
    const state = conceptSectionState(null, "not_synced");
    expect(state.kind).toBe("absent");
    expect(state.kind === "absent" && state.text).toMatch(/synced/i);
  });

  test("a synced game with no analysis says something different", () => {
    const state = conceptSectionState(null, "not_analyzed");
    expect(state.kind).toBe("absent");
    expect(state.kind === "absent" && state.text).toMatch(/analysed/i);
  });

  test("a failed request blames itself, not the game", () => {
    const state = conceptSectionState(null, "unreachable");
    expect(state.kind === "absent" && state.text).toMatch(/couldn't reach/i);
  });

  test("a game analysed before concepts existed is unavailable, not empty", () => {
    const older = review({ sections: { events: "unavailable" } } as Partial<GameReview>);
    const state = conceptSectionState(older, null);
    expect(state.kind).toBe("absent");
  });

  test("a measured game with nothing found is ready, and the panel says so itself", () => {
    // The one that must NOT be an absence. `published` with an empty array is a
    // real answer: this game was measured. Treating it as missing analysis is
    // how a working feature reads as a broken one.
    expect(conceptSectionState(review(), null)).toEqual({ kind: "ready" });
  });
});

describe("which move a concept belongs to", () => {
  test("an event covers every ply of its span", () => {
    const found = review({ events: [event(4, 6)] } as Partial<GameReview>);
    expect(conceptsAtPly(found, 3)).toHaveLength(0);
    expect(conceptsAtPly(found, 4)).toHaveLength(1);
    expect(conceptsAtPly(found, 5)).toHaveLength(1);
    expect(conceptsAtPly(found, 6)).toHaveLength(1);
    expect(conceptsAtPly(found, 7)).toHaveLength(0);
  });

  test("no review is no concepts rather than a crash", () => {
    expect(conceptsAtPly(null, 4)).toEqual([]);
  });

  test("a review with no events array is survivable", () => {
    expect(conceptsAtPly({ sections: {} } as unknown as GameReview, 0)).toEqual([]);
  });
});

describe("bridging the two identifiers", () => {
  test("a Lichess id is read out of a provider URL", () => {
    expect(lichessIdFrom("https://lichess.org/abcd1234")).toBe("abcd1234");
    expect(lichessIdFrom("https://lichess.org/abcd1234/black#42")).toBe("abcd1234");
  });

  test("anything else is null rather than a guess", () => {
    expect(lichessIdFrom(null)).toBeNull();
    expect(lichessIdFrom("https://chess.com/game/123")).toBeNull();
  });
});
