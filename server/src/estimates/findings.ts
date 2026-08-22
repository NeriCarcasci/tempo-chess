import { createHash } from "node:crypto";

import type { ConceptDescription } from "../analysis/concepts/catalogue.js";
import {
  FINDING_POLICY,
  PHASE_CONTRAST_POLICY,
  SPECIFICITY_POLICY,
  type ConfidenceTier,
  type FindingPolicy,
  type FindingType,
  type Frame,
} from "./contract.js";
import type { Estimate, EstimateResult } from "./estimator.js";
import { improvementClaim, type Comparison } from "./estimator.js";
import { betaCdf } from "./beta.js";
import type { PhaseContrast } from "./phases.js";
import {
  concentrationWasExamined,
  failuresOf,
  findConcentration,
  moveNumberOf,
  observedOf,
  phaseLabel,
  pickExample,
  sideOf,
  successesOf,
  type Concentration,
  type Moment,
  type Phase,
} from "./specificity.js";

/**
 * Turning estimates into claims, and refusing to publish most of them.
 *
 * A dashboard that reports every fluctuation is not informative, it is noise
 * with a confident font. Platform spec 13 requires a versioned
 * ranking/false-discovery policy rather than publishing everything, so this
 * module does four things in order: derive candidate findings from estimates,
 * collapse the ones that are the same claim seen from two frames, control the
 * false-discovery rate across each claim family, and cap what is published.
 *
 * The refusals are the product. `insufficient_evidence` is a first-class
 * finding type because "we do not know yet, and here is what is missing" is a
 * better answer than a confident number from four observations.
 *
 * ## What a claim carries, and why it grew
 *
 * A claim used to be a dimension key and three numbers, and the renderer could
 * therefore only ever say the key and the numbers back. The claim is now the
 * whole of what a sentence about this finding is allowed to contain: the
 * concept in the words the catalogue wrote for a player, the sample the rate
 * came from, the location when the evidence earns one, and one real moment to
 * look at. That is not decoration on the renderer's behalf — `render.ts` checks
 * every number in its output against this object, so a fact that is not here
 * cannot be said, and a fact that is here has already been computed from
 * evidence rather than reached for in prose.
 *
 * The internal dimension key is deliberately *not* in the claim. It lives in
 * the finding's `context`, where an operator can find it and a template
 * cannot.
 */

/**
 * The highest certainty a sentence about a person is allowed to state.
 *
 * A posterior can reach 0.9997, and rounding that to "100%" tells somebody a
 * claim about them is certain, which no amount of evidence about chess earns.
 * Carried into the claim so the renderer's "over 99%" is a number the
 * structured input supports rather than one the template chose.
 */
export const PROBABILITY_FLOOR = 0.99;

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
  /** How the catalogue words this concept in this role, for a reader. */
  description: ConceptDescription;
  /**
   * Every recorded chance behind the estimate, in the same window the estimate
   * used. Location claims are computed from these, so a `personal_current`
   * finding must be given the recent window and not the lifetime one — a
   * sentence about where a recent problem sits, computed over evidence the
   * estimate did not see, would be two different reports in one paragraph.
   */
  moments: readonly Moment[];
}

export interface CandidateFinding {
  dimensionKey: string;
  findingType: FindingType;
  claimFamily: string;
  /** The concept and role this is about, for collapsing frames. */
  conceptSlug: string | null;
  role: string | null;
  frame: Frame | null;
  /** The probability the claim is real, before correction. */
  rawProbability: number;
  adjustedProbability: number | null;
  confidenceTier: ConfidenceTier;
  priority: number;
  /**
   * How many real moments this claim rests on.
   *
   * Ranking on the corrected probability alone put "you missed the only move
   * twice" above "you lost material twenty-nine times", because both are
   * near-certain after correction and the tie fell through to alphabetical
   * order on the dimension key. Certainty is not importance. This is the
   * count of moments the claim is about, and it is the second sort key.
   */
  weight: number;
  claim: Record<string, unknown>;
  /** Operator-facing residue: never rendered, never shown. */
  context: Record<string, unknown>;
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
  const concept = conceptClaim(input);

  if (input.result.status === "unavailable") {
    candidates.push({
      dimensionKey: input.dimensionKey,
      findingType: "insufficient_evidence",
      claimFamily: input.claimFamily,
      conceptSlug: input.conceptSlug,
      role: input.role,
      frame: input.frame,
      // Not a hypothesis about the player, so it is not a discovery and is not
      // corrected: it claims nothing that could be false.
      rawProbability: 1,
      adjustedProbability: null,
      confidenceTier: "low",
      priority: 10,
      weight: 0,
      claim: {
        concept,
        reason: input.result.reason,
        rawSample: input.result.coverage.raw,
        censored: input.result.coverage.censored,
      },
      context: { dimensionKey: input.dimensionKey, frame: input.frame },
      published: true,
      droppedReason: null,
    });
    return candidates;
  }

