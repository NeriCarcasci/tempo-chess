/**
 * Turning one analysed game into observations.
 *
 * Pure. Everything here takes the facts the pipeline already produced -- the
 * moves, the positions, and the engine's transition assessments -- and returns
 * drafts. No database, no engine, no clock, so the whole detector can be
 * exhausted in a unit test, which is the property `analysis/observations.ts`
 * was written for and never got to use.
 *
 * ## The two rules that shape all of this
 *
 * **A move nobody made is censored, not failed.** The subject only gets an
 * observation for a position they were actually to move in. When a game ends
 * before they could answer -- the opponent resigned into a winning position,
 * the replay stopped -- the opportunity is recorded with a reason and no
 * success value. Counting those as failures is how an estimate blames a player
 * for someone else's decision, and §17.5 forbids it.
 *
 * **Difficulty is computed from the position, never from the outcome.** Every
 * difficulty vector below is derived from what was on the board before the
 * response. `difficultyIsUncontaminated` checks the obvious violation and the
 * detector must not need it to.
 */

import { Chess } from "chessops/chess";
import { parseFen } from "chessops/fen";
import { parseUci } from "chessops/util";
import type { Square } from "chessops/types";
import { see } from "../../engine/attacks.js";
import type { CensorReason, ConceptRole, OpportunityDraft } from "../observations.js";
import {
  CRITICALITY_THRESHOLD,
  MATERIAL_THRESHOLD_CP,
  WINNING_THRESHOLD,
  WORSE_THRESHOLD,
} from "./catalogue.js";

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

export interface GameFacts {
  readonly subjectColor: "white" | "black";
  readonly speed: string | null;
  readonly playedAt: Date;
  readonly transitions: readonly TransitionFact[];
  readonly positions: readonly PositionFact[];
  /** Why the game stopped, from the provider. Decides how a missing move is censored. */
  readonly termination: string | null;
}

