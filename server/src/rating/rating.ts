/**
 * The 0–10, and everything it is made of.
 *
 * Three rules hold this module together, and they are all refusals.
 *
 * **The number never ships alone.** `rateGame` returns the decomposition, the
 * coverage and the moments in the same object as the rating, so there is no
 * call site that can obtain the headline without the evidence for it. That is
 * deliberate: a single number a reader cannot interrogate is precisely the
 * vanity metric PRODUCT.md's anti-references rule out, and this codebase says
 * in several places that one number describes neither player.
 *
 * **No strength estimate, no rating.** When the human policy has not been asked
 * about a game, the terms that remain are expected-score loss and how sharp the
 * position was — an accuracy score with extra steps. Publishing that under the
 * same name and the same scale would quietly turn the product's claim into the
 * thing it was built to replace, so it is `unavailable` instead.
 *
 * **The outcome is never an input.** Nothing in this file reads who won. A
 * sacrifice is scored on the problem it posed, and it would score identically
 * had the opponent found the only save.
 */

import { roundScore, TOLERANCE_RULE } from "../engine/contract.js";
import {
  CLEANLINESS_POLICY,
  COMBINATION_POLICY,
  COVERAGE_POLICY,
  MOMENT_POLICY,
  RATING_METHOD,
  ratingMethodHash,
  type Color,
  type GameRatingInput,
  type Moment,
  type MomentCode,
  type UnavailableReason,
} from "./contract.js";
import { scoreDecision, type ScoredDecision } from "./decisions.js";
import { readDemand, type Demand } from "./demand.js";
import { estimateStrength, type Strength } from "./strength.js";

// ---------------------------------------------------------------------------
// Cleanliness
// ---------------------------------------------------------------------------

export interface Cleanliness {
  status: "available";
  /** 1 when nothing live was given away, 0 at `lossAtZero` and below. */
  cleanliness: number;
  /** The same figure at the pessimistic and optimistic ends of the pressure bounds. */
  cleanlinessLow: number;
  cleanlinessHigh: number;
  /** Mean charged loss per unit of liveness. The number the score is read from. */
  weightedLoss: number;
  /** Plies that carried weight, and how many of them had a practical reading. */
  weightedDecisions: number;
  practicalDecisions: number;
}

export interface CleanlinessUnavailable {
  status: "unavailable";
  reason: "no_live_positions";
}

/**
 * How much of the game one side gave away, weighted by whether it was still a
 * game at the time.
 *
 * The weight is liveness rather than a flat mean, so a long dead-won conversion
 * cannot dilute a middlegame error and an error in an already-lost position
 * cannot be charged twice. Plies below the liveness floor drop out entirely
 * rather than contributing a little: shuffling in a decided position is not a
 * measurement of anybody.
 *
 * The bounds come from the practical reading's own bounds. Where a decision has
 * no practical reading, the objective loss stands at all three ends, which is
 * the honest shape — an unmeasured correction is not an uncertain one.
 */
export function readCleanliness(
  decisions: readonly ScoredDecision[],
): Cleanliness | CleanlinessUnavailable {
  const live = decisions.filter((entry) => entry.liveness >= CLEANLINESS_POLICY.livenessFloor);
  const weight = live.reduce((sum, entry) => sum + entry.liveness, 0);
  if (live.length === 0 || weight <= 0) {
    return { status: "unavailable", reason: "no_live_positions" };
  }

  // `expectedScoreLow` is the opponent most likely to save, so it leaves the
  // least pressure and charges the most loss. That end is the low cleanliness.
  const at = (pick: (entry: ScoredDecision) => number): number => {
    const total = live.reduce((sum, entry) => sum + entry.liveness * Math.max(0, pick(entry)), 0);
    const loss = total / weight;
    return roundScore(1 - Math.min(1, loss / CLEANLINESS_POLICY.lossAtZero));
  };

  const objectiveOr = (entry: ScoredDecision, practical: number): number =>
    entry.practical.status === "available"
      ? entry.decision.expectedScoreBefore - practical
      : entry.objectiveLoss;

  const weightedLoss =
    live.reduce((sum, entry) => sum + entry.liveness * entry.chargedLoss, 0) / weight;

  return {
    status: "available",
    cleanliness: at((entry) => entry.effectiveLoss),
    cleanlinessLow: at((entry) =>
      objectiveOr(entry, entry.practical.status === "available" ? entry.practical.expectedScoreLow : 0),
    ),
    cleanlinessHigh: at((entry) =>
      objectiveOr(entry, entry.practical.status === "available" ? entry.practical.expectedScoreHigh : 0),
    ),
    weightedLoss: roundScore(weightedLoss),
    weightedDecisions: live.length,
    practicalDecisions: live.filter((entry) => entry.practical.status === "available").length,
  };
}

