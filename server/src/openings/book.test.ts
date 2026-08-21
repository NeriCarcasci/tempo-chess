/**
 * The claims the opening book makes.
 *
 * These are the pure parts — the line parse, the naming rule, the departure and
 * the merge. The three queries need a real Postgres and are exercised by the
 * integration gate.
 *
 * Each test is one way this module could quietly start lying: a line silently
 * shortened by a dropped move, an opening named after a position the reader is
 * not looking at, a departure reported one ply out, or an unanalysed game
 * counted as a move that went well.
 */

import assert from "node:assert/strict";
import { Chess } from "chess.js";
import { canonicalPositionKey } from "./model.js";
import {
  BOOK_START_KEY,
  MAX_BOOK_LINE_PLIES,
  departureOf,
  mergeMoves,
  parseLine,
  pickOpening,
  type BookStep,
} from "./book.js";

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${(error as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
console.log("the line walk starts where the game does");

/**
 * `BOOK_START_KEY` is a hand-written constant because the walk query needs a
 * literal. If it ever stops being the key the rest of the system derives for
 * the initial position, every line walk would start from a position that is not
 * in `opening_edges`, return nothing, and report every opening as off book from
 * move one — with no error anywhere.
 */
check("the seeded start key is the canonical key for the initial position", () => {
  assert.equal(BOOK_START_KEY, canonicalPositionKey(new Chess().fen()));
});

// ---------------------------------------------------------------------------
console.log("a line is parsed whole or refused");

check("spaces and commas both separate moves", () => {
  assert.deepEqual(parseLine("e2e4 e7e5 g1f3"), ["e2e4", "e7e5", "g1f3"]);
  assert.deepEqual(parseLine("e2e4,e7e5, g1f3"), ["e2e4", "e7e5", "g1f3"]);
  assert.deepEqual(parseLine("  e2e4   e7e5  "), ["e2e4", "e7e5"]);
});

check("a promotion keeps its piece letter", () => {
  assert.deepEqual(parseLine("a7a8q"), ["a7a8q"]);
});

/**
 * The whole point of refusing rather than filtering. A dropped ply shifts every
 * move after it onto the wrong position, and the walk would then answer
 * confidently about a line nobody played.
 */
check("a malformed move refuses the line rather than being dropped", () => {
  assert.throws(() => parseLine("e2e4 xx e7e5"), /not a UCI move/);
  assert.throws(() => parseLine("e2e9"), /not a UCI move/);
});

check("a line longer than the bound is refused", () => {
  const long = Array.from({ length: MAX_BOOK_LINE_PLIES + 1 }, () => "e2e4").join(" ");
  assert.throws(() => parseLine(long), /at most/);
});

// ---------------------------------------------------------------------------
console.log("an opening is named after the deepest position the book still has");

function step(idx: number, toKey: string, name: string | null, family: string | null): BookStep {
  return {
    idx,
    fromKey: `from-${idx}`,
    uci: "e2e4",
    toKey,
    name,
    eco: name ? "B90" : null,
    family,
    variation: null,
    ply: idx,
    lineSan: name ? `line ${idx}` : null,
    lineUci: name ? `uci ${idx}` : null,
  };
}

check("the position's own name wins when it has one", () => {
  const opening = pickOpening(
    "key-3",
    {
      name: "Sicilian Defense: Najdorf Variation",
      eco: "B90",
      family: "Sicilian Defense",
      variation: "Najdorf Variation",
      ply: 6,
      lineUci: "e2e4 c7c5",
      lineSan: "1. e4 c5",
    },
    [step(1, "key-1", "Sicilian Defense", "Sicilian Defense")],
  );
  assert.equal(opening?.name, "Sicilian Defense: Najdorf Variation");
  assert.equal(opening?.atRequestedPosition, true);
});

/**
 * One move out of book there is no catalogue row, and "unknown" is a true and
 * useless answer. The deepest named ancestor on the caller's own move order is
 * the answer a person would give — and `atRequestedPosition` is what stops the
 * screen presenting it as a name for the board on screen.
 */
check("an unnamed position borrows the deepest named position on its line", () => {
  const opening = pickOpening("key-off-book", null, [
    step(1, "key-1", "King's Pawn Game", "King's Pawn Game"),
    step(2, "key-2", "Sicilian Defense", "Sicilian Defense"),
    step(3, "key-3", null, null),
  ]);
  assert.equal(opening?.name, "Sicilian Defense");
  assert.equal(opening?.ply, 2);
  assert.equal(opening?.atRequestedPosition, false);
});

check("a named step that is the requested position says so", () => {
  const opening = pickOpening("key-2", null, [
    step(1, "key-1", "King's Pawn Game", "King's Pawn Game"),
    step(2, "key-2", "Sicilian Defense", "Sicilian Defense"),
  ]);
  assert.equal(opening?.atRequestedPosition, true);
});

check("nothing named means no opening, not a placeholder", () => {
  assert.equal(pickOpening("key-1", null, []), null);
  assert.equal(pickOpening("key-1", null, [step(1, "key-1", null, null)]), null);
});

// ---------------------------------------------------------------------------
console.log("the departure is the first move the book has no edge for");

check("a line entirely inside the book has no departure", () => {
  const moves = ["e2e4", "c7c5"];
  const steps = [step(1, "key-1", "King's Pawn Game", "King's Pawn Game"), step(2, "key-2", "Sicilian Defense", "Sicilian Defense")];
  assert.equal(departureOf(moves, steps), null);
});

/**
 * Ply 0 is the initial position with White to move, so the nth move of the game
 * is played at ply n-1. Two book moves means the departure is the third move,
 * at ply 2, and White's.
 */
check("the departing ply and side come from the count of book moves", () => {
  const moves = ["e2e4", "c7c5", "b1a3"];
  const steps = [step(1, "key-1", "King's Pawn Game", "King's Pawn Game"), step(2, "key-2", "Sicilian Defense", "Sicilian Defense")];
  const departure = departureOf(moves, steps);
  assert.equal(departure?.uci, "b1a3");
  assert.equal(departure?.ply, 2);
  assert.equal(departure?.side, "white");
  assert.equal(departure?.lastBookKey, "key-2");
  assert.equal(departure?.lastBookName, "Sicilian Defense");
});

check("a black departure is reported as black's", () => {
  const departure = departureOf(["e2e4", "a7a5"], [step(1, "key-1", "King's Pawn Game", "King's Pawn Game")]);
  assert.equal(departure?.side, "black");
  assert.equal(departure?.ply, 1);
});

/**
 * Leaving the book on move one has no last book position but still has a last
 * book *key*: the initial position. Returning null there would make "you left
 * the book immediately" indistinguishable from "you never left it".
 */
check("a first-move departure falls back to the initial position", () => {
  const departure = departureOf(["a2a3"], []);
  assert.equal(departure?.ply, 0);
  assert.equal(departure?.lastBookKey, BOOK_START_KEY);
  assert.equal(departure?.lastBookName, null);
});

check("no line means no departure claim at all", () => {
  assert.equal(departureOf([], []), null);
});

// ---------------------------------------------------------------------------
console.log("the book's moves and the player's are comparable, and unjudged is not clean");

const BOOK = [
  { uci: "e7e5", san: "e5", name: "King's Pawn Game", eco: "C20" },
  { uci: "c7c5", san: "c5", name: "Sicilian Defense", eco: "B20" },
  { uci: "e7e6", san: "e6", name: null, eco: null },
];

check("continuations lead with the move the caller actually plays", () => {
  const { continuations } = mergeMoves(BOOK, [
    { uci: "c7c5", san: "c5", games: 40, judged: 30, mistakes: 4 },
    { uci: "e7e5", san: "e5", games: 3, judged: 3, mistakes: 0 },
  ]);
  assert.deepEqual(
    continuations.map((move) => move.uci),
    ["c7c5", "e7e5", "e7e6"],
  );
  assert.equal(continuations[0]!.yourGames, 40);
  // A move nobody in this account has played is still in the book, at zero.
  assert.equal(continuations[2]!.yourGames, 0);
});

/**
 * The property the whole endpoint exists to keep. Eleven games with two
 * verdicts is not nine games that went well: `games` and `judged` are separate
 * numbers and neither is derivable from the other, so a screen cannot subtract
 * its way to a reassuring figure.
 */
check("a move played more often than it was judged keeps both numbers", () => {
  const { yourMoves } = mergeMoves(BOOK, [
    { uci: "c7c5", san: "c5", games: 11, judged: 2, mistakes: 1 },
  ]);
  assert.equal(yourMoves[0]!.games, 11);
  assert.equal(yourMoves[0]!.judged, 2);
  assert.equal(yourMoves[0]!.mistakes, 1);
  assert.notEqual(yourMoves[0]!.games - yourMoves[0]!.mistakes, yourMoves[0]!.judged);
});

check("a played move the catalogue does not have is marked off book", () => {
  const { yourMoves } = mergeMoves(BOOK, [
    { uci: "a7a5", san: "a5", games: 6, judged: 6, mistakes: 5 },
    { uci: "c7c5", san: "c5", games: 2, judged: 2, mistakes: 0 },
  ]);
  assert.equal(yourMoves[0]!.uci, "a7a5");
  assert.equal(yourMoves[0]!.inBook, false);
  assert.equal(yourMoves[1]!.inBook, true);
});

check("the ordering is total, so two identical reads produce one ETag", () => {
  const played = [
    { uci: "c7c5", san: "c5", games: 4, judged: 4, mistakes: 1 },
    { uci: "e7e5", san: "e5", games: 4, judged: 4, mistakes: 1 },
  ];
  const first = mergeMoves(BOOK, played);
  const second = mergeMoves([...BOOK].reverse(), [...played].reverse());
  assert.deepEqual(first.continuations, second.continuations);
  assert.deepEqual(first.yourMoves, second.yourMoves);
});

// ---------------------------------------------------------------------------
if (failures > 0) {
  console.log(`\nopening book gate: ${failures} failed`);
  process.exit(1);
}
console.log("\nopening book gate: pass");
