/**
 * Core positions, occurrence chains and transitions.
 *
 * A *core position* is what the board is: pieces, side to move, castling
 * rights, and an en-passant square only when a capture is actually legal. It is
 * deliberately history-free, which is what makes a transposition findable.
 *
 * An *occurrence* is that position appearing at a specific ply of a specific
 * replay, and it carries the history the core key omits: halfmove clock,
 * fullmove number, and how many times this exact position has already occurred
 * in this game. Two games reaching the same board share a core position and
 * keep separate occurrences, which is the distinction §10 requires: the same
 * core with different history must stay distinct in occurrence context.
 *
 * The rules come from `chessops`, not from anything written here. Legal
 * en-passant, castling rights and repetition are exactly the places a
 * hand-rolled implementation goes subtly wrong.
 *
 * Sources: plans/database-architecture.md §§10-11, plans/v1-platform-spec.md
 * §§3.5, 9-10.
 */

import { createHash } from "node:crypto";
import { Chess } from "chessops/chess";
import { makeFen, parseFen, INITIAL_FEN } from "chessops/fen";
import { parseUci } from "chessops/util";
import { makeSan } from "chessops/san";

export const CORE_KEY_VERSION = "core-1";

export interface CoreKeyParts {
  /** Board, side to move, castling rights, and legal en passant only. */
  readonly board: string;
  readonly turn: "w" | "b";
  readonly castling: string;
  /** The en-passant square, or "-" when no capture is legal from it. */
  readonly enPassant: string;
}

/**
 * The parts of a FEN that identify the position itself.
 *
 * The halfmove clock and fullmove number are dropped: they are history, not
 * board state, and including them would make every transposition unique.
 *
 * The en-passant square is kept only when a capture onto it is legal. A FEN
 * records the square whenever a pawn double-steps, even with no enemy pawn able
 * to take, so keeping it verbatim would split one position into two.
 */
export function coreKeyParts(position: Chess): CoreKeyParts {
  const fen = makeFen(position.toSetup());
  const [board, turn, castling, enPassant] = fen.split(" ");
  return {
    board,
    turn: turn as "w" | "b",
    castling: castling === "" ? "-" : castling,
    enPassant: legalEnPassantSquare(position, enPassant),
  };
}

/**
 * The en-passant square if some legal move actually captures onto it.
 *
 * `chessops` already filters an en-passant target that would leave the king in
 * check, so asking it for the legal moves is the same question the rules ask.
 */
function legalEnPassantSquare(position: Chess, square: string): string {
  if (!square || square === "-") return "-";
  const target = square.trim();
  for (const [from, squares] of position.allDests()) {
    for (const to of squares) {
      // An en-passant capture lands on the target square with a pawn.
      if (position.board.get(from)?.role !== "pawn") continue;
      if (squareName(to) === target) return target;
    }
  }
  return "-";
}

const FILES = "abcdefgh";

function squareName(square: number): string {
  return `${FILES[square & 7]}${(square >> 3) + 1}`;
}

export function coreKey(position: Chess): string {
  const parts = coreKeyParts(position);
  return `${parts.board} ${parts.turn} ${parts.castling} ${parts.enPassant}`;
}

/** A stable hash of the core key, for indexing and equality. */
export function coreKeyHash(key: string): string {
  return createHash("sha256").update(`${CORE_KEY_VERSION}:${key}`).digest("hex");
}

export interface Occurrence {
  /** 0 for the starting position; 1 after the first move. */
  readonly ply: number;
  readonly coreKey: string;
  readonly coreKeyHash: string;
  readonly fen: string;
  readonly halfmoveClock: number;
  readonly fullmoveNumber: number;
  /** How many times this exact core position has occurred so far, 1-based. */
  readonly repetitionCount: number;
  readonly sideToMove: "w" | "b";
  /** Draw-by-rule availability, which the core key cannot express. */
  readonly threefold: boolean;
  readonly fivefold: boolean;
  readonly fiftyMoveAvailable: boolean;
  readonly seventyFiveMoveForced: boolean;
}

export interface Transition {
  readonly fromPly: number;
  readonly toPly: number;
  readonly uci: string;
  readonly san: string | null;
  readonly clockMs: number | null;
}

export interface MaterializedReplay {
  readonly occurrences: readonly Occurrence[];
  readonly transitions: readonly Transition[];
  /** Deterministic over the whole chain, for rebuild comparison. */
  readonly checksum: string;
}