  const estimate: Estimate = input.result;
  const width = estimate.intervalHigh - estimate.intervalLow;
  const { alpha, beta } = estimate.posterior;
  const tier = tierFor(estimate, policy);

  // Each claim's probability is the posterior probability that the claim is
  // true, not a proxy for how precise the estimate is. That distinction is what
  // makes the false-discovery control mean something: `P(the player is above
  // the strength floor)` is a hypothesis that can be wrong, while "the interval
  // is 0.14 wide" is a fact about our sample that no correction should be
  // applied to.
  const probabilityAbove = (bound: number): number => 1 - betaCdf(bound, alpha, beta);
  const probabilityBelow = (bound: number): number => betaCdf(bound, alpha, beta);

  const observed = observedOf(input.moments);
  const failures = failuresOf(input.moments);
  const successes = successesOf(input.moments);

  const measurement = {
    estimate: estimate.estimate,
    intervalLow: estimate.intervalLow,
    intervalHigh: estimate.intervalHigh,
    observed: estimate.coverage.raw - estimate.coverage.censored,
    successes: estimate.coverage.success,
    failures: estimate.coverage.failure,
    graded: estimate.coverage.graded,
    // Carried into every claim, so the sentence that mentions a rate can also
    // say what was excluded from it. §17.5's rule is only kept if the reader
    // can see it being kept.
    censored: estimate.coverage.censored,
    effectiveSample: estimate.coverage.effective,
  };

  if (estimate.intervalLow >= policy.strengthFloor) {
    candidates.push(
      verdict(input, "strength", probabilityAbove(policy.strengthFloor), 80, tier, successes.length, {
        concept,
        ...measurement,
        ...locate(successes, observed),
      }),
    );
  } else if (estimate.intervalHigh <= policy.missCeiling) {
    candidates.push(
      verdict(
        input,
        "foundational_miss",
        probabilityBelow(policy.missCeiling),
        90,
        tier,
        failures.length,
        { concept, ...measurement, ...locate(failures, observed) },
      ),
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
        tier,
        observed.length,
        { concept, ...measurement, ...locate(failures, observed) },
      ),
    );
  }

  if (input.failureCount >= policy.repeatedPatternFailures) {
    // Four failures inside an otherwise strong record are noise, not a pattern.
    // The probability is that the underlying rate really is below the strength
    // floor, which is what separates the two.
    candidates.push(
      verdict(
        input,
        "repeated_pattern",
        probabilityBelow(policy.strengthFloor),
        70,
        tier,
        input.failureCount,
        {
          concept,
          occurrences: input.failureCount,
          ...measurement,
          ...locate(failures, observed),
        },
      ),
    );
  }

  if (input.comparison !== null) {
    const claim = improvementClaim(input.comparison, estimate.coverage);
    if (claim !== null) {
      candidates.push(
        verdict(
          input,
          claim,
          input.comparison.improvementProbability,
          claim === "established_improvement" ? 95 : 55,
          tier,
          observed.length,
          {
            concept,
            delta: input.comparison.delta,
            improvementProbability: input.comparison.improvementProbability,
            probabilityFloor: PROBABILITY_FLOOR,
            estimate: estimate.estimate,
            intervalLow: estimate.intervalLow,
            intervalHigh: estimate.intervalHigh,
            observed: measurement.observed,
            censored: measurement.censored,
            effectiveSample: estimate.coverage.effective,
          },
        ),
      );
    }
  }

  return candidates;
}

/**
 * The one finding that is about the shape of a game rather than an idea in it.
 *
 * `inconsistency` has been in the contract's list of finding types since 0028
 * and nothing has ever produced one, because every other generator in this file
 * works per concept and per role. "You are a different player in the opening
 * than in the endgame" cannot be said by any of them, and in the account this
 * was written against it was the largest true thing in the data.
 *
 * The claim carries both sides in full — rate, interval and counts for each
 * phase — because the entire content of the finding is a comparison, and a
 * comparison shown as one number is an assertion.
 */