// ---------------------------------------------------------------------------
// Combination
// ---------------------------------------------------------------------------

/**
 * The log-sum-exp minimum.
 *
 * A game is bounded by its weaker side, so the two sides are combined with a
 * minimum rather than a mean: a grandmaster cannot average a beginner up to a
 * middling score, because half the moves on that board were not good moves.
 *
 * It is a *soft* minimum so that two nearly equal sides are not decided by
 * measurement noise on whichever one happened to read lower. At the policy's
 * lambda, equal sides return their common value exactly, and a wide gap returns
 * something close to the weaker one.
 */
export function softMin(left: number, right: number, lambda: number): number {
  const mean = (Math.exp(-lambda * left) + Math.exp(-lambda * right)) / 2;
  return -Math.log(mean) / lambda;
}

export function normalizeStrength(rating: number): number {
  const span = COMBINATION_POLICY.strengthCeiling - COMBINATION_POLICY.strengthFloor;
  return Math.min(1, Math.max(0, (rating - COMBINATION_POLICY.strengthFloor) / span));
}

function sideQuality(strength: number, cleanliness: number): number {
  return (
    COMBINATION_POLICY.strengthWeight * normalizeStrength(strength) +
    COMBINATION_POLICY.cleanlinessWeight * cleanliness
  );
}

function toScale(quality: number, demand: number): number {
  const earned =
    COMBINATION_POLICY.demandFloor +
    (1 - COMBINATION_POLICY.demandFloor) * demand ** COMBINATION_POLICY.demandExponent;
  const value =
    COMBINATION_POLICY.scaleMax * Math.max(0, quality) ** COMBINATION_POLICY.qualityExponent * earned;
  return Math.round(Math.min(COMBINATION_POLICY.scaleMax, Math.max(0, value)) * 10) / 10;
}

// ---------------------------------------------------------------------------
// Moments
// ---------------------------------------------------------------------------

const MOMENT_PRIORITY: Record<MomentCode, number> = {
  collapse: 0,
  only_move_missed: 1,
  advantage_returned: 2,
  pressure_created: 3,
  only_move_found: 4,
};

/**
 * The two or three decisions worth naming beside the number.
 *
 * One per ply, by the priority above, because a ply that was both a collapse
 * and a missed only-move is one event and listing it twice would inflate a
 * short game's summary. Ranked by magnitude within the cap.
 *
 * Every code is outcome-free. `only_move_found` says the player found the move
 * that held, not that the game was won from there, and it stays true if they
 * lost on time nine moves later.
 */
export function findMoments(decisions: readonly ScoredDecision[]): Moment[] {
  const byPly = new Map<number, Moment>();

  const offer = (entry: ScoredDecision, code: MomentCode, magnitude: number): void => {
    const existing = byPly.get(entry.decision.ply);
    if (existing && MOMENT_PRIORITY[existing.code] <= MOMENT_PRIORITY[code]) return;
    byPly.set(entry.decision.ply, {
      code,
      ply: entry.decision.ply,
      actor: entry.decision.actor,
      playedUci: entry.decision.playedUci,
      magnitude: roundScore(magnitude),
    });
  };

  for (const entry of decisions) {
    const { criticality, onlyMove } = entry.decision;

    if (entry.chargedLoss >= MOMENT_POLICY.collapseAt) {
      offer(entry, "collapse", entry.chargedLoss);
    }
    if (onlyMove === true && entry.chargedLoss > TOLERANCE_RULE.expectedScoreTolerance) {
      offer(entry, "only_move_missed", entry.chargedLoss);
    }
    if (
      onlyMove !== true &&
      entry.chargedLoss >= MOMENT_POLICY.returnedAtNotable &&
      entry.liveness >= 0.5
    ) {
      offer(entry, "advantage_returned", entry.chargedLoss);
    }
    if (
      entry.practical.status === "available" &&
      entry.practical.pressure >= MOMENT_POLICY.pressureAtNotable
    ) {
      offer(entry, "pressure_created", entry.practical.pressure);
    }
    if (
      onlyMove === true &&
      entry.chargedLoss <= TOLERANCE_RULE.expectedScoreTolerance &&
      criticality !== null
    ) {
      offer(entry, "only_move_found", criticality);
    }
  }

  return [...byPly.values()]
    .sort(
      (left, right) =>
        MOMENT_PRIORITY[left.code] - MOMENT_PRIORITY[right.code] ||
        right.magnitude - left.magnitude,
    )
    .slice(0, MOMENT_POLICY.maxMoments);
}

// ---------------------------------------------------------------------------
// The rating
// ---------------------------------------------------------------------------

