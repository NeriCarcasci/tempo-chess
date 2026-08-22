/**
 * The tactical families, and the one thing they all have to prove.
 *
 * Every family in this MVP has the same shape. A legal move creates geometry --
 * two pieces attacked at once, a piece pinned against a better one, a line
 * uncovered, a defender removed, an escape square taken away. Geometry is easy
 * to find and worth nothing on its own: the board is full of pieces that
 * happen to be attacked and are perfectly safe. What makes it a chess idea is
 * that the opponent cannot answer it, and that is what has to be shown before
 * anything is recorded.
 *
 * ## How a consequence is proven
 *
 * `guaranteedGain` is the whole verification story, and it is a one-ply
 * minimax over static exchange: play every legal reply the defender has, ask
 * what the attacker can still take afterwards, and keep the worst case. If the
 * attacker still wins material against the defender's *best* answer, the motif
 * is real. If any single reply saves everything, it is not.
 *
 * That answers the questions the contracts actually ask, without a search:
 *
 *   * a fork on two defended pieces refutes itself, because some reply defends;
 *   * a counterattack that captures the forking piece shows up as a reply after
 *     which the attacker wins nothing;
 *   * a check is handled because check leaves few legal replies, and none of
 *     them save the second target;
 *   * a "pin" on a piece that can simply be defended is not a pin.
 *
 * It is bounded and honest about its bound: one ply. A refutation that takes
 * two moves to appear is beyond it, which is exactly why a stored engine line
 * is preferred when one exists and why the confidence recorded says which of
 * the two answered.
 *
 * ## What is deliberately not here
 *
 * No search, no evaluation, no engine call. `replayPv` reads lines the deep
 * search already stored; nothing in this file extends them. A helper that
 * quietly explored a position two plies deeper would be a second chess engine
 * living inside the detector, with none of the versioning the real one has.
 */

import { Chess } from "chessops/chess";
import { makeUci, parseUci } from "chessops/util";
import type { Color, Move, Square } from "chessops/types";
import { PIECE_VALUES, see } from "../../engine/attacks.js";
import type { CensorReason, ConceptRole, OpportunityDraft } from "../observations.js";
import { MATERIAL_THRESHOLD_CP } from "./catalogue.js";
import {
  CONFIDENCE,
  eventKey,
  replayPv,
  type DetectedOpportunity,
  type DetectorContext,
  type EventDraft,
  type GameFacts,
  type PositionIndex,
  type PositionView,
} from "./evidence.js";

/**
 * What a forced mate is worth, for comparison purposes only.
 *
 * Not a claim that mate is worth ten queens. It exists so that "the defender
 * has no legal move and is in check" sorts above every material outcome when a
 * minimum is taken, and so a mating fork is never rejected for winning too
 * little material.
 */
export const MATE_GAIN_CP = 100_000;

const opposite = (color: Color): Color => (color === "white" ? "black" : "white");

/**
 * Every legal move, with promotions expanded.
 *
 * `allDests` is a square set and collapses the four promotion choices onto one
 * destination. A defender who can promote has four different replies and they
 * are not interchangeable -- underpromotion to a knight is sometimes the only
 * one that answers a check -- so a refutation search that tried only one would
 * report a forced loss that the defender could actually escape.
 */
export function legalMoves(position: Chess): Move[] {
  const moves: Move[] = [];
  for (const [from, dests] of position.allDests()) {
    const isPawn = position.board.pawn.has(from);
    for (const to of dests) {
      const rank = to >> 3;
      if (isPawn && (rank === 0 || rank === 7)) {
        for (const role of ["queen", "rook", "bishop", "knight"] as const) {
          moves.push({ from, to, promotion: role });
        }
      } else {
        moves.push({ from, to });
      }
    }
  }
  return moves;
}

/** The most material `mover` can win right now by static exchange. */
export function bestCaptureGain(position: Chess, mover: Color): number {
  if (position.turn !== mover) return 0;
  let best = 0;
  for (const [from, dests] of position.allDests()) {
    for (const to of dests) {
      const target = position.board.get(to);
      // Castling appears as king-onto-own-rook and takes nothing.
      if (!target || target.color === mover) continue;
      const gain = see(position.board, to, from);
      if (gain > best) best = gain;
    }
  }
  return best;
}

