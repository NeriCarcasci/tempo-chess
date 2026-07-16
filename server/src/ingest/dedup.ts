import type { Platform } from "./types.js";

export interface IncomingGameIdentity {
  userId: string;
  accountId: string;
  platform: Platform;
  platformGameId: string;
  canonicalGameId: string;
  pgnFingerprint: string;
}

export interface StoredGameIdentity extends IncomingGameIdentity {
  gameId: string;
}

export type DuplicateDecision =
  | { kind: "new" }
  | { kind: "provider-reimport"; gameId: string; attachAccountSource: boolean }
  | {
      kind: "fingerprint-candidate";
      gameId: string;
      /** Replay equality alone must not cause an automatic merge. */
      autoMerge: false;
    };

/**
 * Classifies only candidates already scoped to the same Tempo user. Provider
 * identity wins and is safe to merge. A normalized replay fingerprint detects
 * candidates across exports/providers but deliberately does not merge them:
 * unrelated games can have identical short replays. A second provider source
 * is attached only when provider game identity proves it is the same game.
 */
export function classifyDuplicate(
  incoming: IncomingGameIdentity,
  candidates: readonly StoredGameIdentity[],
): DuplicateDecision {
  const sameUser = candidates.filter((candidate) => candidate.userId === incoming.userId);
  const providerMatch = sameUser.find(
    (candidate) =>
      candidate.platform === incoming.platform &&
      candidate.platformGameId === incoming.platformGameId &&
      candidate.canonicalGameId === incoming.canonicalGameId,
  );
  if (providerMatch) {
    return {
      kind: "provider-reimport",
      gameId: providerMatch.gameId,
      attachAccountSource: providerMatch.accountId !== incoming.accountId,
    };
  }

  const fingerprintMatch = sameUser.find(
    (candidate) => candidate.pgnFingerprint === incoming.pgnFingerprint,
  );
  if (fingerprintMatch) {
    return {
      kind: "fingerprint-candidate",
      gameId: fingerprintMatch.gameId,
      autoMerge: false,
    };
  }
  return { kind: "new" };
}
