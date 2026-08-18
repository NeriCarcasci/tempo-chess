/**
 * What Forma will and will not accept from a provider, and how it normalizes
 * what it does.
 *
 * The rejection rules are here, above any HTTP client, because they must run
 * before persistence and must be testable without a provider. A game refused
 * here leaves nothing behind: the caller increments a counter by reason and
 * moves on, and no id, URL or replay reaches a row.
 *
 * Sources: plans/database-architecture.md §9, plans/v1-platform-spec.md §§6.3,
 * 7-9.
 */

import { createHash } from "node:crypto";

export const SYNC_MODES = ["initial", "incremental", "reconcile"] as const;
export type SyncMode = (typeof SYNC_MODES)[number];

export const SYNC_STATES = ["running", "succeeded", "failed", "cancelled"] as const;
export type SyncState = (typeof SYNC_STATES)[number];

/**
 * Why a game was not retained.
 *
 * Aggregated by reason on the sync run. The set is closed so a count is
 * comparable across runs, and no member carries a detail that could identify
 * the game it refers to.
 */
export const REJECTION_REASONS = [
  "non_standard_variant",
  "not_finished",
  "empty_replay",
  "unsupported_result",
  "malformed",
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

export const REVISION_REASONS = ["first_seen", "provider_correction", "renormalized"] as const;
export type RevisionReason = (typeof REVISION_REASONS)[number];

/** The normalizer's identity, recorded on every revision it produces. */
export const NORMALIZER_VERSION = "e08-normalizer-1";

/** Absolute result, never relative to a player. */
export type GameResult = "white" | "black" | "draw";

export interface ProviderGameInput {
  providerGameId: string;
  variant?: string | null;
  status?: string | null;
  /** Absolute winner, or null for a draw. Undefined means unfinished. */
  winner?: "white" | "black" | null;
  moves: readonly { uci: string; san?: string; clockMs?: number | null }[];
  playedAt: string | Date;
  completedAt?: string | Date | null;
  rated?: boolean | null;
  speed?: string | null;
  timeControl?: string | null;
  termination?: string | null;
  initialFen?: string | null;
  url?: string | null;
  white?: ProviderParticipantInput;
  black?: ProviderParticipantInput;
}

export interface ProviderParticipantInput {
  username?: string | null;
  title?: string | null;
  rating?: number | null;
  ratingChange?: number | null;
  isBot?: boolean | null;
  isProvisional?: boolean | null;
}

export interface NormalizedGame {
  providerGameId: string;
  normalizedReplay: { moves: { uci: string; san: string | null; clockMs: number | null }[] };
  normalizedSha256: string;
  plyCount: number;
  result: GameResult;
  playedAt: Date;
  completedAt: Date | null;
  rated: boolean | null;
  speed: string | null;
  timeControl: string | null;
  termination: string | null;
  initialFen: string | null;
  providerUrl: string | null;
  participants: {
    color: "white" | "black";
    username: string | null;
    title: string | null;
    rating: number | null;
    ratingChange: number | null;
    outcome: "win" | "loss" | "draw";
    isBot: boolean | null;
    isProvisional: boolean | null;
  }[];
}

export type NormalizeOutcome =
  | { accepted: true; game: NormalizedGame }
  | { accepted: false; reason: RejectionReason };

/** Statuses both providers use for a game that has not finished. */
const UNFINISHED = new Set(["started", "created", "aborted", "unknownfinish", "ongoing"]);

/**
 * The one variant Forma analyses.
 *
 * Both providers spell standard chess differently and sometimes omit it
 * entirely, so absence means standard and anything named is checked.
 */
function isStandard(variant: string | null | undefined): boolean {
  if (!variant) return true;
  const value = variant.trim().toLowerCase();
  return value === "standard" || value === "chess" || value === "fromposition";
}

function asDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Normalize a provider game, or say why it was refused.
 *
 * Every refusal happens before anything is written, and the reason is a closed
 * enum rather than a message, so the aggregate on the sync run cannot leak the
 * game it came from.
 */
export function normalizeGame(input: ProviderGameInput): NormalizeOutcome {
  if (!input.providerGameId || !Array.isArray(input.moves)) {
    return { accepted: false, reason: "malformed" };
  }
  if (!isStandard(input.variant)) {
    return { accepted: false, reason: "non_standard_variant" };
  }
  if (input.status && UNFINISHED.has(input.status.trim().toLowerCase())) {
    return { accepted: false, reason: "not_finished" };
  }
  if (input.winner === undefined) {
    // Unfinished games do not report a winner at all; a draw reports null.
    return { accepted: false, reason: "not_finished" };
  }
  if (input.moves.length === 0) {
    return { accepted: false, reason: "empty_replay" };
  }

  const playedAt = asDate(input.playedAt);
  if (Number.isNaN(playedAt.getTime())) {
    return { accepted: false, reason: "malformed" };
  }

  const result: GameResult = input.winner === null ? "draw" : input.winner;
  if (result !== "white" && result !== "black" && result !== "draw") {
    return { accepted: false, reason: "unsupported_result" };
  }

  const moves = input.moves.map((move) => ({
    uci: move.uci,
    san: move.san ?? null,
    // A clock that was never reported stays null. Rendering an unknown clock
    // as zero would make "no clock data" indistinguishable from "flagged".
    clockMs: move.clockMs ?? null,
  }));
  if (moves.some((move) => !move.uci)) {
    return { accepted: false, reason: "malformed" };
  }

  const normalizedReplay = { moves };
  const completedAt = input.completedAt ? asDate(input.completedAt) : null;

  return {
    accepted: true,
    game: {
      providerGameId: input.providerGameId,
      normalizedReplay,
      normalizedSha256: replayDigest(normalizedReplay, result),
      plyCount: moves.length,
      result,
      playedAt,
      completedAt: completedAt && !Number.isNaN(completedAt.getTime()) ? completedAt : null,
      rated: input.rated ?? null,
      speed: input.speed ?? null,
      timeControl: input.timeControl ?? null,
      termination: input.termination ?? null,
      initialFen: input.initialFen ?? null,
      providerUrl: input.url ?? null,
      participants: [
        participant("white", result, input.white),
        participant("black", result, input.black),
      ],
    },
  };
}

function participant(
  color: "white" | "black",
  result: GameResult,
  input: ProviderParticipantInput | undefined,
): NormalizedGame["participants"][number] {
  const outcome = result === "draw" ? "draw" : result === color ? "win" : "loss";
  return {
    color,
    username: input?.username ?? null,
    title: input?.title ?? null,
    rating: input?.rating ?? null,
    ratingChange: input?.ratingChange ?? null,
    outcome,
    isBot: input?.isBot ?? null,
    isProvisional: input?.isProvisional ?? null,
  };
}

/**
 * The digest that decides whether a re-fetch is the same replay.
 *
 * Over the moves and the result only. Ratings, clocks-at-fetch-time and
 * provider annotations change without the game changing, and including them
 * would make every re-fetch look like a correction.
 */
export function replayDigest(
  replay: { moves: { uci: string; san: string | null; clockMs: number | null }[] },
  result: GameResult,
): string {
  const canonical = JSON.stringify({
    result,
    moves: replay.moves.map((move) => [move.uci, move.san ?? null, move.clockMs ?? null]),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** Tally rejections without ever naming a game. */
export function tallyRejections(reasons: readonly RejectionReason[]): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const reason of reasons) summary[reason] = (summary[reason] ?? 0) + 1;
  return summary;
}

/**
 * The colour a subject played, or null when it cannot be told.
 *
 * Returns null when both sides match, which the caller records as `ambiguous`
 * rather than guessing: §9.4 excludes such a game until a human resolves it.
 */
export function subjectColor(
  game: Pick<NormalizedGame, "participants">,
  subjectIdentityUsernames: readonly string[],
): "white" | "black" | null {
  const owned = new Set(subjectIdentityUsernames.map((name) => name.trim().toLowerCase()));
  const white = game.participants.find((p) => p.color === "white")?.username?.toLowerCase() ?? "";
  const black = game.participants.find((p) => p.color === "black")?.username?.toLowerCase() ?? "";
  const isWhite = owned.has(white);
  const isBlack = owned.has(black);
  if (isWhite && isBlack) return null;
  if (isWhite) return "white";
  if (isBlack) return "black";
  return null;
}
