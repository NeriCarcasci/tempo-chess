/**
 * What a rating looks like on the way out of the API.
 *
 * A separate shape from `GameRating` rather than the same object serialised,
 * for one reason: the internal result carries things a public reader has no
 * business receiving and no use for, and a DTO is where that gets decided once
 * instead of at every call site.
 *
 * The shape is built around the rule the metric was designed under: the number
 * never travels alone. There is no way to construct a `RatingView` containing
 * `rating` without also containing both sides' readings, the demand, the
 * coverage and the moments, because a client that could ask for the headline
 * on its own would eventually be built to.
 *
 * Nothing here is rounded for presentation beyond the scale itself. A client
 * that wants one decimal can render one; a client given a pre-rounded 7 could
 * never recover that it was 7.4.
 */

import type { GameRatingResult, SideReading } from "./rating.js";
import type { Demand } from "./demand.js";
import type { Color, MomentCode } from "./contract.js";

export interface SideView {
  color: Color;
  /** The rung the side's choices looked like, and the rungs we cannot rule out. */
  playedLike: number | null;
  playedLikeLow: number | null;
  playedLikeHigh: number | null;
  /** True when the estimate sits outside the range a slice was calibrated for. */
  outOfDomain: boolean;
  /** Expected score given away per unit of liveness. Lower is cleaner. */
  gaveAway: number | null;
  cleanliness: number | null;
  decisionsScored: number;
  decisionsFaced: number;
  /**
   * Whether the rating this side's opponent was modelled against came from the
   * game or from the estimate. A reader deserves to know which.
   */
  ratingDeclared: boolean;
}

export interface DemandView {
  demand: number;
  tension: number;
  narrowness: number;
  duration: number;
  positionsExamined: number;
  onlyMoves: number;
}

export interface MomentView {
  code: MomentCode;
  ply: number;
  moveNumber: number;
  actor: Color;
  playedUci: string;
  magnitude: number;
}

export interface GameHeaders {
  white: string | null;
  black: string | null;
  event: string | null;
  date: string | null;
  result: string | null;
}

export interface RatingAvailableView {
  status: "available";
  method: { key: string; version: string; hash: string };
  rating: number;
  ratingLow: number;
  ratingHigh: number;
  quality: number;
  white: SideView;
  black: SideView;
  demand: DemandView | null;
  moments: MomentView[];
  coverage: {
    decisions: number;
    practicalDecisions: number;
    outOfDomain: boolean;
  };
  game: GameHeaders;
}

export interface RatingUnavailableView {
  status: "unavailable";
  method: { key: string; version: string; hash: string };
  reason: string;
  /** What was computed before the refusal, so the page can say how far we got. */
  white: SideView | null;
  black: SideView | null;
  demand: DemandView | null;
  game: GameHeaders;
}

export type RatingView = RatingAvailableView | RatingUnavailableView;

/** Ply to the move number a player would say out loud. */
export function moveNumberOf(ply: number): number {
  return Math.ceil(ply / 2);
}

function sideView(side: SideReading | null, ratingDeclared: boolean): SideView | null {
  if (side === null) return null;
  const { strength, cleanliness } = side;
  return {
    color: side.color,
    playedLike: strength.status === "available" ? strength.rating : null,
    playedLikeLow: strength.status === "available" ? strength.intervalLow : null,
    playedLikeHigh: strength.status === "available" ? strength.intervalHigh : null,
    outOfDomain: strength.status === "available" ? strength.outOfDomain : false,
    gaveAway: cleanliness.status === "available" ? cleanliness.weightedLoss : null,
    cleanliness: cleanliness.status === "available" ? cleanliness.cleanliness : null,
    decisionsScored: strength.decisionsScored,
    decisionsFaced: strength.decisionsFaced,
    ratingDeclared,
  };
}

function demandView(demand: Demand | null): DemandView | null {
  if (demand === null || demand.status !== "available") return null;
  return {
    demand: demand.demand,
    tension: demand.tension,
    narrowness: demand.narrowness,
    duration: demand.duration,
    positionsExamined: demand.criticalPositions,
    onlyMoves: demand.onlyMoves,
  };
}

export interface ViewContext {
  game: GameHeaders;
  declared: Record<Color, boolean>;
}

export function toRatingView(result: GameRatingResult, context: ViewContext): RatingView {
  const method = {
    key: result.method.key,
    version: result.method.version,
    hash: result.methodHash,
  };

  if (result.status === "unavailable") {
    return {
      status: "unavailable",
      method,
      reason: result.reason,
      white: sideView(result.white, context.declared.white),
      black: sideView(result.black, context.declared.black),
      demand: demandView(result.demand),
      game: context.game,
    };
  }

  return {
    status: "available",
    method,
    rating: result.rating,
    ratingLow: result.ratingLow,
    ratingHigh: result.ratingHigh,
    quality: result.quality,
    white: sideView(result.white, context.declared.white)!,
    black: sideView(result.black, context.declared.black)!,
    demand: demandView(result.demand),
    moments: result.moments.map((moment) => ({
      code: moment.code,
      ply: moment.ply,
      moveNumber: moveNumberOf(moment.ply),
      actor: moment.actor,
      playedUci: moment.playedUci,
      magnitude: moment.magnitude,
    })),
    coverage: result.coverage,
    game: context.game,
  };
}
