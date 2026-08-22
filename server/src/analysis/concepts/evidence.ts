/**
 * The board facts every tactical detector reads, and the vocabulary they share.
 *
 * Six detectors are about to be written against this. Without a shared layer
 * each would reparse the same FEN, reimplement "who attacks this square", and
 * disagree with the others in some small way that only shows up as two
 * detectors labelling the same position differently. So the parsing happens
 * once per ply, the attack and ray questions have one answer each, and the
 * replay of a stored engine line has one definition of what "unavailable"
 * means.
 *
 * ## Pure, and deliberately small
 *
 * No database, no engine, no clock. This layer answers questions about a
 * position that is already in memory and replays lines that were already
 * searched and stored. It adds no search of its own -- the project adds no
 * Stockfish call, and a helper here that quietly evaluated something would be
 * that call arriving through the back door.
 *
 * It is also not a framework. There is no rule language, no plugin system and
 * no generic predicate combinator: FOR-125 says the smallest thing the six
 * selected families need, and a DSL for detectors nobody has written yet is a
 * scope failure rather than foresight.
 *
 * ## Why the vocabulary lives here rather than in `detect.ts`
 *
 * `detect.ts` holds detectors; those detectors need this layer; this layer
 * needs the types the detectors produce. Putting the types in `detect.ts` makes
 * that a cycle. They live here, and `detect.ts` re-exports them so nothing
 * downstream has to care which file they came from.
 */

import { attacks, between, ray } from "chessops/attacks";
import { Chess } from "chessops/chess";
import { makeFen, parseFen } from "chessops/fen";
import { SquareSet } from "chessops/squareSet";
import { parseUci } from "chessops/util";
import type { Color, Move, Piece, Role, Square } from "chessops/types";
import { PIECE_VALUES, attackersTo, see } from "../../engine/attacks.js";
import type { ConceptRole, OpportunityDraft } from "../observations.js";

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

/** One assessed move of the game, as the analysis recorded it. */
export interface TransitionFact {
  readonly fromPly: number;
  readonly actorColor: "white" | "black";
  readonly playedMoveUci: string;
  readonly bestMoveUci: string | null;
  readonly playedMoveRank: number | null;
  readonly playedMoveAcceptable: boolean;
  readonly onlyMove: boolean | null;
  readonly criticality: number | null;
  /** How many retained candidates were within tolerance. Null below two lines. */
  readonly acceptableMoveCount: number | null;
  /**
   * How many lines the search that answered the candidate questions retained.
   *
   * Recorded by `engine/assessments.ts` as `difficultyFeatures.retainedLines`.
   * It is what separates "the only move among the four we looked at" from "the
   * only move there is", and without it `only_move` claims the second while
   * knowing the first.
   */
  readonly candidateCount: number | null;
  /** White's perspective, as stored. */
  readonly expectedScoreBefore: number;
  readonly expectedScoreAfter: number;
  readonly phase: string | null;
}

/** The position at each ply, as the materializer recorded it. */
export interface PositionFact {
  readonly ply: number;
  readonly fen: string;
}

/**
 * One line the engine retained at a position, as `evaluation_candidates` stored
 * it.
 *
 * The `pv` is the evidence a detector may use to claim a consequence. It is
 * bounded: the search stopped where it stopped, so a line can be too short to
 * prove what is being asked, and that is an abstention rather than a licence to
 * extrapolate.
 */
export interface CandidateLine {
  readonly rank: number;
  readonly uci: string;
  /** From the actor's perspective, as `engine/assessments.ts` normalises it. */
  readonly expectedScore: number;
  readonly pv: readonly string[];
}

export interface GameFacts {
  readonly subjectColor: "white" | "black";
  readonly speed: string | null;
  readonly playedAt: Date;
  readonly transitions: readonly TransitionFact[];
  readonly positions: readonly PositionFact[];
  /** Why the game stopped, from the provider. Decides how a missing move is censored. */
  readonly termination: string | null;
  /** The winner in board colours, or draw. Needed before naming who resigned. */
  readonly result: "white" | "black" | "draw" | null;
  /**
   * Stored engine lines per ply, where the deep search reached.
   *
   * Empty until FOR-132 loads them: the worker's query is that ticket's work,
   * and a detector that requires a line it was never given abstains, which is
   * the contracted behaviour rather than a gap. Detectors written against this
   * therefore degrade to "no verification available" rather than to a guess.
   */
  readonly candidatesByPly: ReadonlyMap<number, readonly CandidateLine[]>;
}