export function derivePhaseContrast(input: {
  contrast: PhaseContrast;
  /** Reader-facing names of the concepts the two phases were compared on. */
  sharedConceptLabels: readonly string[];
  claimFamily: string;
  policy?: FindingPolicy;
}): CandidateFinding {
  const { contrast } = input;
  const policy = input.policy ?? FINDING_POLICY;
  const side = (phase: Phase, estimate: Estimate): Record<string, unknown> => ({
    phase,
    label: phaseLabel(phase),
    estimate: estimate.estimate,
    intervalLow: estimate.intervalLow,
    intervalHigh: estimate.intervalHigh,
    observed: estimate.coverage.raw - estimate.coverage.censored,
    successes: estimate.coverage.success,
    censored: estimate.coverage.censored,
    effectiveSample: estimate.coverage.effective,
  });

  // The tier is taken from the weaker side, which is the side the sentence is
  // about and the side a reader will act on. Reporting the confidence of the
  // half that happens to be better evidenced would flatter the claim.
  const tier = tierFor(contrast.weakestEstimate, policy);

  return {
    dimensionKey: `phase_contrast_${contrast.weakest}_${contrast.strongest}`,
    findingType: "inconsistency",
    claimFamily: input.claimFamily,
    conceptSlug: null,
    role: null,
    frame: "objective",
    rawProbability: Math.min(1, Math.max(0, contrast.probability)),
    adjustedProbability: null,
    confidenceTier: tier,
    // Above every per-concept verdict. A player who is twenty points weaker in
    // one phase than another has been told the most useful thing in the report,
    // and burying it under six concept findings would waste it.
    priority: 92,
    weight:
      contrast.weakestEstimate.coverage.raw - contrast.weakestEstimate.coverage.censored,
    claim: {
      kind: "phase_contrast",
      weakest: side(contrast.weakest, contrast.weakestEstimate),
      strongest: side(contrast.strongest, contrast.strongestEstimate),
      gap: contrast.strongestEstimate.estimate - contrast.weakestEstimate.estimate,
      probability: contrast.probability,
      probabilityFloor: PROBABILITY_FLOOR,
      sharedConcepts: [...input.sharedConceptLabels],
      sharedConceptCount: input.sharedConceptLabels.length,
    },
    context: {
      dimensionKey: `phase_contrast_${contrast.weakest}_${contrast.strongest}`,
      frame: "objective",
      sharedStrata: [...contrast.sharedStrata],
      comparedPairs: contrast.comparedPairs,
      phaseContrastPolicy: PHASE_CONTRAST_POLICY.version,
    },
    published: false,
    droppedReason: null,
  };
}

/** The concept half of a claim: what the catalogue calls it, in a reader's words. */
function conceptClaim(input: DimensionInput): Record<string, unknown> {
  const narrative = input.description.narrative;
  return {
    slug: input.description.slug,
    role: input.description.role,
    label: input.description.label,
    definition: input.description.definition,
    opportunity: narrative?.opportunity ?? null,
    succeeded: narrative?.succeeded ?? null,
    missed: narrative?.missed ?? null,
  };
}

/**
 * The location half of a claim, and the example.
 *
 * `whereExamined` is separate from `where` because "we looked and it is spread
 * out" and "there was not enough of it to look" are different answers, and the
 * renderer says the first out loud. Collapsing them would let the report imply
 * it had checked something it had not.
 */
function locate(subject: readonly Moment[], reference: readonly Moment[]): Record<string, unknown> {
  const concentration = findConcentration(subject, reference);
  const example = pickExample(subject, concentration);
  return {
    where: concentration === null ? null : describeConcentration(concentration),
    whereExamined: concentrationWasExamined(subject),
    example: example === null ? null : describeExample(example),
  };
}

function describeConcentration(concentration: Concentration): Record<string, unknown> {
  return {
    kind: concentration.kind,
    label: concentration.label,
    count: concentration.count,
    total: concentration.total,
    // The tested band, not the observed edges: reporting "moves 11 to 13"
    // because that is where they happened to land would be narrower than the
    // hypothesis the tail probability was computed for. The observed edges are
    // here for a screen that wants them, and the renderer does not use them.
    moveLow: concentration.moveBand?.low ?? null,
    moveHigh: concentration.moveBand?.high ?? null,
    observedMoveLow: concentration.observedMoveLow,
    observedMoveHigh: concentration.observedMoveHigh,
  };
}