/** An observation, plus everything the row around it needs. */
export interface DetectedOpportunity {
  readonly conceptSlug: string;
  readonly role: ConceptRole;
  readonly draft: OpportunityDraft;
  readonly phase: string | null;
  /** For the `chess_events` row this opportunity hangs from. */
  readonly event: {
    readonly eventType: string;
    readonly startPly: number;
    readonly focalPly: number;
    readonly endPly: number;
    readonly facts: Record<string, unknown>;
    readonly completeness: "complete" | "incomplete" | "censored";
    /**
     * Deterministic identity of the physical occurrence. See `eventKey`.
     *
     * Two observations of the same moment -- recognising a critical position
     * and executing it -- share this, because they are one thing that happened
     * and two things measured about it.
     */
    readonly detectionKey: string;
    /**
     * Who did it, and who it happened to, relative to the subject.
     *
     * Relative rather than absolute so this module stays colour-agnostic: the
     * worker resolves `subject`/`opponent` against the colour the subject
     * actually played. `null` is a real answer and not a gap -- when a position
     * became winning, *who made it winning* is genuinely not established by
     * anything here, and naming the subject as the actor would credit them for
     * an opponent's mistake.
     */
    readonly actor: "subject" | "opponent" | null;
    readonly affected: "subject" | "opponent" | null;
  };
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

/** One physical occurrence and everything measured about it. */
export interface EventGroup {
  readonly event: DetectedOpportunity["event"];
  readonly observations: readonly DetectedOpportunity[];
}

/**
 * Group observations by the occurrence they are about.
 *
 * The detector emits an observation at a time because that is the unit it
 * reasons in, but the database stores an occurrence at a time: one
 * `chess_events` row, then a `event_concepts` label per concept version and
 * role. Doing that grouping here rather than inside the worker keeps it pure
 * and testable, and keeps the worker's job to writing rows.
 *
 * Insertion order is preserved, so the row order of two runs over one game is
 * the same and a diff between them means something changed.
 */
export function groupByEvent(detected: readonly DetectedOpportunity[]): EventGroup[] {
  const groups = new Map<string, { event: DetectedOpportunity["event"]; observations: DetectedOpportunity[] }>();
  for (const observation of detected) {
    const existing = groups.get(observation.event.detectionKey);
    if (existing) {
      existing.observations.push(observation);
      continue;
    }
    groups.set(observation.event.detectionKey, {
      event: observation.event,
      observations: [observation],
    });
  }
  return [...groups.values()];
}

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
 * The current six cannot, so they leave it out and the key is type and ply.
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

const opposite = (color: "white" | "black"): "white" | "black" =>
  color === "white" ? "black" : "white";

/** The subject's own expected score, from White's stored perspective. */
function fromSubject(whiteExpectedScore: number, subjectColor: "white" | "black"): number {
  return subjectColor === "white" ? whiteExpectedScore : 1 - whiteExpectedScore;
}

interface BoardCapture {
  readonly from: Square;
  readonly to: Square;
  readonly gain: number;
}

/**
 * The best capture available to `mover` in this position, by static exchange.
 *
 * Legality is checked, so a capture that would leave the king in check is not
 * counted as material on offer -- a pin is a real reason a piece is not free,
 * and calling it free would mark a player down for respecting it.
 *
 * Two things this has to get right, and both were wrong first time:
 *
 * **Castling is not a capture.** `allDests` encodes castling as the king moving
 * onto its own rook's square, so "the destination is occupied" is not the same
 * question as "this takes something". Without the colour check, every position
 * where castling was still legal reported a free rook -- which is most
 * positions in most games, and would have made the measurement worthless in a
 * way that still produced plausible-looking numbers.
 *
 * **The side asked about is not always the side to move.** "Is my piece
 * hanging?" is asked while the subject is on move, and it is a question about
 * what the opponent could do next. So the position is rebuilt with `mover` to
 * move. That can be an illegal setup -- if the side that just moved is left in
 * check -- and an illegal position is not one to reason about, so it answers
 * null rather than guessing.
 */
function bestCapture(fen: string, mover: "white" | "black"): BoardCapture | null {
  const parsed = parseFen(fen);
  if (parsed.isErr) return null;
  const setup = parsed.unwrap();
  if (setup.turn !== mover) {
    setup.turn = mover;
    // A side to move who could capture the enemy king is not a position; it is
    // an artefact of flipping the turn. `fromSetup` rejects it, which is right.
    setup.epSquare = undefined;
  }
  const position = Chess.fromSetup(setup);
  if (position.isErr) return null;
  const board = position.unwrap();

  let best: BoardCapture | null = null;
  for (const [from, dests] of board.allDests()) {
    for (const to of dests) {
      const target = board.board.get(to);
      // Castling appears here as king-onto-own-rook. It takes nothing.
      if (!target || target.color === mover) continue;
      const gain = see(board.board, to, from);
      if (gain < MATERIAL_THRESHOLD_CP) continue;
      if (!best || gain > best.gain) best = { from, to, gain };
    }
  }
  return best;
}

/** Whether the opponent could win material if it were their move. */
function materialHanging(fen: string, opponent: "white" | "black"): BoardCapture | null {
  return bestCapture(fen, opponent);
}

/**
 * What `mover` could win by capturing the piece standing on `target`.
 *
 * The question `material_safety` actually needs. v1 asked the much broader "is
 * anything of mine hanging now", which meant saving the attacked knight scored
 * as a failure if an unrelated pawn had become loose in the meantime -- the
 * player did the thing being measured and was marked down for something else.
 *
 * Null when the position cannot be built, which is not the same as zero: an
 * unreadable board is a reason to abstain, and reporting "nothing is hanging"
 * from one would be a measurement invented out of a parse error.
 */
function exposureOn(
  fen: string,
  mover: "white" | "black",
  target: Square,
): number | null {
  const parsed = parseFen(fen);
  if (parsed.isErr) return null;
  const setup = parsed.unwrap();
  if (setup.turn !== mover) {
    setup.turn = mover;
    setup.epSquare = undefined;
  }
  const position = Chess.fromSetup(setup);
  if (position.isErr) return null;
  const board = position.unwrap();

  const occupant = board.board.get(target);
  if (!occupant || occupant.color === mover) return 0;

  let best = 0;
  for (const [from, dests] of board.allDests()) {
    if (!dests.has(target)) continue;
    const gain = see(board.board, target, from);
    if (gain > best) best = gain;
  }
  return best;
}

/**
 * Where a piece standing on `square` ended up after `uci` was played.
 *
 * The piece is what is being tracked, not the square. If the subject moved the
 * exposed piece to safety, the exposure question has to follow it there;
 * asking about the square it left would report every rescue as a success
 * regardless of where the piece went.
 */
function squareAfterMove(uci: string, square: Square): Square {
  const move = parseUci(uci);
  if (!move || !("from" in move)) return square;
  return move.from === square ? move.to : square;
}

/** How many legal moves the side to move has, or null if the position is unreadable. */
function legalMoveCount(fen: string): number | null {
  const parsed = parseFen(fen);
  if (parsed.isErr) return null;
  const position = Chess.fromSetup(parsed.unwrap());
  if (position.isErr) return null;
  let total = 0;
  for (const [, dests] of position.unwrap().allDests()) total += dests.size();
  return total;
}

/**
 * Did the move played actually win material?
 *
 * Not "was it the best capture" and not "was it a capture at all": the question
 * is whether the offer was taken. A different capture that also wins material
 * counts, because the concept is about seeing that something was there.
 */
function capturedMaterial(fen: string, uci: string, mover: "white" | "black"): boolean {
  const move = parseUci(uci);
  if (!move || !("from" in move)) return false;
  const parsed = parseFen(fen);
  if (parsed.isErr) return false;
  const position = Chess.fromSetup(parsed.unwrap());
  if (position.isErr) return false;
  const board = position.unwrap().board;
  const target = board.get(move.to);
  if (!target || target.color === mover) return false;
  return see(board, move.to, move.from) >= MATERIAL_THRESHOLD_CP;
}

function positionAt(positions: readonly PositionFact[], ply: number): string | null {
  return positions.find((position) => position.ply === ply)?.fen ?? null;
}

/**
 * Why the subject never answered.
 *
 * Read from the provider's own termination rather than guessed. "The game
 * ended" is the honest fallback when the provider said something this does not
 * recognise -- inventing `opponent_resigned` from silence would attribute a
 * decision to a person who may not have made it.
 */
function censorFor(termination: string | null): CensorReason {
  if (termination === "resign") return "opponent_resigned";
  if (termination === "outoftime" || termination === "timeout") return "clock_expired";
  return "game_ended";
}

// ---------------------------------------------------------------------------
// Board-derived concepts
// ---------------------------------------------------------------------------

function detectMaterial(game: GameFacts): DetectedOpportunity[] {
  const found: DetectedOpportunity[] = [];
  const opponent = opposite(game.subjectColor);

  for (const transition of game.transitions) {
    if (transition.actorColor !== game.subjectColor) continue;
    const before = positionAt(game.positions, transition.fromPly);
    const after = positionAt(game.positions, transition.fromPly + 1);
    if (before === null || after === null) continue;

    // Was a piece of the subject's hanging, and did they deal with *that piece*?
    const exposed = materialHanging(before, opponent);
    if (exposed) {
      const landedOn = squareAfterMove(transition.playedMoveUci, exposed.to);
      const remaining = exposureOn(after, opponent, landedOn);
      // An unreadable resulting position is a reason to say nothing, not a
      // reason to say the piece was saved.
      if (remaining !== null) {
        const resolved = remaining < MATERIAL_THRESHOLD_CP;
        // A piece still hanging after a move the engine judged sound is a
        // sacrifice, and calling it a blunder would mark a player down for
        // playing well. Static exchange cannot see the compensation, so this
        // abstains instead of guessing which one it is looking at.
        const soundSacrifice = !resolved && transition.playedMoveAcceptable;
        if (!soundSacrifice) {
          found.push({
            conceptSlug: "material_safety",
            role: "respond",
            phase: transition.phase,
            draft: {
              role: "respond",
              opportunityPly: transition.fromPly,
              responsePly: transition.fromPly,
              responseObserved: true,
              censoredReason: null,
              success: resolved,
              score: null,
              rubricComponentVersionId: null,
              // From the position before the move: how much was at stake, and
              // how many replies there were to choose between.
              difficulty: {
                materialAtRiskCp: exposed.gain,
                legalReplies: legalMoveCount(before) ?? 0,
              },
            },
            event: {
              eventType: "material_exposed",
              startPly: transition.fromPly,
              focalPly: transition.fromPly,
              detectionKey: eventKey("material_exposed", transition.fromPly),
              actor: "opponent",
              affected: "subject",
              endPly: transition.fromPly + 1,
              facts: {
                square: exposed.to,
                atRiskCp: exposed.gain,
                squareAfter: landedOn,
                remainingCp: remaining,
                resolved,
              },
              completeness: "complete",
            },
          });
        }
      }
    }

    // Was something of the opponent's free, and did they take it?
    const offered = bestCapture(before, game.subjectColor);
    if (offered) {
      const tookIt = capturedMaterial(before, transition.playedMoveUci, game.subjectColor);
      // Taking it is one way to pass. Playing something the engine rates within
      // tolerance is another: a mate in one, a zwischenzug that wins more, a
      // stronger recapture. v1 called all of those failures to see free
      // material, which is the opposite of what happened.
      const playedSomethingBetter = !tookIt && transition.playedMoveAcceptable;
      found.push({
        conceptSlug: "free_material",
        role: "recognize",
        phase: transition.phase,
        draft: {
          role: "recognize",
          opportunityPly: transition.fromPly,
          responsePly: transition.fromPly,
          responseObserved: true,
          censoredReason: null,
          success: tookIt || playedSomethingBetter,
          score: null,
          rubricComponentVersionId: null,
          difficulty: {
            materialOnOfferCp: offered.gain,
            legalReplies: legalMoveCount(before) ?? 0,
          },
        },
        event: {
          eventType: "material_offered",
          startPly: transition.fromPly,
          focalPly: transition.fromPly,
          detectionKey: eventKey("material_offered", transition.fromPly),
          actor: "subject",
          affected: "opponent",
          endPly: transition.fromPly + 1,
          facts: {
            square: offered.to,
            onOfferCp: offered.gain,
            taken: tookIt,
            playedSomethingBetter,
          },
          completeness: "complete",
        },
      });
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Engine-derived concepts
// ---------------------------------------------------------------------------

function decisionConcepts(game: GameFacts): DetectedOpportunity[] {
  const found: DetectedOpportunity[] = [];

  for (const transition of game.transitions) {
    if (transition.actorColor !== game.subjectColor) continue;
    const subjectBefore = fromSubject(transition.expectedScoreBefore, game.subjectColor);
    const before = positionAt(game.positions, transition.fromPly);
    const legalReplies = before === null ? null : legalMoveCount(before);

    const base = {
      opportunityPly: transition.fromPly,
      responsePly: transition.fromPly,
      responseObserved: true as const,
      censoredReason: null,
      score: null,
      rubricComponentVersionId: null,
    };

    // A criticality below the threshold is a position where every line the
    // search retained said much the same thing, which is not a moment that
    // decided anything. v1 had no threshold at all, so this fired wherever the
    // deep search happened to run.
    if (transition.criticality !== null && transition.criticality >= CRITICALITY_THRESHOLD) {
      const difficulty: Record<string, number> = {
        criticality: transition.criticality,
        expectedScoreBefore: subjectBefore,
      };
      // Non-null whenever criticality is -- both come from the same candidate
      // assessment -- but written as a condition rather than defaulted, because
      // a zero invented for a missing count would be a real-looking number.
      if (transition.acceptableMoveCount !== null) {
        difficulty.acceptableMoveCount = transition.acceptableMoveCount;
      }
      // One occurrence, described once. Both observations share these facts so
      // that whichever is written first describes the moment completely.
      const facts = {
        criticality: transition.criticality,
        rank: transition.playedMoveRank,
        acceptable: transition.playedMoveAcceptable,
        acceptableMoveCount: transition.acceptableMoveCount,
      };
      const event = {
        eventType: "critical_moment",
        startPly: transition.fromPly,
        focalPly: transition.fromPly,
        endPly: transition.fromPly + 1,
        detectionKey: eventKey("critical_moment", transition.fromPly),
        actor: "subject" as const,
        affected: "subject" as const,
        facts,
        completeness: "complete" as const,
      };
      // Two observations, deliberately. Whether the move played was one the
      // search took seriously and whether it was good enough are different
      // facts, and a single accuracy number describes neither.
      found.push({
        conceptSlug: "critical_moment",
        role: "recognize",
        phase: transition.phase,
        draft: { ...base, role: "recognize", success: transition.playedMoveRank !== null, difficulty },
        event,
      });
      found.push({
        conceptSlug: "critical_moment",
        role: "execute",
        phase: transition.phase,
        draft: { ...base, role: "execute", success: transition.playedMoveAcceptable, difficulty },
        event,
      });
    }

    if (transition.onlyMove === true) {
      // `only_move` is computed over the candidates the search *retained*, so
      // "everything else lost ground" is a claim about the moves examined. It
      // is only a claim about every legal move when the search examined every
      // legal move, and the coverage fact is what says which of those this is.
      const coverage =
        transition.candidateCount !== null
        && legalReplies !== null
        && transition.candidateCount >= legalReplies
          ? "absolute"
          : "searched";
      const difficulty: Record<string, number> = { expectedScoreBefore: subjectBefore };
      if (legalReplies !== null) difficulty.legalReplies = legalReplies;
      found.push({
        conceptSlug: "only_move",
        role: "recognize",
        phase: transition.phase,
        draft: {
          ...base,
          role: "recognize",
          success: transition.playedMoveAcceptable,
          difficulty,
        },
        event: {
          eventType: "only_move",
          startPly: transition.fromPly,
          focalPly: transition.fromPly,
          detectionKey: eventKey("only_move", transition.fromPly),
          actor: "subject",
          affected: "subject",
          endPly: transition.fromPly + 1,
          facts: {
            acceptable: transition.playedMoveAcceptable,
            coverage,
            candidateCount: transition.candidateCount,
            legalMoveCount: legalReplies,
          },
          completeness: "complete",
        },
      });
    }

    if (subjectBefore <= WORSE_THRESHOLD) {
      found.push({
        conceptSlug: "worse_position_defence",
        role: "respond",
        phase: transition.phase,
        draft: {
          ...base,
          role: "respond",
          success: transition.playedMoveAcceptable,
          difficulty: { expectedScoreBefore: subjectBefore },
        },
        event: {
          eventType: "defending_worse",
          startPly: transition.fromPly,
          focalPly: transition.fromPly,
          detectionKey: eventKey("defending_worse", transition.fromPly),
          actor: "subject",
          affected: "subject",
          endPly: transition.fromPly + 1,
          facts: { expectedScoreBefore: subjectBefore },
          completeness: "complete",
        },
      });
    }
  }
  return found;
}

/**
 * One observation per game: did a winning position stay won?
 *
 * The censored branch is the interesting one. If the subject reached a winning
 * position and then never moved again, they did not fail to convert -- the
 * opponent resigned, or the game ended. Recording that as a loss would be
 * exactly backwards: resigning against you is not evidence you play badly.
 */
function conversionConcept(game: GameFacts): DetectedOpportunity[] {
  const subjectMoves = game.transitions.filter(
    (transition) => transition.actorColor === game.subjectColor,
  );
  if (subjectMoves.length === 0) return [];

  const reached = game.transitions.find(
    (transition) => fromSubject(transition.expectedScoreAfter, game.subjectColor) >= WINNING_THRESHOLD,
  );
  if (!reached) return [];

  const after = subjectMoves.filter((move) => move.fromPly > reached.fromPly);
  const last = after[after.length - 1];
  // The position that is winning is the one *after* the transition that crossed
  // the threshold. v1 used `reached.fromPly`, which is the position the subject
  // moved from -- one ply before anything was won -- so every conversion
  // opportunity was recorded as beginning in a position that was not yet
  // winning.
  const winningPly = reached.fromPly + 1;
  const difficulty = {
    expectedScoreAtWin: fromSubject(reached.expectedScoreAfter, game.subjectColor),
    movesRemaining: after.length,
  };

  if (!last) {
    return [{
      conceptSlug: "winning_conversion",
      role: "convert",
      phase: reached.phase,
      draft: {
        role: "convert",
        opportunityPly: winningPly,
        responsePly: null,
        responseObserved: false,
        censoredReason: censorFor(game.termination),
        success: null,
        score: null,
        rubricComponentVersionId: null,
        difficulty,
      },
      event: {
        eventType: "winning_position_reached",
        startPly: winningPly,
        focalPly: winningPly,
        detectionKey: eventKey("winning_position_reached", winningPly),
        actor: null,
        affected: "subject",
        endPly: winningPly,
        facts: { converted: null, censored: censorFor(game.termination) },
        completeness: "censored",
      },
    }];
  }

  const held = fromSubject(last.expectedScoreAfter, game.subjectColor) >= WINNING_THRESHOLD;
  return [{
    conceptSlug: "winning_conversion",
    role: "convert",
    phase: last.phase,
    draft: {
      role: "convert",
      opportunityPly: winningPly,
      responsePly: last.fromPly,
      responseObserved: true,
      censoredReason: null,
      success: held,
      score: null,
      rubricComponentVersionId: null,
      difficulty,
    },
    event: {
      eventType: "winning_position_reached",
      startPly: winningPly,
      focalPly: winningPly,
      endPly: last.fromPly,
      facts: { converted: held, movesPlayed: after.length },
      completeness: "complete",
      // Same key as the censored branch above: the position that became winning
      // is the same occurrence whether or not the subject went on to move in
      // it. Only the observation about it differs.
      detectionKey: eventKey("winning_position_reached", winningPly),
      actor: null,
      affected: "subject",
    },
  }];
}

/**
 * Every observation this game supports.
 *
 * Order is stable -- board concepts by ply, then decision concepts by ply, then
 * the single conversion -- so two runs over the same game write the same rows
 * in the same order and a diff between them means something changed.
 */
export function detectGame(game: GameFacts): DetectedOpportunity[] {
  return [...detectMaterial(game), ...decisionConcepts(game), ...conversionConcept(game)];
}