export interface SideReading {
  color: Color;
  strength: Strength;
  cleanliness: Cleanliness | CleanlinessUnavailable;
  /** The side's contribution to quality, in [0, 1]. Null when a term is missing. */
  quality: number | null;
}

export interface GameRating {
  status: "available";
  method: typeof RATING_METHOD;
  methodHash: string;
  canonicalGameId: string | null;
  /** The headline, one decimal, 0 to 10. */
  rating: number;
  /** The same combination at both ends of the inputs' intervals. */
  ratingLow: number;
  ratingHigh: number;
  quality: number;
  demand: Demand;
  white: SideReading;
  black: SideReading;
  moments: readonly Moment[];
  coverage: {
    decisions: number;
    /** Decisions with a practical reading, over decisions with any reading. */
    practicalDecisions: number;
    /** True when either side's strength sits outside the calibrated range. */
    outOfDomain: boolean;
  };
}

export interface GameRatingUnavailable {
  status: "unavailable";
  reason: UnavailableReason;
  method: typeof RATING_METHOD;
  methodHash: string;
  canonicalGameId: string | null;
  /** Whatever was computed before the refusal, so a caller can say why. */
  white: SideReading | null;
  black: SideReading | null;
  demand: Demand | null;
}

export type GameRatingResult = GameRating | GameRatingUnavailable;

function readSide(color: Color, decisions: readonly ScoredDecision[]): SideReading {
  const strength = estimateStrength(decisions);
  const cleanliness = readCleanliness(decisions);
  const quality =
    strength.status === "available" && cleanliness.status === "available"
      ? sideQuality(strength.rating, cleanliness.cleanliness)
      : null;
  return { color, strength, cleanliness, quality };
}

/**
 * Rate one game.
 *
 * The refusals come first and in the order their reasons stop being true: a
 * game too short to be a game, then a game with no live position in it, then a
 * game the human policy was never asked about. Each returns what it managed to
 * compute, because "unavailable, and here is how far we got" is a usable answer
 * and a bare null is not.
 */
export function rateGame(input: GameRatingInput): GameRatingResult {
  const methodHash = ratingMethodHash();
  const base = {
    method: RATING_METHOD,
    methodHash,
    canonicalGameId: input.canonicalGameId,
  } as const;

  const scored = input.decisions.map(scoreDecision);
  if (scored.length < COVERAGE_POLICY.minimumDecisions) {
    return {
      status: "unavailable",
      reason: "too_few_decisions",
      ...base,
      white: null,
      black: null,
      demand: null,
    };
  }

  const white = readSide(
    "white",
    scored.filter((entry) => entry.decision.actor === "white"),
  );
  const black = readSide(
    "black",
    scored.filter((entry) => entry.decision.actor === "black"),
  );
  const demand = readDemand(scored, input.deepPassRan);

  if (white.cleanliness.status === "unavailable" || black.cleanliness.status === "unavailable") {
    return { status: "unavailable", reason: "no_live_positions", ...base, white, black, demand };
  }
  if (white.strength.status === "unavailable" || black.strength.status === "unavailable") {
    return { status: "unavailable", reason: "no_inference", ...base, white, black, demand };
  }
  if (demand.status === "unavailable") {
    return { status: "unavailable", reason: "not_deep_searched", ...base, white, black, demand };
  }

  const lambda = COMBINATION_POLICY.softMinLambda;
  const quality = softMin(white.quality!, black.quality!, lambda);

  // The ends of the interval move both sides together on purpose. They share an
  // engine, a policy and a budget, so the errors are correlated and treating
  // them as independent would publish a narrower band than the evidence earns.
  const low = softMin(
    sideQuality(white.strength.intervalLow, white.cleanliness.cleanlinessLow),
    sideQuality(black.strength.intervalLow, black.cleanliness.cleanlinessLow),
    lambda,
  );
  const high = softMin(
    sideQuality(white.strength.intervalHigh, white.cleanliness.cleanlinessHigh),
    sideQuality(black.strength.intervalHigh, black.cleanliness.cleanlinessHigh),
    lambda,
  );

  const practicalDecisions = scored.filter(
    (entry) => entry.practical.status === "available",
  ).length;

  return {
    status: "available",
    ...base,
    rating: toScale(quality, demand.demand),
    ratingLow: toScale(low, demand.demand),
    ratingHigh: toScale(high, demand.demand),
    quality: roundScore(quality),
    demand,
    white,
    black,
    moments: findMoments(scored),
    coverage: {
      decisions: scored.length,
      practicalDecisions,
      outOfDomain: white.strength.outOfDomain || black.strength.outOfDomain,
    },
  };
}