/**
 * The `chess_events` row a detector is proposing.
 *
 * Shared by every family in this MVP so that one physical occurrence has one
 * shape regardless of which detector saw it.
 */
export interface EventDraft {
  readonly eventType: string;
  readonly startPly: number;
  readonly focalPly: number;
  readonly endPly: number;
  readonly facts: Record<string, unknown>;
  readonly completeness: "complete" | "incomplete" | "censored";
  /**
   * Deterministic identity of the physical occurrence. See `eventKey`.
   *
   * Two observations of the same moment -- recognising a critical position and
   * executing it -- share this, because they are one thing that happened and
   * two things measured about it.
   */
  readonly detectionKey: string;
  /**
   * Who did it, and who it happened to, relative to the subject.
   *
   * Relative rather than absolute so this module stays colour-agnostic: the
   * worker resolves `subject`/`opponent` against the colour the subject
   * actually played. `null` is a real answer and not a gap -- when a position
   * became winning, *who made it winning* is genuinely not established by
   * anything here, and naming the subject as the actor would credit them for an
   * opponent's mistake.
   */
  readonly actor: "subject" | "opponent" | null;
  readonly affected: "subject" | "opponent" | null;
  /**
   * How sure the detector is that this occurrence is what it says, 0 to 1.
   *
   * Null when the question does not arise: a position either does or does not
   * have a piece capturable by static exchange, and a number attached to that
   * would be decoration. The tactical families use it to separate a consequence
   * proven by a stored line from one inferred from static exchange alone.
   */
  readonly confidence: number | null;
}

/** An observation, plus everything the row around it needs. */
export interface DetectedOpportunity {
  readonly conceptSlug: string;
  readonly role: ConceptRole;
  readonly draft: OpportunityDraft;
  readonly phase: string | null;
  readonly event: EventDraft;
}

/**
 * The generation of detector logic that produced a label.
 *
 * Recorded on every `event_concepts` row. Distinct from a concept version: the
 * concept version says what the rule *is*, this says which build applied it, so
 * a label that turns out to be wrong can be traced to the code that wrote it
 * without redefining what the concept means. Bump it when detection behaviour
 * changes, which is not the same event as bumping a contract.
 */
export const DETECTOR_VERSION = "2";

/**
 * The identity of a physical occurrence, stable across runs.
 *
 * Deliberately excludes the role, the concept and the detector version. A fork
 * is one fork whether it is labelled once or three times, and it is still the
 * same fork after the detector that named it is corrected -- so a later version
 * attaches another label to this event rather than claiming a second fork
 * happened at the same ply.
 *
 * `discriminator` is for the families that can produce two genuinely different
 * occurrences of the same type on the same ply: one move can create two pins.
 */
export function eventKey(
  eventType: string,
  focalPly: number,
  discriminator?: string,
): string {
  return discriminator === undefined
    ? `${eventType}:${focalPly}`
    : `${eventType}:${focalPly}:${discriminator}`;
}

/** Confidence attached to a claim, by what proved it. */
export const CONFIDENCE = Object.freeze({
  /** A stored engine line was replayed and shows the consequence. */
  pvProven: 0.9,
  /** Static exchange alone says the material follows. */
  seeOnly: 0.6,
});

// ---------------------------------------------------------------------------
// Squares
// ---------------------------------------------------------------------------

const fileOf = (square: Square): number => square & 7;
const rankOf = (square: Square): number => square >> 3;

/**
 * The single-square step that walks from `from` towards `to`, or null when the
 * two are not on a shared rank, file or diagonal.
 *
 * `ray` already answers "are these aligned", but a detector that wants the
 * piece *behind* another one has to walk, and walking needs the direction.
 */
export function rayStep(from: Square, to: Square): number | null {
  const df = fileOf(to) - fileOf(from);
  const dr = rankOf(to) - rankOf(from);
  if (df === 0 && dr === 0) return null;
  if (!(df === 0 || dr === 0 || Math.abs(df) === Math.abs(dr))) return null;
  return Math.sign(dr) * 8 + Math.sign(df);
}

/**
 * Walk outward from `from` past `through`, returning the squares in order until
 * the board edge.
 *
 * Edge detection is by file distance rather than by index range: stepping east
 * off h-file lands on the next rank's a-file, which is a legal square index and
 * a completely different part of the board. Every "my ray helper wrapped around
 * the board" bug is this one.
 */
