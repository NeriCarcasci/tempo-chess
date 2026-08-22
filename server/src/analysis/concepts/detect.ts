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

import { parseUci } from "chessops/util";
import type { CensorReason } from "../observations.js";
import {
  CRITICALITY_THRESHOLD,
  MATERIAL_THRESHOLD_CP,
  WINNING_THRESHOLD,
  WORSE_THRESHOLD,
} from "./catalogue.js";
import {
  DETECTOR_VERSION,
  PIECE_VALUES,
  PositionIndex,
  eventKey,
  type DetectedOpportunity,
  type Detector,
  type DetectorContext,
  type GameFacts,
  type PositionFact,
  type PositionView,
  type Square,
  type TransitionFact,
} from "./evidence.js";
import { TACTICAL_DETECTORS } from "./tactics.js";

// The vocabulary lives in `evidence.ts` -- the detectors need the board layer
// and the board layer needs their types, so one of the two had to own both to
// avoid a cycle. Re-exported here because everything downstream imported them
// from this module and none of it should have to care which file they moved to.
export {
  DETECTOR_VERSION,
  PositionIndex,
  eventKey,
  replayPv,
  bestCandidate,
  candidateFor,
  CONFIDENCE,
} from "./evidence.js";
export type {
  CandidateLine,
  DetectedOpportunity,
  Detector,
  DetectorContext,
  EventDraft,
  GameFacts,
  PinFact,
  PositionFact,
  PositionView,
  TransitionFact,
  XrayFact,
} from "./evidence.js";

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
  readonly targetRole: string;
  readonly attackerCount: number;
  readonly defenderCount: number;
  readonly captureCount: number;
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
 * what the opponent could do next. `PositionIndex.asIfToMove` rebuilds the
 * position with `mover` to move and answers null when that is not a position.
 */
function bestCapture(view: PositionView | null, mover: "white" | "black"): BoardCapture | null {
  if (!view) return null;
  const board = view.position.board;

  let bestMove: { from: Square; to: Square; gain: number; targetRole: string } | null = null;
  let captureCount = 0;
  for (const [from, dests] of view.position.allDests()) {
    for (const to of dests) {
      const target = board.get(to);
      // Castling appears here as king-onto-own-rook. It takes nothing.
      if (!target || target.color === mover) continue;
      const gain = view.see(to, from);
      if (gain < MATERIAL_THRESHOLD_CP) continue;
      captureCount += 1;
      if (!bestMove || gain > bestMove.gain) {
        bestMove = { from, to, gain, targetRole: target.role };
      }
    }
  }
  if (!bestMove) return null;

  return {
    ...bestMove,
    attackerCount: view.legalMovesTo(bestMove.to).size(),
    defenderCount: view.defendersOf(bestMove.to).size(),
    captureCount,
  };
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
  view: PositionView | null,
  mover: "white" | "black",
  target: Square,
): number | null {
  if (!view) return null;
  const occupant = view.pieceAt(target);
  if (!occupant || occupant.color === mover) return 0;

  let best = 0;
  for (const [from, dests] of view.position.allDests()) {
    if (!dests.has(target)) continue;
    const gain = view.see(target, from);
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

/**
 * The position at `ply` with `mover` to move.
 *
 * Prefers the indexed position, which is already parsed and usually has the
 * right side to move anyway. Only a question asked out of turn -- "what could
 * my opponent do here?" -- pays for a rebuild.
 */
function viewToMove(
  index: PositionIndex,
  ply: number,
  mover: "white" | "black",
): PositionView | null {
  const view = index.at(ply);
  if (view && view.turn === mover) return view;
  return index.asIfToMove(ply, mover);
}

/** Did the move played actually win material? */
function capturedMaterial(
  view: PositionView | null,
  uci: string,
  mover: "white" | "black",
): boolean {
  if (!view) return false;
  const move = parseUci(uci);
  if (!move || !("from" in move)) return false;
  if (!view.isLegal(move)) return false;
  const target = view.pieceAt(move.to);
  if (!target || target.color === mover) return false;
  return view.see(move.to, move.from) >= MATERIAL_THRESHOLD_CP;
}


/**
 * Why the subject never answered.
 *
 * Read from the provider's termination and result rather than guessed. "The
 * game ended" is the honest fallback when they do not establish who stopped --
 * a resignation says how the game ended, while the winner says who resigned.
 */
function censorFor(
  termination: string | null,
  result: GameFacts["result"],
  subjectColor: GameFacts["subjectColor"],
): CensorReason {
  // `termination = resign` says how the game ended, not who resigned. Only the
  // winner lets us attribute that decision to the opponent.
  if (termination === "resign" && result === subjectColor) return "opponent_resigned";
  if (termination === "outoftime" || termination === "timeout") return "clock_expired";
  return "game_ended";
}

// ---------------------------------------------------------------------------
// Board-derived concepts
// ---------------------------------------------------------------------------

function detectMaterial({ game, index }: DetectorContext): DetectedOpportunity[] {
  const found: DetectedOpportunity[] = [];
  const opponent = opposite(game.subjectColor);

  for (const transition of game.transitions) {
    if (transition.actorColor !== game.subjectColor) continue;
    const before = index.at(transition.fromPly);
    const after = index.at(transition.fromPly + 1);
    if (!before || !after) continue;

    // Was a piece of the subject's hanging, and did they deal with *that piece*?
    // Asked with the opponent to move: it is a question about what they could
    // do next, not about what is legal for the subject right now.
    const exposed = bestCapture(viewToMove(index, transition.fromPly, opponent), opponent);
    if (exposed) {
      const landedOn = squareAfterMove(transition.playedMoveUci, exposed.to);
      const remaining = exposureOn(
        viewToMove(index, transition.fromPly + 1, opponent),
        opponent,
        landedOn,
      );
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
          const move = parseUci(transition.playedMoveUci);
          const movedFocalPiece = Boolean(move && "from" in move && move.from === exposed.to);
          const removedPrimaryAttacker = Boolean(
            move && "from" in move && move.to === exposed.from,
          );
          const resolution = !resolved
            ? "unresolved"
            : movedFocalPiece
              ? "moved_to_safety"
              : removedPrimaryAttacker
                ? "attacker_removed"
                : "defended_or_blocked";
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
                attackerCount: exposed.attackerCount,
                defenderCount: exposed.defenderCount,
                legalReplies: before.legalMoveCount(),
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
                piece: exposed.targetRole,
                atRiskCp: exposed.gain,
                squareAfter: landedOn,
                remainingCp: remaining,
                resolved,
                resolution,
              },
              completeness: "complete",
              confidence: null,
            },
          });
        }
      }
    }

    // Was something of the opponent's free, and did they take it?
    const offered = bestCapture(
      viewToMove(index, transition.fromPly, game.subjectColor),
      game.subjectColor,
    );
    if (offered) {
      const tookIt = capturedMaterial(before, transition.playedMoveUci, game.subjectColor);
      // Taking it is one way to pass. Playing something the engine rates within
      // tolerance is another: a mate in one, a zwischenzug that wins more, a
      // stronger recapture. v1 called all of those failures to see free
      // material, which is the opposite of what happened.
      const alternativeVerified = !tookIt && transition.playedMoveAcceptable;
      // Being outside tolerance does not prove this offer was the missed
      // alternative. The engine may have found a much stronger quiet move. A
      // failure is defensible when its own best move is a material-winning
      // capture; otherwise this detector abstains.
      const captureWasEngineBest = transition.bestMoveUci !== null
        && capturedMaterial(before, transition.bestMoveUci, game.subjectColor);
      if (!tookIt && !alternativeVerified && !captureWasEngineBest) continue;
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
          success: tookIt || alternativeVerified,
          score: null,
          rubricComponentVersionId: null,
          difficulty: {
            materialOnOfferCp: offered.gain,
            captureCount: offered.captureCount,
            targetIsDefended: offered.defenderCount > 0 ? 1 : 0,
            legalReplies: before.legalMoveCount(),
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
            piece: offered.targetRole,
            onOfferCp: offered.gain,
            taken: tookIt,
            alternativeVerified,
          },
          completeness: "complete",
          confidence: null,
        },
      });
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Engine-derived concepts
// ---------------------------------------------------------------------------