export interface VerifiedGain {
  /** Material still won against the defender's best single reply, in centipawns. */
  readonly gainCp: number;
  /** The reply that minimises it, in UCI. Null when the defender has none. */
  readonly bestDefence: string | null;
  /** True when the defender has no legal move and is in check. */
  readonly mate: boolean;
}

/**
 * What the attacker still wins after the defender's best answer.
 *
 * The defender is to move in `position`. One ply, exhaustive, with static
 * exchange at the leaves. Taking the minimum is the point: a motif that any
 * single reply defuses has not been proven, however good it looks.
 */
export function guaranteedGain(position: Chess, attacker: Color): VerifiedGain {
  const defender = opposite(attacker);
  if (position.turn !== defender) {
    // Asked about the wrong side to move. Refuse rather than answer about a
    // position nobody is in.
    return { gainCp: 0, bestDefence: null, mate: false };
  }

  const replies = legalMoves(position);
  if (replies.length === 0) {
    // No legal reply is mate when it is check and stalemate when it is not, and
    // the difference is the whole outcome of the game.
    const mate = position.isCheck();
    return { gainCp: mate ? MATE_GAIN_CP : 0, bestDefence: null, mate };
  }

  let worst = Number.POSITIVE_INFINITY;
  let bestDefence: string | null = null;
  for (const reply of replies) {
    const next = position.clone();
    next.play(reply);
    const gain = bestCaptureGain(next, attacker);
    if (gain < worst) {
      worst = gain;
      bestDefence = makeUci(reply);
      if (worst === 0) break; // Nothing beats a reply that saves everything.
    }
  }
  return { gainCp: worst === Number.POSITIVE_INFINITY ? 0 : worst, bestDefence, mate: false };
}

/**
 * The same question, cross-checked against a stored engine line when one exists.
 *
 * The one-ply bound is real, and a stored principal variation is the only thing
 * available that reaches past it without adding a search. When a line exists
 * for the position the motif was created in, replaying it says whether the
 * material actually changed hands; when it does not, static exchange answers
 * alone and the confidence recorded says so.
 *
 * A line that exists and *contradicts* the static answer is not overruled by
 * it: the detector abstains, because two pieces of evidence disagreeing is not
 * a fact about the game.
 */
export interface Verification {
  readonly gainCp: number;
  readonly confidence: number;
  readonly bestDefence: string | null;
  readonly mate: boolean;
  readonly line: readonly string[] | null;
}

export function verifyConsequence(
  game: GameFacts,
  index: PositionIndex,
  afterPly: number,
  attacker: Color,
): Verification | null {
  const view = index.at(afterPly);
  if (!view) return null;
  const staticGain = guaranteedGain(view.position, attacker);
  if (staticGain.gainCp < MATERIAL_THRESHOLD_CP) return null;

  const lines = game.candidatesByPly.get(afterPly);
  const best = lines && lines.length > 0
    ? [...lines].sort((a, b) => a.rank - b.rank)[0]
    : null;
  if (!best) {
    return {
      gainCp: staticGain.gainCp,
      confidence: CONFIDENCE.seeOnly,
      bestDefence: staticGain.bestDefence,
      mate: staticGain.mate,
      line: null,
    };
  }

  // The stored line begins with the defender's move, because `afterPly` is the
  // position they were left in. Replaying two plies is enough to see whether
  // the attacker's follow-up is the capture the static answer promised.
  const replay = replayPv(view, best.pv, 2);
  if (!replay.available) {
    return {
      gainCp: staticGain.gainCp,
      confidence: CONFIDENCE.seeOnly,
      bestDefence: staticGain.bestDefence,
      mate: staticGain.mate,
      line: null,
    };
  }
  const afterDefence = replay.positions[1];
  if (!afterDefence) return null;
  const followUp = bestCaptureGain(afterDefence, attacker);
  if (followUp < MATERIAL_THRESHOLD_CP && !staticGain.mate) {
    // The engine's own line says the attacker wins nothing here. Static
    // exchange said otherwise. Disagreement is not a fact.
    return null;
  }
  return {
    gainCp: Math.min(staticGain.gainCp, Math.max(followUp, staticGain.mate ? MATE_GAIN_CP : 0)),
    confidence: CONFIDENCE.pvProven,
    bestDefence: staticGain.bestDefence,
    mate: staticGain.mate,
    line: best.pv,
  };
}