export class ReplayMaterializationError extends Error {
  constructor(
    readonly ply: number,
    readonly reason: "illegal_move" | "bad_initial_fen" | "unparsable_move",
  ) {
    super(`replay could not be materialized at ply ${ply}: ${reason}`);
    this.name = "ReplayMaterializationError";
  }
}

export interface ReplayInput {
  readonly initialFen?: string | null;
  readonly moves: readonly { uci: string; clockMs?: number | null }[];
}

/**
 * Build the full occurrence chain and its transitions.
 *
 * Produces exactly `moves.length + 1` occurrences: the position before any move
 * plus one after each. The transitions are unbroken by construction, because
 * each is emitted from the position that produced it.
 *
 * An illegal move throws rather than being skipped. A chain with a hole would
 * silently misattribute every position after it, which is worse than refusing
 * the replay.
 */
export function materializeReplay(input: ReplayInput): MaterializedReplay {
  const setup = parseFen(input.initialFen?.trim() || INITIAL_FEN);
  if (setup.isErr) throw new ReplayMaterializationError(0, "bad_initial_fen");
  const positionResult = Chess.fromSetup(setup.value);
  if (positionResult.isErr) throw new ReplayMaterializationError(0, "bad_initial_fen");
  const position = positionResult.value;

  const occurrences: Occurrence[] = [];
  const transitions: Transition[] = [];
  // Repetition is counted over the core key, so a transposition inside one game
  // counts -- which is what the threefold rule actually says.
  const seen = new Map<string, number>();

  const record = (ply: number): void => {
    const key = coreKey(position);
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    const fen = makeFen(position.toSetup());
    const [, , , , halfmove, fullmove] = fen.split(" ");
    const halfmoveClock = Number(halfmove);
    occurrences.push({
      ply,
      coreKey: key,
      coreKeyHash: coreKeyHash(key),
      fen,
      halfmoveClock,
      fullmoveNumber: Number(fullmove),
      repetitionCount: count,
      sideToMove: position.turn === "white" ? "w" : "b",
      threefold: count >= 3,
      fivefold: count >= 5,
      // The 50-move rule is claimable at 100 halfmoves; 75 is forced at 150.
      fiftyMoveAvailable: halfmoveClock >= 100,
      seventyFiveMoveForced: halfmoveClock >= 150,
    });
  };

  record(0);

  input.moves.forEach((move, index) => {
    const ply = index + 1;
    const parsed = parseUci(move.uci);
    if (!parsed) throw new ReplayMaterializationError(ply, "unparsable_move");
    if (!position.isLegal(parsed)) throw new ReplayMaterializationError(ply, "illegal_move");
    // SAN must be produced before the move is played: it names the position it
    // was made from.
    const san = makeSan(position, parsed);
    position.play(parsed);
    record(ply);
    transitions.push({
      fromPly: ply - 1,
      toPly: ply,
      uci: move.uci,
      san,
      clockMs: move.clockMs ?? null,
    });
  });

  return {
    occurrences,
    transitions,
    checksum: materializationChecksum(occurrences, transitions),
  };
}

/**
 * A checksum over the whole chain.
 *
 * Deterministic for the same replay and normalizer version, so a rebuild can be
 * compared to its predecessor before any pointer is switched.
 */
export function materializationChecksum(
  occurrences: readonly Occurrence[],
  transitions: readonly Transition[],
): string {
  const canonical = JSON.stringify({
    version: CORE_KEY_VERSION,
    occurrences: occurrences.map((o) => [o.ply, o.coreKeyHash, o.halfmoveClock, o.repetitionCount]),
    transitions: transitions.map((t) => [t.fromPly, t.toPly, t.uci]),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** Verify a chain is unbroken and the right length. Cheap, and worth asserting. */
export function chainIsSound(replay: MaterializedReplay, moveCount: number): boolean {
  if (replay.occurrences.length !== moveCount + 1) return false;
  if (replay.transitions.length !== moveCount) return false;
  for (let index = 0; index < replay.occurrences.length; index += 1) {
    if (replay.occurrences[index].ply !== index) return false;
  }
  for (let index = 0; index < replay.transitions.length; index += 1) {
    const transition = replay.transitions[index];
    if (transition.fromPly !== index || transition.toPly !== index + 1) return false;
  }
  return true;
}
