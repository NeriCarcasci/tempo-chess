/**
 * What makes two pastes the same game.
 *
 * The rating is expensive and deterministic, so it is computed once per game and
 * served forever. That only works if "the same game" is a fact rather than a
 * guess, which is what this key is.
 *
 * It covers the starting position, the moves, and any declared ratings, because
 * those are exactly the inputs the rating reads. Three deliberate exclusions:
 *
 * - **The result.** The metric never reads who won, so two pastes that disagree
 *   about the result tag must not produce two rows. `createPgnFingerprint` does
 *   include it, which is right for import dedup and wrong here.
 * - **The headers.** Names, event, date. A game is the same game whoever the
 *   PGN says played it.
 * - **Formatting.** Comments, clock annotations, move numbering.
 *
 * The method hash is deliberately *not* in here. The key identifies the game;
 * the storage row is keyed by game and method together, so one game can carry a
 * rating under each method version and a published number never moves under a
 * reader.
 */

import { createHash } from "node:crypto";

import { canonicalJson } from "../v1/canonical-json.js";

export const GAME_KEY_VERSION = "1";

export interface GameKeyInput {
  /** The position the game starts from, so a puzzle or a FEN tag is honoured. */
  startingFen: string;
  /** Moves in UCI, in order. */
  moves: readonly string[];
  /** Declared ratings, when the PGN or the caller supplied them. */
  whiteRating: number | null;
  blackRating: number | null;
}

export function gameKey(input: GameKeyInput): string {
  if (input.moves.length === 0) throw new Error("cannot key a game with no moves");
  const digest = createHash("sha256")
    .update(
      canonicalJson({
        version: GAME_KEY_VERSION,
        startingFen: input.startingFen,
        moves: input.moves.map((move) => move.trim().toLowerCase()),
        whiteRating: input.whiteRating,
        blackRating: input.blackRating,
      }),
      "utf8",
    )
    .digest("hex");
  return `game:v${GAME_KEY_VERSION}:sha256:${digest}`;
}

/** The resource a rating workflow is about, so the chain is findable by game. */
export const RATING_RESOURCE_TYPE = "game_rating";