// ---------------------------------------------------------------------------
// Turning a verified motif into observations
// ---------------------------------------------------------------------------

/**
 * Why the subject never answered.
 *
 * `termination = resign` says how the game ended, not who resigned; only the
 * recorded winner lets that decision be attributed to the opponent.
 */
function censorFor(game: GameFacts): CensorReason {
  if (game.termination === "resign" && game.result === game.subjectColor) {
    return "opponent_resigned";
  }
  if (game.termination === "outoftime" || game.termination === "timeout") return "clock_expired";
  return "game_ended";
}

/** The subject's first move after `ply`, if they made one. */
function subjectReplyAfter(game: GameFacts, ply: number) {
  return game.transitions.find(
    (transition) => transition.actorColor === game.subjectColor && transition.fromPly > ply,
  ) ?? null;
}

export interface TacticalFinding {
  readonly conceptSlug: string;
  readonly eventType: string;
  /** Distinguishes two occurrences of the same family at the same ply. */
  readonly discriminator: string;
  readonly focalPly: number;
  readonly actorColor: Color;
  readonly facts: Record<string, unknown>;
  readonly difficulty: Record<string, number>;
  readonly verification: Verification;
}

/**
 * One verified motif, as the observation it supports.
 *
 * Both roles measure the same thing from opposite sides and both are censored
 * the same way. The subject created it: did they collect what it won? The
 * opponent created it: did the subject give up less than it threatened?
 *
 * Neither role is scored on the motif existing. A player who finds a fork and
 * then fails to take the piece has done something a rate of "100% of forks
 * played" would never show, and that is the difference between a measurement
 * and a count.
 */
export function tacticalObservation(
  game: GameFacts,
  index: PositionIndex,
  finding: TacticalFinding,
): DetectedOpportunity | null {
  const subjectIsActor = finding.actorColor === game.subjectColor;
  const role: ConceptRole = subjectIsActor ? "execute" : "respond";
  const reply = subjectReplyAfter(game, finding.focalPly);

  const event: EventDraft = {
    eventType: finding.eventType,
    startPly: finding.focalPly,
    focalPly: finding.focalPly,
    endPly: reply === null ? finding.focalPly + 1 : reply.fromPly + 1,
    detectionKey: eventKey(finding.eventType, finding.focalPly, finding.discriminator),
    actor: subjectIsActor ? "subject" : "opponent",
    affected: subjectIsActor ? "opponent" : "subject",
    facts: {
      ...finding.facts,
      expectedGainCp: finding.verification.gainCp,
      bestDefence: finding.verification.bestDefence,
      mate: finding.verification.mate,
      verificationLine: finding.verification.line,
      verifiedBy: finding.verification.line === null ? "static_exchange" : "stored_line",
    },
    completeness: reply === null ? "censored" : "complete",
    confidence: finding.verification.confidence,
  };

  const base = {
    role,
    opportunityPly: finding.focalPly,
    score: null,
    rubricComponentVersionId: null,
    difficulty: finding.difficulty,
  };

  if (reply === null) {
    // Nobody moved after it. Whether the motif would have been collected or
    // answered is a question the game never asked.
    return {
      conceptSlug: finding.conceptSlug,
      role,
      phase: null,
      draft: {
        ...base,
        responsePly: null,
        responseObserved: false,
        censoredReason: censorFor(game),
        success: null,
      } satisfies OpportunityDraft,
      event,
    };
  }

  // What the position looked like after the subject actually replied.
  const afterReply = index.at(reply.fromPly + 1);
  const attacker = subjectIsActor ? game.subjectColor : opposite(game.subjectColor);
  const stillAvailable = afterReply
    ? bestCaptureGain(
      afterReply.position.turn === attacker
        ? afterReply.position
        : (index.asIfToMove(reply.fromPly + 1, attacker)?.position ?? afterReply.position),
      attacker,
    )
    : 0;

  const success = subjectIsActor
    // Executing means collecting it. The subject's own follow-up either took
    // the material the motif won or it did not.
    ? capturedAtLeast(index, reply.fromPly, reply.playedMoveUci, game.subjectColor, finding.verification.gainCp)
      || finding.verification.mate
    // Responding means conceding less than it threatened.
    : stillAvailable < finding.verification.gainCp;

  return {
    conceptSlug: finding.conceptSlug,
    role,
    phase: reply.phase,
    draft: {
      ...base,
      responsePly: reply.fromPly,
      responseObserved: true,
      censoredReason: null,
      success,
    } satisfies OpportunityDraft,
    event,
  };
}

