import { createHash } from "node:crypto";

import { ratingBandFor, type Provider, type Speed } from "./contract.js";

/**
 * The holdout corpus: how it is sampled, how it is addressed, and the two split
 * rules that decide whether anything measured on it means anything.
 *
 * Everything in this file is pure. The network lives in `fetch-holdout.ts`, so
 * the sampling policy can be tested without a provider and a manifest hash can
 * be recomputed from a stored corpus years later.
 */

/** One position the model will be asked to predict. */
export interface HoldoutPosition {
  /** Provider game identifier, stable and public. */
  gameKey: string;
  /** Ply index of the position, 0-based, counting from the initial position. */
  ply: number;
  fen: string;
  /** The account whose move is being predicted. */
  moverAccountKey: string;
  moverRating: number;
  opponentRating: number;
  provider: Provider;
  speed: Speed;
  /** What the human actually played. The label. */
  playedUci: string;
  /** ISO 8601 date of the game, for the chronological rule. */
  playedAt: string;
}

/**
 * The sampling policy, versioned because changing it changes every metric
 * measured under it.
 */
export interface SamplingPolicy {
  version: string;
  /**
   * Plies before this are skipped. Opening moves are memorized rather than
   * chosen, so scoring a human model on them measures book knowledge and
   * flatters every model equally.
   */
  minPly: number;
  /** Plies after this are skipped: a 200-move game should not outvote ten short ones. */
  maxPly: number;
  /** Positions with fewer legal moves than this are skipped: nothing to predict. */
  minLegalMoves: number;
  /** At most this many positions per game, after thinning. */
  maxPositionsPerGame: number;
  /** Keep one position in `stride`, chosen by hash so the choice is reproducible. */
  stride: number;
}

export const DEFAULT_SAMPLING_POLICY: SamplingPolicy = Object.freeze({
  version: "holdout_sampling_v1",
  minPly: 10,
  maxPly: 120,
  minLegalMoves: 2,
  maxPositionsPerGame: 8,
  stride: 3,
});

/** A replayed game, ready to sample from. */
export interface ReplayedGame {
  gameKey: string;
  provider: Provider;
  speed: Speed;
  playedAt: string;
  whiteAccountKey: string;
  blackAccountKey: string;
  whiteRating: number;
  blackRating: number;
  positions: readonly {
    ply: number;
    fen: string;
    legalMoveCount: number;
    playedUci: string;
  }[];
}

/**
 * Choose the positions this game contributes.
 *
 * Thinning is by hash of `gameKey:ply` rather than by index so that the choice
 * does not move when the policy's `minPly` changes, and so two runs over the
 * same corpus sample the same positions without carrying a seed around.
 */
export function selectHoldoutPositions(
  game: ReplayedGame,
  policy: SamplingPolicy = DEFAULT_SAMPLING_POLICY,
): HoldoutPosition[] {
  const selected: HoldoutPosition[] = [];
  for (const position of game.positions) {
    if (selected.length >= policy.maxPositionsPerGame) break;
    if (position.ply < policy.minPly || position.ply > policy.maxPly) continue;
    if (position.legalMoveCount < policy.minLegalMoves) continue;
    if (thinningBucket(game.gameKey, position.ply, policy.stride) !== 0) continue;

    const whiteToMove = position.ply % 2 === 0;
    const moverRating = whiteToMove ? game.whiteRating : game.blackRating;
    const opponentRating = whiteToMove ? game.blackRating : game.whiteRating;
    // A position whose mover we cannot place in a band cannot be scored into a
    // slice, and an unsliced position in the corpus inflates the total sample
    // without contributing to any claim.
    if (ratingBandFor(moverRating) === null) continue;

    selected.push({
      gameKey: game.gameKey,
      ply: position.ply,
      fen: position.fen,
      moverAccountKey: whiteToMove ? game.whiteAccountKey : game.blackAccountKey,
      moverRating,
      opponentRating,
      provider: game.provider,
      speed: game.speed,
      playedUci: position.playedUci,
      playedAt: game.playedAt,
    });
  }
  return selected;
}

function thinningBucket(gameKey: string, ply: number, stride: number): number {
  if (stride <= 1) return 0;
  const digest = createHash("sha256").update(`${gameKey}:${ply}`).digest();
  return digest.readUInt32BE(0) % stride;
}

