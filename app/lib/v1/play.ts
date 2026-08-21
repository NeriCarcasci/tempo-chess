/**
 * Playing a game against the engine, on `/v1`.
 *
 * The game itself lives in the browser. The server answers one position at a
 * time and stores nothing, which is deliberate — a training game against a bot
 * is not one of the player's real games and must never end up filed as one. So
 * this module is two calls and three pure helpers, and the helpers are here
 * rather than in the route because each of them is a place the screen could
 * start making a claim the server did not.
 */

import { newIdempotencyKey, v1Data } from "./client";
import type {
  OpponentCatalogue,
  OpponentFamilyEntry,
  OpponentFamilyLevel,
  OpponentMove,
  OpponentMoveBody,
} from "./types";

export function getPlayOpponents(): Promise<OpponentCatalogue> {
  return v1Data<OpponentCatalogue>("/v1/play/opponents");
}

/**
 * Ask for the opponent's reply.
 *
 * `idempotencyKey` is one per *move*, not one per request: the caller retries a
 * dropped reply with the same key so a move that was already computed comes
 * back rather than being searched again. Omitting it makes every attempt a
 * fresh intent, which is the wrong behaviour for a retry loop.
 */
export function requestOpponentMove(
  body: OpponentMoveBody,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<OpponentMove> {
  return v1Data<OpponentMove>("/v1/play/moves", { json: body, idempotencyKey });
}

/**
 * The families this deployment can actually play.
 *
 * A screen offers these and nothing else. The catalogue also describes the
 * families it cannot serve — Maia, until its weights are a decision somebody
 * has made — so that the day one is configured it appears here without a code
 * change, and until then it is never offered and never silently substituted.
 */
export function availableFamilies(catalogue: OpponentCatalogue): OpponentFamilyEntry[] {
  return catalogue.families.filter((entry) => entry.available);
}

/**
 * The level closest to a rating, for the first-visit default.
 *
 * Ties go to the lower level: guessing a player weaker than they are costs them
 * an easy game, and guessing stronger costs them the feature.
 */
export function nearestLevel(
  levels: readonly OpponentFamilyLevel[],
  rating: number,
): OpponentFamilyLevel | null {
  let best: OpponentFamilyLevel | null = null;
  for (const level of levels) {
    if (best === null) {
      best = level;
      continue;
    }
    const closer = Math.abs(level.nominalRating - rating) < Math.abs(best.nominalRating - rating);
    if (closer) best = level;
  }
  return best;
}

/**
 * What to say under the strength selector, or nothing.
 *
 * The prototype offered an "800 Elo bot" that was really Stockfish's 1320 floor
 * wearing an 800 label, and a player losing to it drew a false conclusion about
 * their own rating. The server now reports what the engine really plays at, and
 * this is the sentence that passes that on rather than swallowing it.
 */
export function strengthNote(level: OpponentFamilyLevel | null): string | null {
  if (!level || !level.clamped) return null;
  // Both directions: an engine can fall short of a level as well as overshoot
  // it, and Maia's bands stop at 1900 where Stockfish's limiter starts at 1320.
  const direction = level.playsAt > level.nominalRating ? "weaker" : "stronger";
  return `This engine cannot play ${direction} than ${level.playsAt}, so that is what this level plays at.`;
}