function decisionConcepts({ game, index }: DetectorContext): DetectedOpportunity[] {
  const found: DetectedOpportunity[] = [];

  for (const transition of game.transitions) {
    if (transition.actorColor !== game.subjectColor) continue;
    const subjectBefore = fromSubject(transition.expectedScoreBefore, game.subjectColor);
    const legalReplies = index.at(transition.fromPly)?.legalMoveCount() ?? null;

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
        confidence: null,
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
        && transition.candidateCount === legalReplies
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
          confidence: null,
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
          confidence: null,
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
function conversionConcept({ game }: DetectorContext): DetectedOpportunity[] {
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
        censoredReason: censorFor(game.termination, game.result, game.subjectColor),
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
        facts: {
          converted: null,
          censored: censorFor(game.termination, game.result, game.subjectColor),
        },
        completeness: "censored",
        confidence: null,
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
      confidence: null,
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
 * The detectors, in the order they run.
 *
 * A written list rather than a registry that discovers implementations. Six
 * families in a fixed order is a list; anything more configurable would be a
 * framework for detectors nobody has written, which FOR-125 rules out by name.
 *
 * The order is part of the output contract: two runs over one game must emit
 * the same rows in the same sequence, so that a diff between them means
 * something changed rather than that a set iterated differently.
 */
export const DETECTORS: readonly Detector[] = Object.freeze([
  { name: "material", detect: detectMaterial },
  { name: "decision", detect: decisionConcepts },
  { name: "conversion", detect: conversionConcept },
  ...TACTICAL_DETECTORS,
]);

/**
 * Every observation this game supports.
 *
 * The position index is built once here and shared by every detector, which is
 * the point of it: the material detector and the tactical families ask about
 * the same plies, and parsing each FEN once per game rather than once per
 * question is the difference the shared layer exists to make.
 */
export function detectGame(game: GameFacts): DetectedOpportunity[] {
  const context: DetectorContext = { game, index: new PositionIndex(game.positions) };
  return DETECTORS.flatMap((detector) => detector.detect(context));
}