/**
 * The manifest hash: a content address for the corpus.
 *
 * Sorted before hashing so that fetch order cannot change the address of the
 * same set of positions, and covering the label as well as the position because
 * a corpus whose labels changed is a different corpus.
 */
export function manifestHash(
  positions: readonly HoldoutPosition[],
  policy: SamplingPolicy = DEFAULT_SAMPLING_POLICY,
): string {
  const lines = positions
    .map(
      (p) =>
        `${p.provider}|${p.gameKey}|${p.ply}|${p.fen}|${p.playedUci}|${p.moverRating}|${p.opponentRating}|${p.speed}`,
    )
    .sort();
  const hash = createHash("sha256");
  hash.update(`policy=${policy.version}\n`);
  for (const line of lines) hash.update(`${line}\n`);
  return hash.digest("hex");
}

export interface SplitRuleResult {
  /** No account contributes to more than one slice. */
  accountDisjoint: boolean;
  /** Every game is strictly after the model's training window. */
  chronologicalSplit: boolean;
  /** Accounts that straddle slices, if any, for the failure message. */
  straddlingAccounts: readonly string[];
  /** Games at or before the cutoff, if any. */
  gamesBeforeCutoff: number;
  earliestPlayedAt: string | null;
}

/**
 * Check the two split rules the evidence depends on.
 *
 * `accountDisjoint` here means disjoint *between the slices of this holdout*: an
 * account whose games land in two rating bands would let one player's habits
 * count as independent evidence in both. It does not, and cannot, claim
 * disjointness from a third-party model's own training accounts — the corpus
 * that produced a public model is not enumerable by us. The chronological rule
 * is what stands in for that, and the limitation is recorded on the dataset
 * rather than assumed away.
 */
export function checkSplitRules(
  positions: readonly HoldoutPosition[],
  trainingWindowEndIso: string,
): SplitRuleResult {
  const slicesByAccount = new Map<string, Set<string>>();
  let gamesBeforeCutoff = 0;
  let earliest: string | null = null;
  const countedGames = new Set<string>();

  for (const position of positions) {
    const band = ratingBandFor(position.moverRating);
    const sliceKey = band
      ? `${position.provider}:${position.speed}:${band.low}`
      : `${position.provider}:${position.speed}:unbanded`;
    const seen = slicesByAccount.get(position.moverAccountKey) ?? new Set<string>();
    seen.add(sliceKey);
    slicesByAccount.set(position.moverAccountKey, seen);

    if (!countedGames.has(position.gameKey)) {
      countedGames.add(position.gameKey);
      if (position.playedAt <= trainingWindowEndIso) gamesBeforeCutoff += 1;
    }
    if (earliest === null || position.playedAt < earliest) earliest = position.playedAt;
  }

  const straddlingAccounts = [...slicesByAccount.entries()]
    .filter(([, slices]) => slices.size > 1)
    .map(([account]) => account)
    .sort();

  return {
    accountDisjoint: straddlingAccounts.length === 0,
    chronologicalSplit: positions.length > 0 && gamesBeforeCutoff === 0,
    straddlingAccounts,
    gamesBeforeCutoff,
    earliestPlayedAt: earliest,
  };
}

/**
 * Drop the games of accounts that straddle slices.
 *
 * Preferred over silently reassigning them: a player who crossed a band
 * boundary mid-corpus is genuine evidence about neither band, and picking one
 * for them is a decision nobody would be able to find later.
 */
export function excludeStraddlingAccounts(
  positions: readonly HoldoutPosition[],
  straddling: readonly string[],
): HoldoutPosition[] {
  if (straddling.length === 0) return [...positions];
  const drop = new Set(straddling);
  return positions.filter((p) => !drop.has(p.moverAccountKey));
}

/** Group a corpus into the slices it will be scored in. */
export function groupBySlice(
  positions: readonly HoldoutPosition[],
): Map<string, { provider: Provider; speed: Speed; bandLow: number; positions: HoldoutPosition[] }> {
  const groups = new Map<
    string,
    { provider: Provider; speed: Speed; bandLow: number; positions: HoldoutPosition[] }
  >();
  for (const position of positions) {
    const band = ratingBandFor(position.moverRating);
    if (band === null) continue;
    const key = `${position.provider}:${position.speed}:${band.low}`;
    const group = groups.get(key) ?? {
      provider: position.provider,
      speed: position.speed,
      bandLow: band.low,
      positions: [],
    };
    group.positions.push(position);
    groups.set(key, group);
  }
  return groups;
}
