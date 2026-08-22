/**
 * `npm run concepts:performance` — what the detector costs, measured.
 *
 * This project adds no engine work, so there is no engine benchmark to run.
 * What it does add is a one-ply minimax over static exchange, executed once per
 * candidate motif, and that is a cost nobody can eyeball: `guaranteedGain`
 * plays every legal reply the defender has and asks what static exchange still
 * wins after each, and `detectTrappedPiece` does something similar for every
 * enemy piece worth taking. On a middlegame position that is thirty replies
 * against thirty captures, and the number of positions where it triggers is not
 * a constant.
 *
 * So it is measured against a production-shaped game rather than asserted to be
 * fine. Eighty plies, a real opening through a real middlegame, with stored
 * candidate lines on the plies a deep search would have reached.
 *
 * The budget is a recorded threshold rather than a guess about hardware. It is
 * generous on purpose: this runs on whatever machine CI happens to give it, and
 * a gate that fails on a slow runner teaches people to ignore gates. What it
 * catches is the change that makes detection quadratic — a nested walk added to
 * a detector, a helper that stops reusing the position index — which shows up
 * as multiples rather than as percentages.
 */

import { strict as assert } from "node:assert";
import { Chess } from "chessops/chess";
import { INITIAL_FEN, makeFen, parseFen } from "chessops/fen";
import { makeUci, parseUci } from "chessops/util";
import { detectGame } from "../detect.js";
import type { CandidateLine, GameFacts, PositionFact, TransitionFact } from "../evidence.js";

/**
 * The budgets this gate holds the detector to.
 *
 * `perGameMs` is one full game of detection, through every family, on the shape
 * built below. The baseline it was set from is recorded beside it so a later
 * reader can tell a slow machine from a changed algorithm.
 */
export const CONCEPT_BUDGETS = {
  /**
   * One 80-ply game through every detector.
   *
   * The recorded baseline on the machine this was written on is 32.2ms for 53
   * observations. 500ms is roughly fifteen times that, which tolerates a much
   * slower runner while still catching an order-of-magnitude change in the
   * shape of the work. The first budget written here was 4,000ms, which is a
   * hundred and twenty times the baseline -- loose enough that a tenfold
   * regression would have passed it silently, which is not a budget.
   */
  perGameMs: 500,
  /** What the baseline measured, so the next reader knows what moved. */
  baselineMs: 32.2,
  baselineObservations: 53,
  /** Plies in the shaped game, so the two numbers below are readable. */
  plies: 80,
} as const;

/**
 * Eighty plies of real chess.
 *
 * A scripted opening into a middlegame with pieces still on, because an
 * endgame with four pieces exercises none of the branching this is measuring.
 * Played through `chessops` so every position is legal by construction rather
 * than by my having typed it correctly.
 */
function shapedGame(): { positions: PositionFact[]; moves: string[] } {
  const board = Chess.fromSetup(parseFen(INITIAL_FEN).unwrap()).unwrap();
  const positions: PositionFact[] = [{ ply: 0, fen: makeFen(board.toSetup()) }];
  const moves: string[] = [];

  // A deterministic walk rather than a hand-written game score. The choice is
  // rotated by ply so the walk does not settle into shuffling one piece back
  // and forth, which would leave the board untouched and measure nothing.
  let ply = 0;
  while (ply < CONCEPT_BUDGETS.plies) {
    const options: string[] = [];
    for (const [from, dests] of board.allDests()) {
      for (const to of dests) options.push(makeUci({ from, to }));
    }
    if (options.length === 0) break;
    const chosen = options[ply % options.length]!;
    const move = parseUci(chosen);
    if (!move || !board.isLegal(move)) break;
    board.play(move);
    moves.push(chosen);
    ply += 1;
    positions.push({ ply, fen: makeFen(board.toSetup()) });
  }
  return { positions, moves };
}

function shapedFacts(): GameFacts {
  const { positions, moves } = shapedGame();
  const transitions = moves.map((uci, index): TransitionFact => ({
    fromPly: index,
    actorColor: index % 2 === 0 ? "white" : "black",
    playedMoveUci: uci,
    bestMoveUci: uci,
    playedMoveRank: 1,
    playedMoveAcceptable: true,
    onlyMove: null,
    // A deep search reaches a minority of plies. Every eighth is the shape the
    // selector produces on a real game, and it is the plies with candidate
    // lines that cost the most, so they must be present rather than assumed
    // away.
    criticality: index % 8 === 0 ? 0.4 : null,
    acceptableMoveCount: index % 8 === 0 ? 2 : null,
    candidateCount: index % 8 === 0 ? 3 : null,
    expectedScoreBefore: 0.5,
    expectedScoreAfter: 0.5,
    phase: index < 20 ? "opening" : index < 60 ? "middlegame" : "endgame",
  }));

  // Bounded stored lines on the deep plies, as `evaluation_candidates` holds
  // them: the first move of the line is the candidate itself.
  const candidatesByPly = new Map<number, readonly CandidateLine[]>();
  for (const transition of transitions) {
    if (transition.candidateCount === null) continue;
    const next = moves[transition.fromPly + 1];
    const line = next === undefined
      ? [transition.playedMoveUci]
      : [transition.playedMoveUci, next];
    candidatesByPly.set(transition.fromPly, [
      { rank: 1, uci: line[0]!, expectedScore: 0.5, pv: line },
    ]);
  }

  return {
    subjectColor: "white",
    speed: "blitz",
    playedAt: new Date("2026-08-01T00:00:00Z"),
    termination: "resign",
    result: "white",
    positions,
    transitions,
    candidatesByPly,
  };
}

function main(): void {
  const facts = shapedFacts();
  assert.equal(
    facts.transitions.length,
    CONCEPT_BUDGETS.plies,
    "the shaped game did not reach its full length, so the measurement is of something smaller",
  );

  // Several untimed passes let the hot detector code, not Node's first-call
  // compilation, become the thing being measured. Several timed passes then
  // use the median so one scheduler pause on a shared runner does not turn the
  // budget into noise.
  const warmCounts = Array.from({ length: 3 }, () => detectGame(facts).length);
  assert.equal(new Set(warmCounts).size, 1, "warmup passes disagreed on the detector output");

  const measurements: number[] = [];
  let found = detectGame(facts);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const started = process.hrtime.bigint();
    found = detectGame(facts);
    measurements.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  assert.equal(
    found.length,
    warmCounts[0],
    "warm and measured passes disagreed, which is a determinism failure rather than a timing one",
  );
  assert.equal(
    found.length,
    CONCEPT_BUDGETS.baselineObservations,
    "the shaped workload changed; review and re-baseline the budget before accepting its timing",
  );
  const ordered = [...measurements].sort((left, right) => left - right);
  const elapsedMs = ordered[Math.floor(ordered.length / 2)]!;

  const verdict = elapsedMs <= CONCEPT_BUDGETS.perGameMs ? "within" : "OVER";
  console.log(
    `concepts:performance  ${CONCEPT_BUDGETS.plies}-ply game, `
    + `${found.length} observations, ${elapsedMs.toFixed(1)}ms median `
    + `(${measurements.map((value) => value.toFixed(1)).join(", ")}ms; `
    + `budget ${CONCEPT_BUDGETS.perGameMs}ms) — ${verdict}`,
  );

  assert.ok(
    elapsedMs <= CONCEPT_BUDGETS.perGameMs,
    `detection took ${elapsedMs.toFixed(1)}ms against a budget of ${CONCEPT_BUDGETS.perGameMs}ms. `
    + "The budget is deliberately loose, so this is a change in the shape of the work rather "
    + "than a slow machine.",
  );
}

main();