function describeExample(moment: Moment): Record<string, unknown> {
  return {
    gameId: moment.gameId,
    // A string, not a number: `render.ts` scans every numeric token in its
    // output against the numbers in this object, and an identifier that
    // happened to license "4711" would be a hole in that check.
    evidenceItemId: moment.evidenceItemId,
    moveNumber: moveNumberOf(moment.ply),
    side: sideOf(moment.ply),
    // UCI for both moves rather than SAN for one and UCI for the other. The
    // replay records SAN only for the move that was played, and the engine's
    // recommendation only in UCI; mixing the two notations inside one sentence
    // reads worse than using the one that exists for both, and every square
    // name is a digit between 1 and 8, which the renderer's number check treats
    // as ordinary English rather than as an unsupported statistic.
    playedMoveUci: moment.playedMoveUci,
    bestMoveUci: moment.bestMoveUci,
    openingName: moment.openingName,
    departureMoveNumber:
      moment.departurePly === null ? null : moveNumberOf(moment.departurePly),
  };
}

function verdict(
  input: DimensionInput,
  findingType: FindingType,
  rawProbability: number,
  priority: number,
  confidenceTier: ConfidenceTier,
  weight: number,
  claim: Record<string, unknown>,
): CandidateFinding {
  return {
    dimensionKey: input.dimensionKey,
    findingType,
    claimFamily: input.claimFamily,
    conceptSlug: input.conceptSlug,
    role: input.role,
    frame: input.frame,
    rawProbability: Math.min(1, Math.max(0, rawProbability)),
    adjustedProbability: null,
    confidenceTier,
    priority,
    weight,
    claim,
    context: {
      dimensionKey: input.dimensionKey,
      frame: input.frame,
      specificityPolicy: SPECIFICITY_POLICY.version,
    },
    published: false,
    droppedReason: null,
  };
}

/**
 * How much evidence stands behind a published claim.
 *
 * Not the posterior probability, which the correction has already used and
 * which is bounded below by the false-discovery rate for anything that
 * survives it. This is the coverage the estimate reports plus the width of its
 * interval, which is what a reader means when they ask how sure we are: a rate
 * of 30% known to within four points and a rate of 30% that could be anything
 * from 15% to 45% are not the same statement, and before this they carried the
 * same badge.
 */
export function tierFor(
  estimate: Estimate,
  policy: FindingPolicy = FINDING_POLICY,
): ConfidenceTier {
  const width = estimate.intervalHigh - estimate.intervalLow;
  if (estimate.coverageStatus !== "sufficient") return "low";
  if (width <= policy.confidentIntervalWidth) return "high";
  if (width <= policy.frontierIntervalWidth) return "moderate";
  return "low";
}

/**
 * The frame that owns each kind of claim.
 *
 * v1 measures `objective` over everything the snapshot holds and
 * `personal_current` over the recent half of the same evidence, so the two
 * produce a near-duplicate of every verdict — and an identical
 * `repeated_pattern`, whose failure count is not windowed at all. Publishing
 * both is one fact wearing two hats, which is exactly what platform spec 3.2's
 * separation of frames exists to prevent.
 */
const OWNING_FRAME: Readonly<Record<FindingType, Frame>> = Object.freeze({
  strength: "objective",
  foundational_miss: "objective",
  development_frontier: "objective",
  repeated_pattern: "objective",
  inconsistency: "objective",
  transfer: "objective",
  insufficient_evidence: "objective",
  early_improvement_signal: "personal_current",
  established_improvement: "personal_current",
});

/**
 * Collapse the same claim seen from two frames into one.
 *
 * Kept by a fixed rule — the frame that owns the claim type — and not by
 * whichever frame scored better. Choosing the more significant of two
 * correlated tests of one hypothesis is the definition of the thing the
 * false-discovery control downstream is there to prevent, and doing it here
 * would make that control a formality.
 *
 * Run before the correction, not after, so the number of hypotheses in each
 * family is the number actually being asked. Leaving the duplicates in would
 * roughly double `m` and make every real finding harder to publish because the
 * report had measured the same thing twice.
 */
