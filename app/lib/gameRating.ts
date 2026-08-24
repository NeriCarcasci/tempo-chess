import { api } from "./api";

/**
 * The public game rating, as `POST /rating` returns it.
 *
 * These types mirror `server/src/rating/view.ts` deliberately rather than being
 * generated from it: the API is the contract between two deployments, and a
 * shared type would let a server change alter this client's shape without
 * anything failing at the boundary where it should.
 *
 * The shape enforces the rule the metric was built under. There is no variant
 * carrying `rating` without both sides' readings, the demand and the coverage,
 * so a screen that renders the headline alone cannot be written by accident.
 */

export type Color = "white" | "black";

export type MomentCode =
  | "only_move_found"
  | "only_move_missed"
  | "pressure_created"
  | "advantage_returned"
  | "collapse";

export interface SideView {
  color: Color;
  playedLike: number | null;
  playedLikeLow: number | null;
  playedLikeHigh: number | null;
  outOfDomain: boolean;
  atCeiling?: boolean;
  bandOpenHigh?: boolean;
  gaveAway: number | null;
  cleanliness: number | null;
  decisionsScored: number;
  decisionsFaced: number;
  ratingDeclared: boolean;
}

export interface DemandView {
  demand: number;
  tension: number;
  narrowness: number;
  duration: number;
  positionsExamined: number;
  onlyMoves: number;
  /* Added with method 3. A rating stored under an earlier method has none of
     these, and the API serves the version that rated the game. */
  liveDecisions?: number;
  totalDecisions?: number;
  meanTopCriticality?: number;
}

export interface MomentView {
  code: MomentCode;
  ply: number;
  moveNumber: number;
  actor: Color;
  playedUci: string;
  playedSan?: string | null;
  magnitude: number;
}

export interface GameHeaders {
  white: string | null;
  black: string | null;
  whiteElo?: number | null;
  blackElo?: number | null;
  event: string | null;
  date: string | null;
  result: string | null;
  site?: string | null;
  termination?: string | null;
  timeControl?: string | null;
  moveCount?: number | null;
}

/** Where the game came from, before anything was measured about it. */
export interface OpeningView {
  eco: string | null;
  name: string | null;
  family: string | null;
  variation: string | null;
  bookPly: number;
  leftBookAt: { ply: number; moveNumber: number; san: string; side: Color } | null;
}

export interface RatingMethod {
  key: string;
  version: string;
  hash: string;
}

export interface RatingAvailable {
  status: "available";
  method: RatingMethod;
  rating: number;
  ratingLow: number;
  ratingHigh: number;
  quality: number;
  white: SideView;
  black: SideView;
  demand: DemandView | null;
  moments: MomentView[];
  coverage: { decisions: number; practicalDecisions: number; outOfDomain: boolean };
  game: GameHeaders;
  opening?: OpeningView | null;
}

export interface RatingUnavailable {
  status: "unavailable";
  method: RatingMethod;
  reason: string;
  white: SideView | null;
  black: SideView | null;
  demand: DemandView | null;
  game: GameHeaders;
  opening?: OpeningView | null;
}

export type RatingView = RatingAvailable | RatingUnavailable;

/**
 * Where a rating has got to.
 *
 * The API answers about a *game*, not about a job. Behind it a rating is two
 * chained workflows and a few hundred queued inferences, and none of that is
 * this client's business: it asks about the game it pasted and gets back a
 * finished rating, a count it can draw a bar with, or nothing yet.
 */
export type RatingProgress =
  | { gameKey: string; state: "ready"; view: RatingView }
  | {
      gameKey: string;
      state: "working";
      /** The engine half runs as one long item; the policy half is countable. */
      stage: "screening" | "inferring";
      done: number;
      total: number;
    }
  | { gameKey: string; state: "failed"; detail: string | null }
  | { gameKey: string; state: "absent" };

/** Has anybody rated this game already? Anonymous, and starts nothing. */
export function lookupRating(pgn: string): Promise<RatingProgress> {
  return api<RatingProgress>("/rating/lookup", { json: { pgn }, anonymous: true });
}

/**
 * Rate a game nobody has rated yet. Needs an account, because this is the door
 * that spends the platform's scarcest resource.
 */
export function requestRating(pgn: string): Promise<RatingProgress> {
  return api<RatingProgress>("/rating", { json: { pgn } });
}

/** Poll one game by key. Anonymous, like the lookup. */
export function pollRating(gameKey: string): Promise<RatingProgress> {
  return api<RatingProgress>(`/rating/${encodeURIComponent(gameKey)}`, { anonymous: true });
}

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

/**
 * What each moment code says in a sentence.
 *
 * None of them mention the result, because none of the measurements behind them
 * do. "Found the only move" stays true if the player lost on time nine moves
 * later, and the wording has to survive that or the number and the prose will
 * eventually disagree in public.
 */
const MOMENT_WORDING: Record<MomentCode, string> = {
  only_move_found: "Found the only move that held",
  only_move_missed: "Missed the only move that held",
  pressure_created: "Set a problem the engine does not price",
  advantage_returned: "Handed back a live advantage",
  collapse: "Gave the game away in one move",
};

export function momentWording(code: MomentCode): string {
  return MOMENT_WORDING[code];
}

/**
 * Why a rating was refused, in the reader's terms.
 *
 * Each one names what is missing rather than apologising, because every one of
 * them is a deliberate refusal in the scorer and the page should read as though
 * we meant it.
 */
const REFUSALS: Record<string, string> = {
  too_few_decisions: "Too few moves to rate. A game needs at least twenty decisions before the numbers mean anything.",
  no_live_positions: "Nothing in this game was ever in doubt, so there is nothing to measure either side against.",
  not_deep_searched: "The deeper search did not run on this game, so we cannot say what it asked of the players.",
  no_inference: "The human model has not seen this game, and without it a rating would just be an accuracy score wearing a different name.",
};

export function refusalWording(reason: string): string {
  return REFUSALS[reason] ?? "This game cannot be rated.";
}

export function colorName(color: Color): string {
  return color === "white" ? "White" : "Black";
}
