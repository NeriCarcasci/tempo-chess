import { createHash } from "node:crypto";

import {
  FINDING_POLICY,
  type ConfidenceTier,
  type FindingPolicy,
  type FindingType,
  type Frame,
} from "./contract.js";
import type { Estimate, EstimateResult } from "./estimator.js";
import { improvementClaim, type Comparison } from "./estimator.js";
import { betaCdf } from "./beta.js";

/**
 * Turning estimates into claims, and refusing to publish most of them.
 *
 * A dashboard that reports every fluctuation is not informative, it is noise
 * with a confident font. Platform spec 13 requires a versioned
 * ranking/false-discovery policy rather than publishing everything, so this
 * module does three things in order: derive candidate findings from estimates,
 * control the false-discovery rate across each claim family, and cap what is
 * published.
 *
 * The refusals are the product. `insufficient_evidence` is a first-class
 * finding type because "we do not know yet, and here is what is missing" is a
 * better answer than a confident number from four observations.
 */

export interface DimensionInput {
  dimensionKey: string;
  frame: Frame;
  conceptSlug: string | null;
  role: string | null;
  claimFamily: string;
  result: EstimateResult;
  /** The comparison against a prior window, when one exists. */
  comparison: Comparison | null;
  /** Uncensored failures of this concept across the snapshot. */
  failureCount: number;
}

export interface CandidateFinding {
  dimensionKey: string;
  findingType: FindingType;
  claimFamily: string;
  /** The probability the claim is real, before correction. */
  rawProbability: number;
  adjustedProbability: number | null;
  confidenceTier: ConfidenceTier;
  priority: number;
  claim: Record<string, unknown>;
  /** True once the family's correction kept it. */
  published: boolean;
  /** Why it was dropped, when it was. */
  droppedReason: string | null;
}

/**
 * Derive the candidate findings one dimension supports.
 *
 * At most one verdict per dimension, plus an improvement claim when the
 * comparison earns one. Emitting both "this is a strength" and "this is a
 * frontier" about the same slice would be two findings from one fact.
 */
export function deriveCandidates(
  input: DimensionInput,
  policy: FindingPolicy = FINDING_POLICY,
): CandidateFinding[] {
  const candidates: CandidateFinding[] = [];

  if (input.result.status === "unavailable") {
    candidates.push({
      dimensionKey: input.dimensionKey,
      findingType: "insufficient_evidence",
      claimFamily: input.claimFamily,
      // Not a hypothesis about the player, so it is not a discovery and is not
      // corrected: it claims nothing that could be false.
      rawProbability: 1,
      adjustedProbability: null,
      confidenceTier: "low",
      priority: 10,
      claim: {
        dimension: input.dimensionKey,
        reason: input.result.reason,
        rawSample: input.result.coverage.raw,
        censored: input.result.coverage.censored,
      },
      published: true,
      droppedReason: null,
    });
    return candidates;
  }

  const estimate: Estimate = input.result;
  const width = estimate.intervalHigh - estimate.intervalLow;
  const { alpha, beta } = estimate.posterior;

  // Each claim's probability is the posterior probability that the claim is
  // true, not a proxy for how precise the estimate is. That distinction is what
  // makes the false-discovery control mean something: `P(the player is above
  // the strength floor)` is a hypothesis that can be wrong, while "the interval
  // is 0.14 wide" is a fact about our sample that no correction should be
  // applied to.
  const probabilityAbove = (bound: number): number => 1 - betaCdf(bound, alpha, beta);
  const probabilityBelow = (bound: number): number => betaCdf(bound, alpha, beta);

  const shared = {
    estimate: estimate.estimate,
    intervalLow: estimate.intervalLow,
    intervalHigh: estimate.intervalHigh,
    effectiveSample: estimate.coverage.effective,
  };

  if (estimate.intervalLow >= policy.strengthFloor) {
    candidates.push(
      verdict(input, "strength", probabilityAbove(policy.strengthFloor), 80, shared),
    );
  } else if (estimate.intervalHigh <= policy.missCeiling) {
    candidates.push(
      verdict(input, "foundational_miss", probabilityBelow(policy.missCeiling), 90, shared),
    );
  } else if (width >= policy.frontierIntervalWidth) {
    // Wide interval in the middle: the honest reading is that this is where the
    // player is still deciding, not that they are average at it. The claim is
    // "you are neither reliably good nor reliably bad here", so its probability
    // is the posterior mass between the two bounds.
    candidates.push(
      verdict(
        input,
        "development_frontier",
        probabilityBelow(policy.strengthFloor) - probabilityBelow(policy.missCeiling),
        60,
        shared,
      ),
    );
  }

  if (input.failureCount >= policy.repeatedPatternFailures) {
    // Four failures inside an otherwise strong record are noise, not a pattern.
    // The probability is that the underlying rate really is below the strength
    // floor, which is what separates the two.
    candidates.push(
      verdict(input, "repeated_pattern", probabilityBelow(policy.strengthFloor), 70, {
        failures: input.failureCount,
        estimate: estimate.estimate,
      }),
    );
  }

  if (input.comparison !== null) {
    const claim = improvementClaim(input.comparison, estimate.coverage);
    if (claim !== null) {
      candidates.push(
        verdict(input, claim, input.comparison.improvementProbability, claim === "established_improvement" ? 95 : 55, {
          delta: input.comparison.delta,
          improvementProbability: input.comparison.improvementProbability,
          effectiveSample: estimate.coverage.effective,
        }),
      );
    }
  }

  return candidates;
}

