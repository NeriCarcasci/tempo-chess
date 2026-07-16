import { createHash } from "node:crypto";
import {
  NORMALIZED_GAME_SCHEMA_VERSION,
  type Color,
  type GameResult,
  type NormalizedGame,
  type NormalizedMove,
  type Platform,
} from "./types.js";

const CANONICAL_ID_VERSION = 1;
const FINGERPRINT_VERSION = 1;

function requireNonBlank(value: string, label: string): string {
  const normalized = value.trim().normalize("NFC");
  if (!normalized) throw new Error(`${label} must not be blank`);
  return normalized;
}

export function normalizeProviderUsername(username: string): string {
  return requireNonBlank(username, "provider username").toLocaleLowerCase("en-US");
}

/** Stable across reimports because it excludes URLs, account and mutable PGN metadata. */
export function createCanonicalGameId(
  provider: Platform,
  platformGameId: string,
): string {
  const sourceId = requireNonBlank(platformGameId, "platform game ID");
  return `game:v${CANONICAL_ID_VERSION}:${provider}:${encodeURIComponent(sourceId)}`;
}

export interface PgnFingerprintInput {
  moves: readonly Pick<NormalizedMove, "ply" | "uci" | "fenBefore">[];
  /** Retained for call-site stability; identity metadata is deliberately excluded. */
  whiteUsername: string | null;
  blackUsername: string | null;
  /** Result from the connected account's perspective. */
  result: GameResult;
  connectedColor: Color;
  playedAt: Date | null;
}

function absoluteResult(result: GameResult, connectedColor: Color): string {
  if (result === "draw") return "1/2-1/2";
  const whiteWon = (result === "win") === (connectedColor === "white");
  return whiteWon ? "1-0" : "0-1";
}

/**
 * Fingerprints the normalized replay, not raw PGN formatting or provider
 * identity metadata. This intentionally detects the same imported PGN even if
 * handles or timestamp precision differ. Fingerprint equality is a candidate
 * signal only; it is never sufficient for automatic merging.
 */
export function createPgnFingerprint(input: PgnFingerprintInput): string {
  if (input.moves.length === 0) throw new Error("cannot fingerprint a game with no moves");
  const ordered = [...input.moves].sort((a, b) => a.ply - b.ply);
  ordered.forEach((move, index) => {
    if (move.ply !== index + 1) throw new Error("moves must contain contiguous one-based plies");
    requireNonBlank(move.uci, `UCI move at ply ${move.ply}`);
  });

  const evidence = {
    version: FINGERPRINT_VERSION,
    startingFen: ordered[0].fenBefore,
    result: absoluteResult(input.result, input.connectedColor),
    moves: ordered.map((move) => move.uci.trim().toLowerCase()),
  };
  return `pgn:v${FINGERPRINT_VERSION}:sha256:${createHash("sha256")
    .update(JSON.stringify(evidence))
    .digest("hex")}`;
}

function assertPercentage(value: number | null, label: string): void {
  if (value !== null && (!Number.isFinite(value) || value < 0 || value > 100)) {
    throw new Error(`${label} must be null or between 0 and 100`);
  }
}

/** Runtime boundary check for provider adapters before normalized data persists. */
export function validateNormalizedGame(game: NormalizedGame): NormalizedGame {
  if (game.schemaVersion !== NORMALIZED_GAME_SCHEMA_VERSION) {
    throw new Error(`unsupported normalized game schema version: ${game.schemaVersion}`);
  }
  if (game.platform !== game.provenance.provider) {
    throw new Error("platform must match provenance provider");
  }
  if (game.platformGameId !== game.provenance.platformGameId) {
    throw new Error("platformGameId must match provenance platformGameId");
  }
  const expectedId = createCanonicalGameId(game.platform, game.platformGameId);
  if (game.canonicalGameId !== expectedId) throw new Error("canonicalGameId is invalid");
  if (game.plyCount !== game.moves.length) throw new Error("plyCount must equal moves.length");
  game.moves.forEach((move, index) => {
    if (move.ply !== index + 1) throw new Error("moves must be ordered contiguous one-based plies");
    const fenFields = move.fenBefore.trim().split(/\s+/);
    const activeColor = fenFields[1];
    if (activeColor !== "w" && activeColor !== "b") {
      throw new Error(`invalid fenBefore active color at ply ${move.ply}`);
    }
    const expectedColor: Color = activeColor === "w" ? "white" : "black";
    if (move.color !== expectedColor) throw new Error(`invalid color at ply ${move.ply}`);
    const expectedMoveNumber = Number(fenFields[5]);
    if (!Number.isSafeInteger(expectedMoveNumber) || expectedMoveNumber < 1) {
      throw new Error(`invalid fenBefore fullmove number at ply ${move.ply}`);
    }
    if (move.moveNumber !== expectedMoveNumber) {
      throw new Error(`invalid moveNumber at ply ${move.ply}`);
    }
    if (index > 0 && move.fenBefore !== game.moves[index - 1].fenAfter) {
      throw new Error(`broken FEN chain at ply ${move.ply}`);
    }
    if (move.clockMs !== null && move.clockMs < 0) throw new Error("clockMs cannot be negative");
    if (move.thinkTimeMs !== null && move.thinkTimeMs < 0) {
      throw new Error("thinkTimeMs cannot be negative");
    }
    if (move.providerEvaluation) {
      assertPercentage(move.providerEvaluation.accuracy, "move accuracy");
    }
  });
  if (game.providerAccuracy) {
    assertPercentage(game.providerAccuracy.white, "white game accuracy");
    assertPercentage(game.providerAccuracy.black, "black game accuracy");
  }
  const expectedFingerprint = createPgnFingerprint({
    moves: game.moves,
    whiteUsername: game.players.white.username,
    blackUsername: game.players.black.username,
    result: game.result,
    connectedColor: game.color,
    playedAt: game.playedAt,
  });
  if (game.pgnFingerprint !== expectedFingerprint) throw new Error("pgnFingerprint is invalid");
  return game;
}
