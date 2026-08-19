import { createHash } from "node:crypto";

import {
  CALIBRATION_POLICY_VERSION,
  PROVIDERS,
  RETAINED_MOVE_LIMIT,
  SPEEDS,
  type Provider,
  type Speed,
} from "./contract.js";

/**
 * A raw move probability as the model reported it, before Forma decides what to
 * keep.
 */
export interface RawPolicyMove {
  uci: string;
  probability: number;
}

/** One move Forma kept, with the rank it was kept at. */
export interface RetainedPolicyMove {
  rank: number;
  uci: string;
  probability: number;
}

export interface PolicyDistribution {
  moves: readonly RetainedPolicyMove[];
  /** Mass on the retained moves. */
  retainedMass: number;
  /** Mass the model assigned to moves we did not keep. */
  unretainedMass: number;
  /**
   * Shannon entropy in bits over the retained moves plus the unretained mass
   * treated as one symbol.
   */
  entropyBits: number;
  /**
   * True when `entropyBits` understates the model's real entropy, which happens
   * whenever mass was dropped: splitting that lump across several moves can
   * only raise entropy, never lower it.
   */
  entropyIsLowerBound: boolean;
}

const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

/**
 * Normalize a model's raw output into the distribution Forma stores.
 *
 * Three things happen here and each is a decision worth naming:
 *
 * 1. The distribution is renormalized. Models return policy over legal moves
 *    with small numerical drift; a distribution that sums to 0.997 would make
 *    every downstream bound wrong by an amount nobody could later attribute.
 * 2. Only the top `limit` moves are kept, and the mass of everything else is
 *    recorded rather than discarded. `unretainedMass` is what stops a truncated
 *    distribution from being read as a complete one.
 * 3. Entropy is computed with the unretained mass as a single symbol, and the
 *    result is flagged as a lower bound whenever that mass is non-zero.
 *
 * Ties are broken by UCI so the same input always produces the same ranks; a
 * cache key over an unstable order would miss on every second call.
 */
export function normalizePolicy(
  raw: readonly RawPolicyMove[],
  limit: number = RETAINED_MOVE_LIMIT,
): PolicyDistribution {
  if (limit < 1) throw new Error("policy retention limit must be at least 1");
  for (const move of raw) {
    if (!UCI.test(move.uci)) throw new Error(`not a UCI move: ${move.uci}`);
    if (!Number.isFinite(move.probability) || move.probability < 0) {
      throw new Error(`move ${move.uci} has a probability that is not a probability`);
    }
  }

  const total = raw.reduce((sum, move) => sum + move.probability, 0);
  if (total <= 0) throw new Error("policy assigns no mass to any move");

  const sorted = [...raw]
    .map((move) => ({ uci: move.uci, probability: move.probability / total }))
    .sort((a, b) => b.probability - a.probability || (a.uci < b.uci ? -1 : a.uci > b.uci ? 1 : 0));

  const kept = sorted.slice(0, limit);
  const moves = kept.map((move, index) => ({ rank: index + 1, ...move }));
  const retainedMass = moves.reduce((sum, move) => sum + move.probability, 0);
  // Clamped rather than subtracted raw: floating-point summation of the kept
  // moves can exceed 1 by an ulp, and a negative unretained mass would fail a
  // check constraint for a reason that has nothing to do with the model.
  const unretainedMass = Math.min(1, Math.max(0, 1 - retainedMass));

  let entropyBits = 0;
  for (const move of moves) {
    if (move.probability > 0) entropyBits -= move.probability * Math.log2(move.probability);
  }
  if (unretainedMass > 0) entropyBits -= unretainedMass * Math.log2(unretainedMass);

  return {
    moves,
    retainedMass: Math.min(1, retainedMass),
    unretainedMass,
    entropyBits,
    entropyIsLowerBound: unretainedMass > 0,
  };
}

/**
 * The declared input context of one inference.
 *
 * Every field is optional except the two booleans, because the honest answer to
 * "what was the opponent rated" is often "we do not know". What is not optional
 * is saying so: a null here changes the cache key, so an inference made without
 * a rating is never reused as one made with it.
 */
export interface InferenceContext {
  provider: Provider | null;
  actorRating: number | null;
  opponentRating: number | null;
  speed: Speed | null;
  clockBucket: string | null;
  hasMoveHistory: boolean;
}

export interface ContextRequirement {
  /** Fields the model's input contract declares it uses. */
  requires: readonly (keyof InferenceContext)[];
}

/**
 * Whether the context supplies everything the model's contract declares it uses.
 *
 * A model told to condition on a rating it was not given is not producing a
 * slightly worse answer, it is producing an answer to a different question. The
 * caller turns a false here into `context_incomplete`, not into a default.
 */
export function contextSatisfies(
  context: InferenceContext,
  requirement: ContextRequirement,
): { complete: boolean; missing: readonly string[] } {
  const missing = requirement.requires.filter((field) => {
    const value = context[field];
    return value === null || value === undefined;
  });
  return { complete: missing.length === 0, missing };
}

/**
 * The cache key for one inference.
 *
 * It covers the model version, the position, the whole declared context and the
 * retention limit. The retention limit is in there because two inferences that
 * kept different numbers of moves have different unretained mass, and reusing
 * one for the other would silently change every bound derived from it.
 */
export function inferenceCacheKey(input: {
  modelComponentVersionId: string;
  modelContentHash: string;
  corePositionKey: string;
  outputKind: string;
  context: InferenceContext;
  retainedMoveLimit: number;
}): string {
  const context = input.context;
  const canonical = [
    `model=${input.modelComponentVersionId}`,
    `hash=${input.modelContentHash}`,
    `position=${input.corePositionKey}`,
    `kind=${input.outputKind}`,
    `provider=${context.provider ?? "-"}`,
    `actor=${context.actorRating ?? "-"}`,
    `opponent=${context.opponentRating ?? "-"}`,
    `speed=${context.speed ?? "-"}`,
    `clock=${context.clockBucket ?? "-"}`,
    `history=${context.hasMoveHistory ? "1" : "0"}`,
    `limit=${input.retainedMoveLimit}`,
    `policy=${CALIBRATION_POLICY_VERSION}`,
  ].join("|");
  return createHash("sha256").update(canonical).digest("hex");
}

/** The hash of the input contract itself, so a contract change invalidates reuse. */
export function inputContractHash(contract: {
  name: string;
  requires: readonly string[];
}): string {
  return createHash("sha256")
    .update(`${contract.name}:${[...contract.requires].sort().join(",")}`)
    .digest("hex");
}

export function isProvider(value: string): value is Provider {
  return (PROVIDERS as readonly string[]).includes(value);
}

export function isSpeed(value: string): value is Speed {
  return (SPEEDS as readonly string[]).includes(value);
}
