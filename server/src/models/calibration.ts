import {
  CALIBRATION_BIN_COUNT,
  PROMOTION_THRESHOLDS,
  sliceKeyString,
  type CalibrationSliceKey,
  type PromotionThresholds,
} from "./contract.js";

/**
 * Benchmark scoring and the promotion gate.
 *
 * The gate exists to be able to say no. Delivery plan E14 makes that explicit:
 * failure to promote a human model removes human claims from v1 rather than
 * blocking it, and the refusal path is required to be tested. So the functions
 * here are written so that "not enough evidence" and "evidence says no" are
 * distinct outcomes, and neither is reachable by accident.
 */

/** One scored holdout position. */
export interface HoldoutOutcome {
  /** Which account the game came from, for the account-disjointness count. */
  accountKey: string;
  /** The move the human actually played. */
  playedUci: string;
  /**
   * The model's top move, or null when the model failed to answer. A failure is
   * counted against the failure rate; it is not silently dropped, because a
   * model that answers only the easy positions would otherwise look excellent.
   */
  predictedUci: string | null;
  /** The probability the model put on its own top move. */
  predictedProbability: number | null;
  latencyMs: number | null;
}

export interface SliceMetrics {
  sampleSize: number;
  answeredSize: number;
  distinctAccounts: number;
  failureRate: number;
  /** Null when nothing was answered: 0/0 is not zero accuracy. */
  top1Accuracy: number | null;
  expectedCalibrationError: number | null;
  brierScore: number | null;
  latencyP95Ms: number | null;
}

/**
 * Score one slice.
 *
 * Positions the model failed on are excluded from accuracy and calibration and
 * counted in `failureRate`. Mixing them in as wrong answers would conflate "it
 * predicted badly" with "it did not run", which are different defects with
 * different fixes.
 */
export function scoreSlice(outcomes: readonly HoldoutOutcome[]): SliceMetrics {
  const sampleSize = outcomes.length;
  const answered = outcomes.filter(
    (o): o is HoldoutOutcome & { predictedUci: string; predictedProbability: number } =>
      o.predictedUci !== null && o.predictedProbability !== null,
  );
  const distinctAccounts = new Set(outcomes.map((o) => o.accountKey)).size;
  const failureRate = sampleSize === 0 ? 0 : (sampleSize - answered.length) / sampleSize;

  if (answered.length === 0) {
    return {
      sampleSize,
      answeredSize: 0,
      distinctAccounts,
      failureRate,
      top1Accuracy: null,
      expectedCalibrationError: null,
      brierScore: null,
      latencyP95Ms: percentile(
        outcomes.map((o) => o.latencyMs).filter((v): v is number => v !== null),
        0.95,
      ),
    };
  }

  const hits: number[] = answered.map((o) => (o.predictedUci === o.playedUci ? 1 : 0));
  const top1Accuracy = hits.reduce((a, b) => a + b, 0) / answered.length;
  const brierScore =
    answered.reduce((sum, o, i) => sum + (o.predictedProbability - hits[i]!) ** 2, 0) /
    answered.length;

  return {
    sampleSize,
    answeredSize: answered.length,
    distinctAccounts,
    failureRate,
    top1Accuracy,
    expectedCalibrationError: expectedCalibrationError(
      answered.map((o, i) => ({ confidence: o.predictedProbability, correct: hits[i] === 1 })),
    ),
    brierScore,
    latencyP95Ms: percentile(
      outcomes.map((o) => o.latencyMs).filter((v): v is number => v !== null),
      0.95,
    ),
  };
}

/**
 * Expected calibration error over equal-width confidence bins.
 *
 * The question is whether a stated confidence means what it says: when the
 * model puts 0.7 on its top move, does that move get played about 70% of the
 * time. Bins with nothing in them contribute nothing rather than contributing
 * zero error, which would reward a model for being confident about a narrow
 * slice of positions.
 */
export function expectedCalibrationError(
  predictions: readonly { confidence: number; correct: boolean }[],
  binCount: number = CALIBRATION_BIN_COUNT,
): number | null {
  if (predictions.length === 0) return null;
  const bins = Array.from({ length: binCount }, () => ({ n: 0, confidence: 0, correct: 0 }));
  for (const prediction of predictions) {
    const clamped = Math.min(1, Math.max(0, prediction.confidence));
    // The top bin is closed on the right so a confidence of exactly 1 does not
    // fall off the end of the array.
    const index = Math.min(binCount - 1, Math.floor(clamped * binCount));
    const bin = bins[index]!;
    bin.n += 1;
    bin.confidence += clamped;
    bin.correct += prediction.correct ? 1 : 0;
  }
  let error = 0;
  for (const bin of bins) {
    if (bin.n === 0) continue;
    error += (bin.n / predictions.length) * Math.abs(bin.correct / bin.n - bin.confidence / bin.n);
  }
  return error;
}

/** Nearest-rank percentile. Null on an empty sample, never 0. */
export function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[rank - 1]!;
}

export interface SliceVerdict {
  slice: CalibrationSliceKey;
  metrics: SliceMetrics;
  supported: boolean;
  /** Every threshold this slice failed, in the order they were checked. */
  reasons: readonly string[];
}

export interface PromotionVerdict {
  promote: boolean;
  /** Why not. Empty when `promote` is true. */
  blockers: readonly string[];
  slices: readonly SliceVerdict[];
  supportedSliceCount: number;
  totalSampleSize: number;
}

