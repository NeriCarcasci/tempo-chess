import { probabilityGreater } from "./beta.js";
import { PHASE_CONTRAST_POLICY, type PhaseContrastPolicy } from "./contract.js";
import { estimate, type Estimate, type EstimateResult, type Observation } from "./estimator.js";
import type { Phase } from "./specificity.js";

/**
 * Phase as something a finding can be about.
 *
 * Every finding this module's neighbours produce is about one concept in one
 * role, so the report could say a great deal about material safety and nothing
 * at all about the shape of a game. In the account this was built against that
 * omission was hiding the single most useful thing in the data: across 12,683
 * recorded chances the player took 44% of them in the opening and 67% in the
 * endgame. A 22-point spread over that much evidence is not noise, it is the
 * opposite of what most players believe about themselves, and no per-concept
 * finding could ever have surfaced it.
 *
 * ## Why the comparison is restricted to shared concepts
 *
 * Pooling every concept into one rate per phase and comparing the pools is
 * wrong, and confidently wrong. The concepts are not the same mix in every
 * phase: `winning_conversion` only ever fires once a game is already won,
 * `material_safety` fires from move one. A phase that happens to contain the
 * easier chances will look like a phase the player is better in, and the report
 * would be describing the detectors rather than the person.
 *
 * So the contrast is computed over the concept-and-role strata that carry real
 * evidence in *both* phases being compared, and nothing else. "On the same
 * kinds of chance, you do better here than there" is a claim about the player.
 * "You score higher in the endgame" is a claim about which chances the endgame
 * contains.
 *
 * The per-phase pooled rate is still computed and still published — a card
 * saying "this is your endgame" is a useful description and the read model
 * labels it as a pooled hit rate. It is just not what the finding rests on.
 */

/** The three phases, in the order a game meets them. */
export const PHASE_ORDER: readonly Phase[] = Object.freeze(["opening", "middlegame", "endgame"]);

/** Everything recorded in one phase, split by the concept and role it belongs to. */
export type PhaseStrata = ReadonlyMap<Phase, ReadonlyMap<string, readonly Observation[]>>;

export interface PhaseContrast {
  readonly weakest: Phase;
  readonly strongest: Phase;
  /** Estimated over the shared strata only, not over everything in the phase. */
  readonly weakestEstimate: Estimate;
  readonly strongestEstimate: Estimate;
  /** The concept-and-role keys the two phases were compared on. */
  readonly sharedStrata: readonly string[];
  /** P(the stronger phase's rate really is the higher one), after correction. */
  readonly probability: number;
  /** How many phase pairs were comparable, which is what was corrected for. */
  readonly comparedPairs: number;
}

function uncensored(observations: readonly Observation[]): number {
  let count = 0;
  for (const observation of observations) if (!observation.censored) count += 1;
  return count;
}

/**
 * The strata two phases can honestly be compared on.
 *
 * A stratum counts only if both phases carry enough uncensored evidence of it.
 * One side having three observations and the other ninety is not a comparison,
 * it is the ninety with a rounding error attached.
 */
function sharedStrata(
  a: ReadonlyMap<string, readonly Observation[]>,
  b: ReadonlyMap<string, readonly Observation[]>,
  policy: PhaseContrastPolicy,
): string[] {
  const shared: string[] = [];
  for (const [key, here] of a) {
    const there = b.get(key);
    if (there === undefined) continue;
    if (uncensored(here) < policy.minPerStratum) continue;
    if (uncensored(there) < policy.minPerStratum) continue;
    shared.push(key);
  }
  return shared.sort();
}

function pool(
  strata: ReadonlyMap<string, readonly Observation[]>,
  keys: readonly string[],
): Observation[] {
  const pooled: Observation[] = [];
  for (const key of keys) pooled.push(...(strata.get(key) ?? []));
  return pooled;
}

/**
 * The one phase contrast a report may claim, or null.
 *
 * Only the extremes are contrasted: the phase with the lowest pooled rate
 * against the one with the highest. That is the comparison a person makes and
 * it keeps the report to one sentence about phases rather than three.
 *
 * Choosing the extremes by their point estimates is a selection, and a
 * probability computed after a selection is optimistic. It is corrected for
 * explicitly — the p-value is multiplied by the number of phase pairs that
 * were comparable at all, which is the family the selection searched — so what
 * reaches the false-discovery control downstream is already honest about
 * having looked three times.
 */
export function buildPhaseContrast(
  strata: PhaseStrata,
  cutoff: Date,
  policy: PhaseContrastPolicy = PHASE_CONTRAST_POLICY,
): PhaseContrast | null {
  const pairs: { low: Phase; high: Phase; shared: string[] }[] = [];
  for (let i = 0; i < PHASE_ORDER.length; i += 1) {
    for (let j = i + 1; j < PHASE_ORDER.length; j += 1) {
      const a = strata.get(PHASE_ORDER[i]!);
      const b = strata.get(PHASE_ORDER[j]!);
      if (a === undefined || b === undefined) continue;
      const shared = sharedStrata(a, b, policy);
      if (shared.length < policy.minSharedStrata) continue;
      pairs.push({ low: PHASE_ORDER[i]!, high: PHASE_ORDER[j]!, shared });
    }
  }
  if (pairs.length === 0) return null;

  let best: {
    weakest: Phase;
    strongest: Phase;
    weakestEstimate: Estimate;
    strongestEstimate: Estimate;
    shared: string[];
    gap: number;
  } | null = null;

  for (const pair of pairs) {
    const first = estimate(pool(strata.get(pair.low)!, pair.shared), cutoff);
    const second = estimate(pool(strata.get(pair.high)!, pair.shared), cutoff);
    if (first.status !== "available" || second.status !== "available") continue;
    const [weakest, weakestEstimate, strongest, strongestEstimate] =
      first.estimate <= second.estimate
        ? ([pair.low, first, pair.high, second] as const)
        : ([pair.high, second, pair.low, first] as const);
    const gap = strongestEstimate.estimate - weakestEstimate.estimate;
    if (gap < policy.minGap) continue;
    if (best === null || gap > best.gap) {
      best = {
        weakest,
        strongest,
        weakestEstimate,
        strongestEstimate,
        shared: pair.shared,
        gap,
      };
    }
  }
  if (best === null) return null;

  const raw = probabilityGreater(
    best.strongestEstimate.posterior,
    best.weakestEstimate.posterior,
  );
  const corrected = 1 - Math.min(1, (1 - raw) * pairs.length);

  return {
    weakest: best.weakest,
    strongest: best.strongest,
    weakestEstimate: best.weakestEstimate,
    strongestEstimate: best.strongestEstimate,
    sharedStrata: best.shared,
    probability: corrected,
    comparedPairs: pairs.length,
  };
}

/**
 * The pooled rate for one phase, over everything recorded in it.
 *
 * This is the number a phase card shows, and it is a different quantity from
 * the one the contrast is built on: it mixes concepts, so it answers "of every
 * chance Forma saw in your endgames, how many did you take" rather than "are
 * you better in the endgame". Both are true; only the second is a finding, and
 * the read model has to label which is which.
 */
export function poolPhase(
  strata: ReadonlyMap<string, readonly Observation[]> | undefined,
  cutoff: Date,
): EstimateResult {
  const pooled: Observation[] = [];
  for (const [, observations] of strata ?? []) pooled.push(...observations);
  return estimate(pooled, cutoff);
}
