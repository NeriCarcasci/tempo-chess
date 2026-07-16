/** Version of the persisted provider-neutral ingestion contract. */
export const NORMALIZED_GAME_SCHEMA_VERSION = 1 as const;

export type Platform = "lichess" | "chesscom";
export type Color = "white" | "black";
export type GameResult = "win" | "loss" | "draw";
export type Speed =
  | "bullet"
  | "blitz"
  | "rapid"
  | "classical"
  | "correspondence";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Provider evaluation normalized to White's point of view. */
export interface ProviderEvaluation {
  source: Platform;
  /** Centipawns from White's point of view, or null for a mate score. */
  centipawns: number | null;
  /** Signed moves-to-mate from White's point of view, or null for a cp score. */
  mate: number | null;
  /** Provider-supplied move accuracy on a 0..100 scale, when present. */
  accuracy: number | null;
}

export interface ProviderMoveAnnotations {
  /** Human/provider comment with clock/eval directives removed where practical. */
  comment: string | null;
  /** PGN numeric or symbolic annotation glyphs. Empty means none were supplied. */
  nags: string[];
  /** Lossless provider extras. Empty means the provider supplied no extras. */
  raw: Record<string, JsonValue>;
}

/**
 * One provider-neutral move. Nullable fields mean the source did not supply a
 * trustworthy value; zero is always a real measured value. FENs describe the
 * standard six-field FEN immediately before and after the move.
 */
export interface NormalizedMove {
  /** One-based half-move index. */
  ply: number;
  moveNumber: number;
  color: Color;
  uci: string;
  san: string;
  fenBefore: string;
  fenAfter: string;
  /** Player's remaining clock immediately after the move, in milliseconds. */
  clockMs: number | null;
  /** Time spent on the move, in milliseconds; null when not derivable. */
  thinkTimeMs: number | null;
  providerEvaluation: ProviderEvaluation | null;
  annotations: ProviderMoveAnnotations;
}

export interface ProviderPlayerIdentity {
  /** Provider display name. Null represents an anonymous/deleted player. */
  username: string | null;
  /** Provider-stable player ID if distinct from username and supplied. */
  providerId: string | null;
  rating: number | null;
}

export interface GameProvenance {
  provider: Platform;
  platformGameId: string;
  /** Connected account as supplied by the provider, retained for filtering. */
  accountUsername: string;
  accountProviderId: string | null;
  sourceUrl: string | null;
  fetchedAt: Date;
}

/**
 * A game normalized across providers from the connected account's perspective.
 *
 * Absence semantics: normalized output uses `null` for unavailable scalar
 * values and empty arrays/maps for known-empty collections. Adapters must not
 * omit properties or use `undefined`, which would be lost during JSON storage.
 */
export interface NormalizedGame {
  schemaVersion: typeof NORMALIZED_GAME_SCHEMA_VERSION;
  /** Stable ID derived from provider + provider game ID, not mutable metadata. */
  canonicalGameId: string;
  /** Strong normalized-PGN fingerprint used only for evidence-based deduping. */
  pgnFingerprint: string;
  provenance: GameProvenance;
  players: {
    white: ProviderPlayerIdentity;
    black: ProviderPlayerIdentity;
  };
  /** Provider-calculated whole-game accuracy, kept separate from move evals. */
  providerAccuracy: { white: number | null; black: number | null } | null;
  moves: NormalizedMove[];

  // Compatibility aliases retained while ingestion storage migrates.
  platform: Platform;
  platformGameId: string;
  url: string | null;
  playedAt: Date | null;
  color: Color;
  result: GameResult;
  termination: string | null;
  speed: Speed | null;
  timeControl: string | null;
  userRating: number | null;
  opponentUsername: string | null;
  opponentRating: number | null;
  eco: string | null;
  openingName: string | null;
  plyCount: number;
  pgn: string;
}