/**
 * Decide whether a candidate may be promoted, and which slices it may speak on.
 *
 * A slice failing is normal and produces `unavailable` for positions in it. The
 * promotion itself fails when there is no slice left to speak on, when the
 * corpus is too small to have measured anything, or when the holdout was not
 * built the way a holdout has to be built. Those last two are checked first,
 * because a metric computed on the wrong corpus is not a weak result, it is not
 * a result.
 */
export function evaluatePromotion(input: {
  slices: readonly { slice: CalibrationSliceKey; outcomes: readonly HoldoutOutcome[] }[];
  dataset: { accountDisjoint: boolean; chronologicalSplit: boolean; licenceCleared: boolean };
  thresholds?: PromotionThresholds;
}): PromotionVerdict {
  const thresholds = input.thresholds ?? PROMOTION_THRESHOLDS;
  const blockers: string[] = [];

  if (!input.dataset.licenceCleared) {
    blockers.push("model licence review is not cleared");
  }
  if (!input.dataset.accountDisjoint) {
    blockers.push("holdout is not account-disjoint from any training or tuning corpus");
  }
  if (!input.dataset.chronologicalSplit) {
    blockers.push("holdout is not a chronological split");
  }

  const slices = input.slices.map(({ slice, outcomes }) =>
    judgeSlice(slice, scoreSlice(outcomes), thresholds),
  );
  const totalSampleSize = slices.reduce((sum, s) => sum + s.metrics.sampleSize, 0);
  const supportedSliceCount = slices.filter((s) => s.supported).length;

  if (totalSampleSize < thresholds.minTotalSampleSize) {
    blockers.push(
      `holdout has ${totalSampleSize} positions, below the ${thresholds.minTotalSampleSize} required`,
    );
  }
  if (supportedSliceCount < thresholds.minSupportedSlices) {
    blockers.push(
      `${supportedSliceCount} slices passed calibration, below the ${thresholds.minSupportedSlices} required`,
    );
  }

  return {
    promote: blockers.length === 0,
    blockers,
    slices,
    supportedSliceCount,
    totalSampleSize,
  };
}

function judgeSlice(
  slice: CalibrationSliceKey,
  metrics: SliceMetrics,
  thresholds: PromotionThresholds,
): SliceVerdict {
  const reasons: string[] = [];
  if (metrics.sampleSize < thresholds.minSliceSampleSize) {
    reasons.push(
      `${metrics.sampleSize} positions, below the ${thresholds.minSliceSampleSize} required`,
    );
  }
  if (metrics.distinctAccounts < thresholds.minSliceAccounts) {
    reasons.push(
      `${metrics.distinctAccounts} accounts, below the ${thresholds.minSliceAccounts} required`,
    );
  }
  if (metrics.failureRate > thresholds.maxFailureRate) {
    reasons.push(
      `failure rate ${metrics.failureRate.toFixed(4)} above the ${thresholds.maxFailureRate} ceiling`,
    );
  }
  if (metrics.top1Accuracy === null) {
    reasons.push("no position was answered, so accuracy is unmeasured");
  } else if (metrics.top1Accuracy < thresholds.minTop1Accuracy) {
    reasons.push(
      `top-1 accuracy ${metrics.top1Accuracy.toFixed(4)} below the ${thresholds.minTop1Accuracy} floor`,
    );
  }
  if (metrics.expectedCalibrationError === null) {
    reasons.push("calibration error is unmeasured");
  } else if (metrics.expectedCalibrationError > thresholds.maxExpectedCalibrationError) {
    reasons.push(
      `calibration error ${metrics.expectedCalibrationError.toFixed(4)} above the ${thresholds.maxExpectedCalibrationError} ceiling`,
    );
  }
  if (metrics.brierScore === null) {
    reasons.push("Brier score is unmeasured");
  } else if (metrics.brierScore > thresholds.maxBrierScore) {
    reasons.push(
      `Brier score ${metrics.brierScore.toFixed(4)} above the ${thresholds.maxBrierScore} ceiling`,
    );
  }
  if (metrics.latencyP95Ms !== null && metrics.latencyP95Ms > thresholds.maxLatencyP95Ms) {
    reasons.push(
      `p95 latency ${metrics.latencyP95Ms}ms above the ${thresholds.maxLatencyP95Ms}ms budget`,
    );
  }
  return { slice, metrics, supported: reasons.length === 0, reasons };
}

/** A one-line summary of a verdict, for a runbook or a CI log. */
export function describeVerdict(verdict: PromotionVerdict): string {
  if (verdict.promote) {
    return `promote: ${verdict.supportedSliceCount} supported slices over ${verdict.totalSampleSize} positions`;
  }
  return `refuse: ${verdict.blockers.join("; ")}`;
}

/** The slice rows a verdict implies, ready for the calibration table. */
export function calibrationRowsFor(verdict: PromotionVerdict): readonly {
  slice: CalibrationSliceKey;
  key: string;
  supported: boolean;
  unsupportedReason: string | null;
  sampleSize: number;
  top1Accuracy: number | null;
  expectedCalibrationError: number | null;
  brierScore: number | null;
}[] {
  return verdict.slices.map((s) => ({
    slice: s.slice,
    key: sliceKeyString(s.slice),
    supported: s.supported,
    unsupportedReason: s.supported ? null : s.reasons.join("; "),
    sampleSize: s.metrics.sampleSize,
    // A slice that is not supported publishes no metrics: the calibration table
    // treats a supported row as measured and an unsupported one as explained,
    // and a half-populated row is what a reader mistakes for support.
    top1Accuracy: s.supported ? s.metrics.top1Accuracy : null,
    expectedCalibrationError: s.supported ? s.metrics.expectedCalibrationError : null,
    brierScore: s.supported ? s.metrics.brierScore : null,
  }));
}