export function squaresBeyond(from: Square, through: Square): Square[] {
  const step = rayStep(from, through);
  if (step === null) return [];
  const walked: Square[] = [];
  let previous = through;
  let current = through + step;
  while (current >= 0 && current < 64 && Math.abs(fileOf(current) - fileOf(previous)) <= 1) {
    walked.push(current as Square);
    previous = current;
    current += step;
  }
  return walked;
}

// ---------------------------------------------------------------------------
// Pins and x-rays
// ---------------------------------------------------------------------------

export interface PinFact {
  /** The piece that cannot move without exposing what is behind it. */
  readonly pinned: Square;
  /** The slider doing the pinning. */
  readonly pinner: Square;
  /** The king, for an absolute pin; a more valuable piece, for a relative one. */
  readonly target: Square;
  readonly subtype: "absolute" | "relative";
  /** Squares strictly between pinner and target, which is where the pinned piece stands. */
  readonly ray: readonly Square[];
}

export interface XrayFact {
  /** The slider looking through something. */
  readonly attacker: Square;
  /** The first piece on the ray. */
  readonly front: Square;
  /** The next piece behind it on the same ray. */
  readonly rear: Square;
}

// ---------------------------------------------------------------------------
// One position, parsed once
// ---------------------------------------------------------------------------

/**
 * A legal position and the questions detectors ask about it.
 *
 * Every answer is derived from the board rather than cached ahead of time,
 * except the parse itself -- which is the expensive part and the one thing
 * `PositionIndex` guarantees happens once per ply.
 */
export class PositionView {
  readonly ply: number;
  readonly fen: string;
  readonly position: Chess;

  constructor(ply: number, fen: string, position: Chess) {
    this.ply = ply;
    this.fen = fen;
    this.position = position;
  }

  get turn(): Color {
    return this.position.turn;
  }

  pieceAt(square: Square): Piece | undefined {
    return this.position.board.get(square);
  }

  /** Material value in centipawns, or 0 on an empty square. */
  valueAt(square: Square): number {
    const piece = this.pieceAt(square);
    return piece ? PIECE_VALUES[piece.role] : 0;
  }

  /**
   * Every piece of `color` bearing on `square`, whether or not it may legally
   * move there.
   *
   * Pseudo-legal on purpose. "How many defenders does this square have" is a
   * question about exchange sequences, and a pinned defender still participates
   * in one -- the capture that would expose the king is only illegal for the
   * side that is to move. Use `legalMovesTo` for the other question.
   */
  attackersOf(square: Square, color: Color): SquareSet {
    const own = color === "white" ? this.position.board.white : this.position.board.black;
    return attackersTo(this.position.board, square, this.position.board.occupied).intersect(own);
  }

  /** Pieces of the occupant's own colour bearing on it. Empty for an empty square. */
  defendersOf(square: Square): SquareSet {
    const occupant = this.pieceAt(square);
    if (!occupant) return SquareSet.empty();
    return this.attackersOf(square, occupant.color).without(square);
  }

  /** Squares the piece on `square` attacks, ignoring legality of moving there. */
  attacksFrom(square: Square): SquareSet {
    const piece = this.pieceAt(square);
    if (!piece) return SquareSet.empty();
    return attacks(piece, square, this.position.board.occupied);
  }

  /** Legal destinations for the piece on `square`, for the side to move. */
  destsFrom(square: Square): SquareSet {
    return this.position.dests(square);
  }

  /** Squares from which the side to move can legally move a piece onto `square`. */
  legalMovesTo(square: Square): SquareSet {
    let found = SquareSet.empty();
    for (const [from, dests] of this.position.allDests()) {
      if (dests.has(square)) found = found.with(from);
    }
    return found;
  }

  isLegal(move: Move): boolean {
    return this.position.isLegal(move);
  }

  see(to: Square, from: Square): number {
    return see(this.position.board, to, from);
  }

  /**
   * How many legal moves the side to move has, counted as the engine counts
   * them.
   *
   * `allDests` is a square set, so it collapses the four promotion choices onto
   * one destination while MultiPV lists each separately. Only-move coverage
   * compares this against a retained-line count, so a promotion position would
   * otherwise look fully searched when it was not.
   */
  legalMoveCount(): number {
    let total = 0;
    for (const [from, dests] of this.position.allDests()) {
      total += dests.size();
      if (!this.position.board.pawn.has(from)) continue;
      for (const to of dests) {
        const rank = rankOf(to);
        if (rank === 0 || rank === 7) total += 3;
      }
    }
    return total;
  }

  /** Squares strictly between two aligned squares; empty when they are not aligned. */
  between(a: Square, b: Square): SquareSet {
    return between(a, b);
  }