function verdict(
  input: DimensionInput,
  findingType: FindingType,
  rawProbability: number,
  priority: number,
  claim: Record<string, unknown>,
): CandidateFinding {
  return {
    dimensionKey: input.dimensionKey,
    findingType,
    claimFamily: input.claimFamily,
    rawProbability: Math.min(1, Math.max(0, rawProbability)),
    adjustedProbability: null,
    confidenceTier: tierFor(rawProbability),
    priority,
    claim: { dimension: input.dimensionKey, frame: input.frame, ...claim },
    published: false,
    droppedReason: null,
  };
}

function tierFor(probability: number): ConfidenceTier {
  if (probability >= 0.9) return "high";
  if (probability >= 0.7) return "moderate";
  return "low";
}

/**
 * Benjamini-Hochberg across each claim family, then a cap.
 *
 * Applied per family rather than globally because the families ask different
 * questions: correcting "is this a strength" against "did this improve" would
 * make each family's threshold depend on how many of the *other* kind were
 * tested, which is not what the correction means.
 *
 * `insufficient_evidence` is exempt. It asserts nothing about the player, so it
 * cannot be a false discovery, and including it in the denominator would make
 * every real finding harder to publish the less evidence we had.
 */
export function controlFalseDiscovery(
  candidates: readonly CandidateFinding[],
  policy: FindingPolicy = FINDING_POLICY,
): CandidateFinding[] {
  const result = candidates.map((candidate) => ({ ...candidate }));
  const families = new Map<string, CandidateFinding[]>();
  for (const candidate of result) {
    if (candidate.findingType === "insufficient_evidence") continue;
    families.set(candidate.claimFamily, [...(families.get(candidate.claimFamily) ?? []), candidate]);
  }

  for (const [, family] of families) {
    // p-value in this model is "probability the claim is not real".
    const ordered = [...family].sort((a, b) => pValue(a) - pValue(b));
    const m = ordered.length;
    let largestPassing = -1;
    for (let i = 0; i < m; i += 1) {
      if (pValue(ordered[i]!) <= ((i + 1) / m) * policy.falseDiscoveryRate) largestPassing = i;
    }
    for (let i = 0; i < m; i += 1) {
      const candidate = ordered[i]!;
      // The step-up adjusted value, made monotone the standard way: a finding
      // never gets a better adjusted value than one ranked above it.
      let adjusted = Math.min(1, (pValue(candidate) * m) / (i + 1));
      for (let j = i + 1; j < m; j += 1) {
        adjusted = Math.min(adjusted, Math.min(1, (pValue(ordered[j]!) * m) / (j + 1)));
      }
      candidate.adjustedProbability = 1 - adjusted;
      candidate.published = i <= largestPassing;
      candidate.droppedReason = candidate.published
        ? null
        : `false-discovery control at q=${policy.falseDiscoveryRate} did not keep this claim`;
    }
  }

  return result;
}

function pValue(candidate: CandidateFinding): number {
  return 1 - candidate.rawProbability;
}

/**
 * The findings a report actually shows.
 *
 * Ranked by priority then by adjusted probability, capped, and with the
 * `insufficient_evidence` rows kept out of the cap: they are the honest floor of
 * the report and dropping them to make room for a stronger claim would hide
 * exactly what the user most needs to know.
 */
export function selectPublished(
  candidates: readonly CandidateFinding[],
  policy: FindingPolicy = FINDING_POLICY,
): { published: CandidateFinding[]; withheld: CandidateFinding[] } {
  const gaps = candidates.filter((c) => c.findingType === "insufficient_evidence");
  const claims = candidates
    .filter((c) => c.findingType !== "insufficient_evidence" && c.published)
    .sort(
      (a, b) =>
        b.priority - a.priority ||
        (b.adjustedProbability ?? 0) - (a.adjustedProbability ?? 0) ||
        a.dimensionKey.localeCompare(b.dimensionKey),
    );

  const published = [...gaps, ...claims.slice(0, policy.maxPublishedFindings)];
  const withheld = [
    ...candidates.filter((c) => c.findingType !== "insufficient_evidence" && !c.published),
    ...claims.slice(policy.maxPublishedFindings).map((c) => ({
      ...c,
      published: false,
      droppedReason: `beyond the ${policy.maxPublishedFindings}-finding display cap`,
    })),
  ];
  return { published, withheld };
}

/**
 * The hash of the structured input a renderer is allowed to see.
 *
 * Canonical by construction: keys sorted, no timestamps, no identifiers that
 * change between runs. Re-deriving it from the stored finding is what makes the
 * renderer boundary checkable rather than aspirational.
 */
export function structuredInputHash(input: {
  findingType: FindingType;
  claim: Record<string, unknown>;
  evidenceIds: readonly (string | number)[];
}): string {
  const canonical = JSON.stringify({
    findingType: input.findingType,
    claim: sortKeys(input.claim),
    evidence: [...input.evidenceIds].map(String).sort(),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return Object.fromEntries(entries.map(([key, item]) => [key, sortKeys(item)]));
  }
  return value;
}