/**
 * Did the move played take at least what the motif was worth?
 *
 * A mating gain is never matched by a capture, which is why the caller treats
 * mate separately rather than asking this to compare against `MATE_GAIN_CP`.
 */
function capturedAtLeast(
  index: PositionIndex,
  ply: number,
  uci: string,
  mover: Color,
  atLeast: number,
): boolean {
  const view = index.at(ply);
  if (!view) return false;
  const move = parseUci(uci);
  if (!move || !("from" in move)) return false;
  if (!view.isLegal(move)) return false;
  const target = view.pieceAt(move.to);
  if (!target || target.color === mover) return false;
  return view.see(move.to, move.from) >= atLeast;
}

/**
 * The most `attacker` can win by taking whatever stands on `square`.
 *
 * Attribution, not just size. `guaranteedGain` says the attacker wins material
 * somewhere after the best defence, which is not the same as winning it *from
 * the motif being recorded*. A move that creates an irrelevant pin while also
 * leaving the opponent's queen hanging elsewhere would otherwise credit the pin
 * with the queen.
 */
export function bestSeeOnSquare(
  view: PositionView,
  square: Square,
  attacker: Color,
): number {
  let best = Number.NEGATIVE_INFINITY;
  for (const from of view.attackersOf(square, attacker)) {
    const gain = view.see(square, from);
    if (gain > best) best = gain;
  }
  return best === Number.NEGATIVE_INFINITY ? 0 : best;
}

/** Material value of whatever stands on a square. */
export function valueOn(view: PositionView, square: Square): number {
  const piece = view.pieceAt(square);
  return piece ? PIECE_VALUES[piece.role] : 0;
}

export { opposite };
export type { DetectorContext };

// ---------------------------------------------------------------------------
// double_attack (FOR-126)
// ---------------------------------------------------------------------------

/**
 * One piece, two things it can take.
 *
 * The geometry is cheap: after the focal move, look at what the piece that just
 * moved attacks. The work is deciding which of those attacks are worth
 * anything, and then proving the opponent cannot answer both.
 *
 * A target counts when it is the king -- check has to be answered, which is
 * what makes a royal fork win the other piece -- or when taking it wins
 * material by static exchange. A defended pawn attacked by a queen is not a
 * threat, and counting it would turn most moves in most games into forks.
 *
 * Static exchange is asked of the board rather than of a position with the
 * attacker to move, deliberately. Flipping the turn back after a checking move
 * produces something that is not a position at all, and the checking fork is
 * the case this most needs to get right.
 */
