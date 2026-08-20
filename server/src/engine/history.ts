/**
 * Reconstructing the rule-relevant history of one occurrence.
 *
 * Database architecture §10.5: "history-exact engine requests reconstruct the
 * move history supplied to the engine". This is that reconstruction, and the
 * window it uses is not a guess — it is the halfmove clock.
 *
 * A capture or a pawn move is irreversible: no position before it can occur
 * again, and the fifty-move counter restarts. So the position at `ply - clock`
 * is exactly the one immediately after the last irreversible move, and every
 * repetition that can affect the current position happened at or after it.
 * Handing the engine that position plus the moves since is therefore complete
 * evidence for repetition and for the fifty-move rule, and it is the shortest
 * such history — which matters, because the whole point of the cache is that
 * two games reaching the same situation share the same result.
 */

import { requiredScope, type EvaluationScope, type ExactHistory } from "./contract.js";

export interface ChainOccurrence {
  ply: number;
  fen: string;
  halfmoveClock: number;
  repetitionCount: number;
}

export interface ChainTransition {
  fromPly: number;
  uci: string;
}

export interface OccurrenceChain {
  occurrences: readonly ChainOccurrence[];
  transitions: readonly ChainTransition[];
}

/**
 * The history a `history_exact` search for this ply must replay.
 *
 * The clock is clamped against the start of the chain: a replay that began from
 * a non-standard FEN can carry a clock older than any move Forma has, and in
 * that case the honest root is the first position it does have. The engine then
 * sees a shorter history than the real game had, which can only make it *less*
 * certain about a repetition — never more.
 */
export function exactHistoryAt(chain: OccurrenceChain, ply: number): ExactHistory {
  const occurrence = chain.occurrences.find((entry) => entry.ply === ply);
  if (!occurrence) throw new RangeError(`the chain has no occurrence at ply ${ply}`);
  const rootPly = Math.max(0, ply - occurrence.halfmoveClock);
  const root = chain.occurrences.find((entry) => entry.ply === rootPly);
  if (!root) throw new RangeError(`the chain has no occurrence at root ply ${rootPly}`);

  const moves = chain.transitions
    .filter((transition) => transition.fromPly >= rootPly && transition.fromPly < ply)
    .sort((left, right) => left.fromPly - right.fromPly)
    .map((transition) => transition.uci);

  if (moves.length !== ply - rootPly) {
    // A hole in the chain would make the replayed history silently wrong. E09
    // constrains transitions to be adjacent, so this is a corrupt read rather
    // than a shape the materializer can produce.
    throw new RangeError(`the chain is not contiguous between ply ${rootPly} and ${ply}`);
  }
  return { rootFen: root.fen, moves };
}

/** The scope one occurrence's evidence must be computed at. */
export function scopeFor(occurrence: ChainOccurrence): EvaluationScope {
  return requiredScope(occurrence);
}