export function dedupeAcrossFrames(
  candidates: readonly CandidateFinding[],
): CandidateFinding[] {
  const result = candidates.map((candidate) => ({ ...candidate }));
  const groups = new Map<string, CandidateFinding[]>();
  for (const candidate of result) {
    if (candidate.conceptSlug === null) continue;
    const key = `${candidate.conceptSlug}|${candidate.role ?? ""}|${candidate.findingType}`;
    groups.set(key, [...(groups.get(key) ?? []), candidate]);
  }

  // A coverage gap is a statement that nothing could be measured. It is false
  // the moment something was: the recent window is half the evidence, so a
  // concept with a perfectly good lifetime estimate routinely produces
  // "Forma has nothing to say about this yet" from `personal_current`. That is
  // an artefact of halving the sample, not a gap, and it was a large part of
  // how a report reached thirty-six items.
  const measured = new Set<string>();
  for (const candidate of result) {
    if (candidate.conceptSlug === null) continue;
    if (candidate.findingType === "insufficient_evidence") continue;
    measured.add(`${candidate.conceptSlug}|${candidate.role ?? ""}`);
  }
  for (const candidate of result) {
    if (candidate.findingType !== "insufficient_evidence") continue;
    if (candidate.conceptSlug === null) continue;
    if (!measured.has(`${candidate.conceptSlug}|${candidate.role ?? ""}`)) continue;
    candidate.published = false;
    candidate.droppedReason =
      "another frame measured this concept, so there is no coverage gap to report";
  }

  for (const [, group] of groups) {
    if (group.length < 2) continue;
    const owning = OWNING_FRAME[group[0]!.findingType];
    const keep =
      group.find((candidate) => candidate.frame === owning) ??
      // No candidate from the owning frame: keep one by a stable rule rather
      // than by strength, for the same reason.
      [...group].sort((a, b) => a.dimensionKey.localeCompare(b.dimensionKey))[0]!;
    for (const candidate of group) {
      if (candidate === keep) continue;
      // A candidate already dropped keeps the first reason it was dropped for.
      // The withheld list is what an operator reads to find out why a report
      // said less than they expected, and overwriting the real reason with a
      // later one makes it useless.
      if (candidate.droppedReason !== null) continue;
      candidate.published = false;
      // The probability is left as it was. It is the honest record of what the
      // other frame measured, and an operator reading the withheld list needs
      // to see that the duplicate agreed rather than that it scored zero.
      candidate.droppedReason =
        `the ${owning} frame already makes this claim about the same concept`;
    }
  }

  return result;
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
 * every real finding harder to publish the less evidence we had. A candidate
 * already dropped as a cross-frame duplicate is exempt for the same reason in
 * reverse: it is not a hypothesis this report is testing.
 */
export function controlFalseDiscovery(
  candidates: readonly CandidateFinding[],
  policy: FindingPolicy = FINDING_POLICY,
): CandidateFinding[] {
  const result = candidates.map((candidate) => ({ ...candidate }));
  const families = new Map<string, CandidateFinding[]>();
  for (const candidate of result) {
    if (candidate.findingType === "insufficient_evidence") continue;
    if (candidate.droppedReason !== null) continue;
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
 * Ranked by type, then by how many moments the claim rests on, then by the
 * corrected probability; capped; and with the `insufficient_evidence` rows kept
 * out of the cap. Those are the honest floor of the report and dropping them to
 * make room for a stronger claim would hide exactly what the user most needs to
 * know — and they cannot run away with the page, because after the frames are
 * collapsed there is at most one per concept and role in the catalogue.
 *
 * The published `priority` is rewritten to the display position. It was a
 * per-type constant, so a report with three constraints in it had three rows
 * at priority 90 and every reader of `analysis.findings` fell through to
 * `created_at` — which is the same instant for every row written in one
 * transaction. The order the report was ranked in was being discarded one step
 * after it was computed.
 */
export function selectPublished(
  candidates: readonly CandidateFinding[],
  policy: FindingPolicy = FINDING_POLICY,
): { published: CandidateFinding[]; withheld: CandidateFinding[] } {
  const gaps = candidates
    .filter((c) => c.findingType === "insufficient_evidence" && c.droppedReason === null)
    .map((c) => ({ ...c }));
  const claims = candidates
    .filter((c) => c.findingType !== "insufficient_evidence" && c.published)
    .map((c) => ({ ...c }))
    .sort(
      (a, b) =>
        b.priority - a.priority ||
        b.weight - a.weight ||
        (b.adjustedProbability ?? 0) - (a.adjustedProbability ?? 0) ||
        a.dimensionKey.localeCompare(b.dimensionKey),
    );

  const kept = claims.slice(0, policy.maxPublishedFindings);
  kept.forEach((candidate, index) => {
    candidate.priority = 99 - index;
  });
  gaps.sort((a, b) => a.dimensionKey.localeCompare(b.dimensionKey));
  gaps.forEach((candidate, index) => {
    // Below every claim, above nothing, and still a total order among
    // themselves.
    candidate.priority = Math.max(0, 20 - index);
  });

  const published = [...gaps, ...kept];
  const withheld = [
    ...candidates.filter(
      (c) => c.findingType !== "insufficient_evidence" && !c.published,
    ),
    ...candidates.filter(
      (c) => c.findingType === "insufficient_evidence" && c.droppedReason !== null,
    ),
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