function detectDoubleAttack({ game, index }: DetectorContext): DetectedOpportunity[] {
  const found: DetectedOpportunity[] = [];

  for (const transition of game.transitions) {
    const afterPly = transition.fromPly + 1;
    const after = index.at(afterPly);
    if (!after) continue;

    const move = parseUci(transition.playedMoveUci);
    if (!move || !("from" in move)) continue;
    const attackerSquare = move.to;
    const attacker = after.pieceAt(attackerSquare);
    if (!attacker || attacker.color !== transition.actorColor) continue;

    const board = after.position.board;
    const enemy = transition.actorColor === "white" ? board.black : board.white;
    const enemyKing = board.kingOf(opposite(transition.actorColor));

    const winnable: Square[] = [];
    let kingInvolved = false;
    let defendedTargets = 0;
    let topValue = 0;
    for (const target of after.attacksFrom(attackerSquare).intersect(enemy)) {
      if (enemyKing !== undefined && target === enemyKing) {
        kingInvolved = true;
        continue;
      }
      if (after.see(target, attackerSquare) < MATERIAL_THRESHOLD_CP) continue;
      winnable.push(target);
      if (after.defendersOf(target).size() > 0) defendedTargets += 1;
      topValue = Math.max(topValue, valueOn(after, target));
    }

    const targetCount = winnable.length + (kingInvolved ? 1 : 0);
    if (targetCount < 2) continue;

    // Geometry established. Now the part that matters: can it be answered?
    const verification = verifyConsequence(game, index, afterPly, transition.actorColor);
    if (!verification) continue;

    const squares = [...winnable].sort((a, b) => a - b);
    const observation = tacticalObservation(game, index, {
      conceptSlug: "double_attack",
      eventType: "double_attack",
      discriminator: `${attackerSquare}-${squares.join(".")}`,
      focalPly: transition.fromPly,
      actorColor: transition.actorColor,
      facts: {
        mover: attacker.role,
        from: move.from,
        to: attackerSquare,
        targets: squares,
        targetValues: squares.map((square) => valueOn(after, square)),
        kingInvolved,
        subtype: kingInvolved ? "royal_fork" : "fork",
      },
      difficulty: {
        targetCount,
        targetValueCp: topValue,
        kingInvolved: kingInvolved ? 1 : 0,
        defendedTargets,
        legalReplies: after.legalMoveCount(),
      },
      verification,
    });
    if (observation) found.push(observation);
  }
  return found;
}

// ---------------------------------------------------------------------------
// pin (FOR-127)
// ---------------------------------------------------------------------------

/** A pin, as the identity that decides whether this move created it. */
const pinIdentity = (pin: { pinner: Square; pinned: Square; target: Square }): string =>
  `${pin.pinner}-${pin.pinned}-${pin.target}`;

/**
 * A piece that cannot move without giving up something better behind it.
 *
 * Two things separate what is recorded here from what a board is full of.
 *
 * The move has to have *created* the pin. A bishop that was already pinning a
 * knight three moves ago is not something the player just did, and recording it
 * every ply would turn one idea into a dozen events.
 *
 * And the pin has to be worth something. Alignment is not an opportunity: a
 * developing move that happens to pin a knight against a queen, with no way to
 * increase the pressure, has cost the opponent nothing. `verifyConsequence`
 * decides that the same way it decides a fork -- against every legal reply,
 * does static exchange still win material -- so the pins that survive are the
 * ones where the pinned piece is genuinely being won.
 *
 * Which side of the ray is more valuable is what makes this a pin rather than a
 * skewer, and `pinsAgainst` already draws that line: the piece behind must be
 * worth more than the piece in front. The skewer detector takes the other case.
 */
