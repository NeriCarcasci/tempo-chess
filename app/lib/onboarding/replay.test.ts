import { describe, expect, test } from "vitest";
import { toFrames } from "./replay";
import type { RecentGame } from "../v1/games";

/**
 * The replay, tested on the one thing that is not obvious from reading it.
 *
 * Piece identity is recovered by diffing consecutive positions, not by
 * following the move, so the cases worth pinning are the ones where the diff
 * has to choose: castling moves two pieces at once, and a capture removes one
 * piece from a square another arrives at.
 */

const game = (uci: string[], over: Partial<RecentGame> = {}): RecentGame => ({
  id: "g1",
  opponent: "someone",
  opponentRating: null,
  colour: "white",
  speed: "blitz",
  result: "white",
  outcome: "win",
  playedAt: null,
  providerUrl: null,
  initialFen: null,
  moves: uci.map((move) => ({ uci: move })),
  ...over,
});

const idAt = (frame: { pieces: { id: string; square: number }[] }, square: number): string | null =>
  frame.pieces.find((piece) => piece.square === square)?.id ?? null;

describe("toFrames", () => {
  test("the opening position is a frame, so a board never starts mid-game", () => {
    const frames = toFrames(game(["e2e4"]));
    expect(frames).toHaveLength(2);
    expect(frames[0]!.pieces).toHaveLength(32);
    expect(frames[0]!.from).toBeNull();
  });

  test("a piece that moves keeps its identity", () => {
    const frames = toFrames(game(["e2e4"]));
    // e2 is square 12, e4 is square 28.
    expect(idAt(frames[1]!, 28)).toBe(idAt(frames[0]!, 12));
    expect(frames[1]!.from).toBe(12);
    expect(frames[1]!.to).toBe(28);
  });

  test("castling hands each id to its own piece rather than crossing them", () => {
    const frames = toFrames(game(["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6", "e1g1"]));
    const before = frames[frames.length - 2]!;
    const after = frames[frames.length - 1]!;
    // e1 = 4, h1 = 7, g1 = 6, f1 = 5.
    expect(idAt(after, 6)).toBe(idAt(before, 4));
    expect(idAt(after, 5)).toBe(idAt(before, 7));
  });

  test("a capture leaves one piece on the square, and it is the one that moved", () => {
    const frames = toFrames(game(["e2e4", "d7d5", "e4d5"]));
    const before = frames[2]!;
    const after = frames[3]!;
    // e4 = 28, d5 = 35.
    expect(idAt(after, 35)).toBe(idAt(before, 28));
    expect(after.pieces.filter((piece) => piece.square === 35)).toHaveLength(1);
    expect(after.pieces).toHaveLength(31);
  });

  test("a move the position rejects stops the replay where it is still true", () => {
    const frames = toFrames(game(["e2e4", "e2e4"]));
    expect(frames).toHaveLength(2);
  });

  test("a game that cannot be replayed at all yields nothing to draw", () => {
    // A still board in a row of moving ones reads as a board that has crashed,
    // so the seat is left empty instead.
    expect(toFrames(game([], { initialFen: "not a fen" }))).toHaveLength(0);
    expect(toFrames(game(["a1a2"]))).toHaveLength(0);
  });

  test("a non-standard start position is honoured", () => {
    const frames = toFrames(
      game(["e1e2"], { initialFen: "4k3/8/8/8/8/8/8/4K3 w - - 0 1" }),
    );
    expect(frames[0]!.pieces).toHaveLength(2);
    expect(frames).toHaveLength(2);
  });
});