  aligned(a: Square, b: Square): boolean {
    return !ray(a, b).isEmpty();
  }

  /**
   * Every pin against `color`.
   *
   * Absolute pins come from the position's own check context, which is the
   * same computation legal move generation uses -- so "this piece is pinned to
   * the king" and "this piece has no legal moves along that line" cannot
   * disagree.
   *
   * Relative pins are found by walking: an enemy slider, one piece of `color`
   * on the ray with nothing else between, and behind it a more valuable piece
   * of `color`. Value is what makes it a pin rather than an alignment; two
   * knights in a line are not pinning each other.
   */
  pinsAgainst(color: Color): PinFact[] {
    const board = this.position.board;
    const king = board.kingOf(color);
    const own = color === "white" ? board.white : board.black;
    const enemySliders = (color === "white" ? board.black : board.white)
      .intersect(board.rooksAndQueens().union(board.bishopsAndQueens()));

    const found: PinFact[] = [];
    for (const pinner of enemySliders) {
      const attacked = this.attacksFrom(pinner);
      for (const pinned of attacked.intersect(own)) {
        // The first thing behind the attacked piece, along the same ray.
        let target: Square | null = null;
        for (const square of squaresBeyond(pinner, pinned)) {
          if (board.occupied.has(square)) {
            target = square;
            break;
          }
        }
        if (target === null || !own.has(target)) continue;

        const isKing = king !== undefined && target === king;
        if (!isKing && this.valueAt(target) <= this.valueAt(pinned)) continue;

        found.push({
          pinned,
          pinner,
          target,
          subtype: isKing ? "absolute" : "relative",
          ray: [...between(pinner, target)],
        });
      }
    }
    return found.sort((a, b) => a.pinner - b.pinner || a.pinned - b.pinned);
  }

  /**
   * What the slider on `square` is looking through.
   *
   * A skewer, a discovered attack and a removal-of-defender all turn on the
   * same fact: there is a second piece behind the first one. This reports it
   * without judging which of those it is.
   */
  xraysFrom(square: Square): XrayFact[] {
    const piece = this.pieceAt(square);
    if (!piece || (piece.role !== "rook" && piece.role !== "bishop" && piece.role !== "queen")) {
      return [];
    }
    const board = this.position.board;
    const found: XrayFact[] = [];
    for (const front of this.attacksFrom(square).intersect(board.occupied)) {
      for (const behind of squaresBeyond(square, front)) {
        if (!board.occupied.has(behind)) continue;
        found.push({ attacker: square, front, rear: behind });
        break;
      }
    }
    return found.sort((a, b) => a.front - b.front);
  }
}

// ---------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------

/**
 * Every position of one game, parsed at most once each.
 *
 * The detectors ask about the same handful of plies repeatedly -- the position
 * before a move, the position after it, the position a stored line starts from
 * -- and parsing a FEN is by far the most expensive thing any of them does. A
 * ply whose FEN is missing or does not describe a legal position resolves to
 * null and stays null; that is an abstention, and re-deriving it each time
 * would only be a slower way to abstain.
 */
export class PositionIndex {
  private readonly fens: ReadonlyMap<number, string>;
  private readonly views = new Map<number, PositionView | null>();
  /** How many FENs have actually been parsed. Asserted by the unit gate. */
  private parses = 0;

  constructor(positions: readonly PositionFact[]) {
    this.fens = new Map(positions.map((position) => [position.ply, position.fen]));
  }

  fenAt(ply: number): string | null {
    return this.fens.get(ply) ?? null;
  }

  at(ply: number): PositionView | null {
    const cached = this.views.get(ply);
    if (cached !== undefined) return cached;

    const fen = this.fens.get(ply);
    const view = fen === undefined ? null : this.parse(ply, fen);
    this.views.set(ply, view);
    return view;
  }

  /**
   * A position with a chosen side to move, for questions asked out of turn.
   *
   * "Is my piece hanging?" is asked while the subject is on move and is a
   * question about what the opponent could do next. Flipping the turn can
   * produce something that is not a position at all -- if the side that just
   * moved is left in check -- and `Chess.fromSetup` rejects it, which is the
   * right answer rather than an obstacle.
   *
   * Not cached: it is derived from a cached FEN and is asked far less often
   * than the position itself.
   */
  asIfToMove(ply: number, mover: Color): PositionView | null {
    const fen = this.fens.get(ply);
    if (fen === undefined) return null;
    const parsed = parseFen(fen);
    if (parsed.isErr) return null;
    const setup = parsed.unwrap();
    if (setup.turn !== mover) {
      setup.turn = mover;
      setup.epSquare = undefined;
    }
    this.parses += 1;
    const position = Chess.fromSetup(setup);
    return position.isErr ? null : new PositionView(ply, fen, position.unwrap());
  }

