export type Platform = "lichess" | "chesscom";
export type Color = "white" | "black";
export type GameResult = "win" | "loss" | "draw";
export type Speed =
  | "bullet"
  | "blitz"
  | "rapid"
  | "classical"
  | "correspondence";

/**
 * A game normalized across platforms, from the connected account's
 * perspective (color + result are relative to that account's username).
 * The raw `pgn` is destined for GCS; the rest maps onto the `games` table.
 */
export interface NormalizedGame {
  platform: Platform;
  platformGameId: string;
  url?: string;
  playedAt?: Date;
  color: Color;
  result: GameResult;
  termination?: string;
  speed?: Speed;
  timeControl?: string;
  userRating?: number;
  opponentUsername?: string;
  opponentRating?: number;
  eco?: string;
  openingName?: string;
  plyCount?: number;
  pgn: string;
}
