/**
 * The published review of one game, and the concepts detected in it.
 *
 * The game screen is reached by Lichess id — it fetches the moves from Lichess
 * directly, which is what makes it work for a game Forma has never synced. The
 * review API is keyed by Forma's own game id. Those are two different
 * identifiers for the same game, and nothing in the app bridged them, so this
 * module does.
 *
 * It bridges them through the recent-games list, which carries both. That is a
 * bounded lookup rather than a complete one: a game older than the window
 * resolves to nothing and the screen says so. Adding a lookup endpoint keyed by
 * provider id would answer it properly and belongs to whoever needs the older
 * games, not to the ticket that puts concepts on the screen.
 *
 * Like the rest of `app/lib/v1`, nothing here throws. The board and the moves
 * come from Lichess and are worth drawing on their own; a review that cannot be
 * fetched costs the reader one panel, not the page.
 */

import { v1Data } from "./client";
import { fetchRecentGamesStrict } from "./games";
import { ProblemError } from "./problem";
import type { GameReview } from "./types";

/** Why the concept panel has nothing to show. Each reads differently to a person. */
export type ReviewAbsence =
  /** The game is not in the synced window, so Forma has no id for it. */
  | "not_synced"
  /** Forma knows the game and has not published an analysis of it. */
  | "not_analyzed"
  /** The request failed, which is about us rather than about the game. */
  | "unreachable";

export type ReviewLookup =
  | { readonly status: "found"; readonly gameId: string; readonly review: GameReview }
  | { readonly status: "absent"; readonly reason: ReviewAbsence };

/** The Lichess id inside a provider URL, or null if it is not one. */
export function lichessIdFrom(providerUrl: string | null): string | null {
  if (!providerUrl) return null;
  try {
    const parsed = new URL(providerUrl);
    if (parsed.protocol !== "https:" || parsed.hostname !== "lichess.org") return null;
    const segment = parsed.pathname.split("/").filter(Boolean)[0] ?? "";
    return /^[A-Za-z0-9]{8}(?:[A-Za-z0-9]{4})?$/.test(segment) ? segment : null;
  } catch {
    return null;
  }
}

/**
 * Forma's id for a game the caller knows by its Lichess id.
 *
 * Matches on the first eight characters because Lichess game ids are eight and
 * the URLs in a synced record sometimes carry the twelve-character move id of a
 * particular position. Those share a prefix, and comparing the whole string
 * would fail to match a game that is plainly there.
 */
interface ReviewDependencies {
  recentGames(limit: number): ReturnType<typeof fetchRecentGamesStrict>;
  review(gameId: string): Promise<GameReview>;
}

const REVIEW_DEPENDENCIES: ReviewDependencies = {
  recentGames: fetchRecentGamesStrict,
  review: (gameId) => v1Data<GameReview>(`/v1/games/${encodeURIComponent(gameId)}/review`),
};

async function resolveGameId(
  lichessId: string,
  window: number,
  dependencies: ReviewDependencies,
): Promise<string | null> {
  const games = await dependencies.recentGames(Math.min(12, Math.max(1, window)));
  const wanted = lichessId.slice(0, 8);
  for (const game of games) {
    const id = lichessIdFrom(game.providerUrl);
    // Lichess ids are case-sensitive. Folding case can resolve a different game
    // whose token differs only by letter case.
    if (id && id.slice(0, 8) === wanted) return game.id;
  }
  return null;
}

/**
 * The published review for a game known by its Lichess id.
 *
 * The three absences are kept apart because they read differently to a person:
 * "we have not synced this game", "we have not analysed it yet", and "we could
 * not reach the server" are three different things to be told, and collapsing
 * them into one empty panel tells the reader none of them.
 */
export async function fetchReviewByLichessId(
  lichessId: string,
  window = 12,
  dependencies: ReviewDependencies = REVIEW_DEPENDENCIES,
): Promise<ReviewLookup> {
  if (!lichessId) return { status: "absent", reason: "not_synced" };
  try {
    const gameId = await resolveGameId(lichessId, window, dependencies);
    if (!gameId) return { status: "absent", reason: "not_synced" };

    const review = await dependencies.review(gameId);
    // A 404 here is the same answer the API gives for a game belonging to
    // someone else, on purpose -- distinguishing them is how an identifier
    // becomes probeable. From this side it means the same thing either way:
    // there is no published review to show.
    return { status: "found", gameId, review };
  } catch (error) {
    if (error instanceof Response) throw error;
    if (error instanceof ProblemError && error.status === 404) {
      return { status: "absent", reason: "not_analyzed" };
    }
    return { status: "absent", reason: "unreachable" };
  }
}

/** The concepts detected at one ply, in the order the API returned them. */
export function conceptsAtPly(review: GameReview | null, ply: number) {
  if (!review) return [];
  return (review.events ?? []).filter((event) =>
    event.focalPly === ply);
}

/**
 * What to tell a reader when there is nothing at this move.
 *
 * `published` with nothing found is a real answer -- the game was measured and
 * this move was quiet -- and it must not read like the analysis is missing.
 */
export function conceptSectionState(
  review: GameReview | null,
  absence: ReviewAbsence | null,
): { readonly kind: "ready" } | { readonly kind: "absent"; readonly text: string } {
  if (absence === "not_synced") {
    return { kind: "absent", text: "Forma hasn't synced this game, so it hasn't been measured." };
  }
  if (absence === "unreachable") {
    return { kind: "absent", text: "Couldn't reach the analysis for this game." };
  }
  if (absence === "not_analyzed" || !review) {
    return { kind: "absent", text: "This game hasn't been analysed yet." };
  }
  if (review.sections?.events !== "published") {
    return {
      kind: "absent",
      text: "This game was analysed before Forma detected concepts, so that part of the review is unavailable.",
    };
  }
  return { kind: "ready" };
}