  /** How many FENs this index has parsed, for the reuse assertion. */
  get parseCount(): number {
    return this.parses;
  }

  private parse(ply: number, fen: string): PositionView | null {
    this.parses += 1;
    const parsed = parseFen(fen);
    if (parsed.isErr) return null;
    const position = Chess.fromSetup(parsed.unwrap());
    return position.isErr ? null : new PositionView(ply, fen, position.unwrap());
  }
}

// ---------------------------------------------------------------------------
// Replaying what the engine already searched
// ---------------------------------------------------------------------------

/** Why a stored line could not be used as evidence. */
export type PvUnavailable =
  /** No line was stored for this position at all. */
  | "no_line"
  /** The position the line starts from is missing or not legal. */
  | "position_unreadable"
  /** A move in the line is not valid UCI. */
  | "unparseable_move"
  /** A move in the line is not legal in the position it reached. */
  | "illegal_move"
  /** The line is shorter than the claim being made needs. */
  | "line_too_short";

export type PvEvidence =
  | {
    readonly available: true;
    readonly moves: readonly Move[];
    /** One more than `moves`: the position before each move, then the final one. */
    readonly fens: readonly string[];
    readonly positions: readonly Chess[];
  }
  | { readonly available: false; readonly reason: PvUnavailable };

/**
 * Replay a stored principal variation from a position.
 *
 * The whole point is that it refuses. A principal variation is bounded evidence
 * -- the search stopped where it stopped, and a truncated or malformed line is
 * routine rather than exceptional -- so this returns a named reason instead of
 * a partial replay. A detector handed "here are the first two moves of a line
 * that does not support your claim" will use them; a detector handed
 * `illegal_move` cannot.
 *
 * `minimumPlies` lets a caller say how much line its claim needs, so "the line
 * exists but proves nothing" is answered here rather than by each detector
 * counting moves for itself.
 */
export function replayPv(
  view: PositionView | null,
  pv: readonly string[] | undefined,
  minimumPlies = 1,
): PvEvidence {
  if (!view) return { available: false, reason: "position_unreadable" };
  if (!pv || pv.length === 0) return { available: false, reason: "no_line" };
  if (pv.length < minimumPlies) return { available: false, reason: "line_too_short" };

  const moves: Move[] = [];
  const positions: Chess[] = [];
  const fens: string[] = [view.fen];
  let current = view.position.clone();
  positions.push(current);

  for (const uci of pv) {
    const move = parseUci(uci);
    if (!move) return { available: false, reason: "unparseable_move" };
    if (!current.isLegal(move)) return { available: false, reason: "illegal_move" };
    current = current.clone();
    current.play(move);
    moves.push(move);
    positions.push(current);
    fens.push(makeFen(current.toSetup()));
  }
  return { available: true, moves, fens, positions };
}

/** The best stored line at a ply, by rank. */
export function bestCandidate(
  game: GameFacts,
  ply: number,
): CandidateLine | null {
  const lines = game.candidatesByPly.get(ply);
  if (!lines || lines.length === 0) return null;
  return [...lines].sort((a, b) => a.rank - b.rank)[0] ?? null;
}

/** The stored line that begins with a particular move, if the search kept one. */
export function candidateFor(
  game: GameFacts,
  ply: number,
  uci: string,
): CandidateLine | null {
  const lines = game.candidatesByPly.get(ply);
  return lines?.find((line) => line.uci === uci) ?? null;
}

// ---------------------------------------------------------------------------
// The detector registry
// ---------------------------------------------------------------------------

/** Everything a detector is allowed to read. */
export interface DetectorContext {
  readonly game: GameFacts;
  readonly index: PositionIndex;
}

/**
 * One family's detector.
 *
 * A plain function behind a name, listed explicitly in `detect.ts`. Not a
 * registry that discovers implementations, not a priority system, not a rule
 * language: the order is a written list because six detectors in a fixed order
 * is a list, and anything more would be a framework for detectors that do not
 * exist yet.
 */
export interface Detector {
  readonly name: string;
  readonly detect: (context: DetectorContext) => DetectedOpportunity[];
}

/** Roles used by the tactical families. See the contract matrix. */
export const TACTICAL_ROLES: readonly ConceptRole[] = ["execute", "respond"];

export type { Color, Move, Piece, Role, Square };
export { PIECE_VALUES };