function detectPin({ game, index }: DetectorContext): DetectedOpportunity[] {
  const found: DetectedOpportunity[] = [];

  for (const transition of game.transitions) {
    const afterPly = transition.fromPly + 1;
    const before = index.at(transition.fromPly);
    const after = index.at(afterPly);
    if (!before || !after) continue;

    const defender = opposite(transition.actorColor);
    const existing = new Set(before.pinsAgainst(defender).map(pinIdentity));
    const created = after.pinsAgainst(defender).filter((pin) => !existing.has(pinIdentity(pin)));
    if (created.length === 0) continue;

    const verification = verifyConsequence(game, index, afterPly, transition.actorColor);
    if (!verification) continue;

    for (const pin of created) {
      // The gain has to be the pinned piece, not something unrelated the same
      // move happened to win. A pinned knight the attacker cannot profitably
      // take is an alignment, and the contract calls that a negative.
      const winnable = bestSeeOnSquare(after, pin.pinned, transition.actorColor);
      if (winnable < MATERIAL_THRESHOLD_CP) continue;

      const observation = tacticalObservation(game, index, {
        conceptSlug: "pin",
        eventType: "pin",
        discriminator: pinIdentity(pin),
        focalPly: transition.fromPly,
        actorColor: transition.actorColor,
        facts: {
          pinner: pin.pinner,
          pinned: pin.pinned,
          target: pin.target,
          ray: pin.ray,
          subtype: pin.subtype,
          pinnedValueCp: valueOn(after, pin.pinned),
          targetValueCp: valueOn(after, pin.target),
          winnableCp: winnable,
        },
        difficulty: {
          pinnedValueCp: valueOn(after, pin.pinned),
          targetValueCp: valueOn(after, pin.target),
          absolute: pin.subtype === "absolute" ? 1 : 0,
          rayLength: pin.ray.length,
          legalReplies: after.legalMoveCount(),
        },
        verification,
      });
      if (observation) found.push(observation);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// skewer (FOR-128)
// ---------------------------------------------------------------------------

/**
 * The same ray as a pin, with the values the other way round.
 *
 * In a pin the valuable piece is behind and the one in front cannot move. In a
 * skewer the valuable piece is in front, so it moves -- and what was sheltering
 * behind it is taken. One line of geometry, two ideas, and which one it is
 * depends entirely on which end is worth more.
 *
 * That is also why the two detectors cannot both fire on one shape.
 * `pinsAgainst` requires the rear piece to be worth strictly more; this
 * requires the front piece to be. Equal values are neither, which is correct:
 * rook behind rook wins nothing by making the first one move.
 *
 * The king counts as the most valuable piece there is, so a check with
 * something behind it is always a skewer rather than a pin.
 */
function detectSkewer({ game, index }: DetectorContext): DetectedOpportunity[] {
  const found: DetectedOpportunity[] = [];

  for (const transition of game.transitions) {
    const afterPly = transition.fromPly + 1;
    const after = index.at(afterPly);
    if (!after) continue;

    const move = parseUci(transition.playedMoveUci);
    if (!move || !("from" in move)) continue;
    const attackerSquare = move.to;
    const attacker = after.pieceAt(attackerSquare);
    if (!attacker || attacker.color !== transition.actorColor) continue;

    const defender = opposite(transition.actorColor);
    for (const xray of after.xraysFrom(attackerSquare)) {
      const front = after.pieceAt(xray.front);
      const rear = after.pieceAt(xray.rear);
      if (!front || !rear) continue;
      if (front.color !== defender || rear.color !== defender) continue;

      const frontValue = valueOn(after, xray.front);
      const rearValue = valueOn(after, xray.rear);
      // Strictly greater. Equal is neither idea, and the pin detector takes the
      // case where the rear piece is the valuable one.
      if (frontValue <= rearValue) continue;

      // If the front piece steps aside, does the rear one actually fall? Asked
      // by taking the front piece off the board and running static exchange on
      // what is behind it -- otherwise the skewer is credited with material the
      // attacker was winning for some unrelated reason.
      const bared = after.position.board.clone();
      bared.take(xray.front);
      if (see(bared, xray.rear, attackerSquare) < MATERIAL_THRESHOLD_CP) continue;

      const verification = verifyConsequence(game, index, afterPly, transition.actorColor);
      if (!verification) continue;

      const observation = tacticalObservation(game, index, {
        conceptSlug: "skewer",
        eventType: "skewer",
        discriminator: `${attackerSquare}-${xray.front}-${xray.rear}`,
        focalPly: transition.fromPly,
        actorColor: transition.actorColor,
        facts: {
          attacker: attackerSquare,
          front: xray.front,
          rear: xray.rear,
          frontValueCp: frontValue,
          rearValueCp: rearValue,
          frontIsKing: front.role === "king",
        },
        difficulty: {
          frontValueCp: frontValue,
          rearValueCp: rearValue,
          frontIsKing: front.role === "king" ? 1 : 0,
          legalReplies: after.legalMoveCount(),
        },
        verification,
      });
      if (observation) found.push(observation);
    }
  }
  return found;
}

/** The tactical detectors, in the order they run. */
export const TACTICAL_DETECTORS = Object.freeze([
  { name: "double_attack", detect: detectDoubleAttack },
  { name: "pin", detect: detectPin },
  { name: "skewer", detect: detectSkewer },
]);
