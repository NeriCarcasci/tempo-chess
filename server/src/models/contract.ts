/**
 * The human-context contract: what a human model is asked, what it may answer,
 * and the conditions under which Forma is allowed to repeat that answer.
 *
 * Everything here is a frozen constant with a version. The numbers are policy,
 * not tuning knobs: changing one produces a new calibration version and a new
 * shadow comparison (platform spec 12.3), which is why they are exported as
 * `as const` and hashed into component versions rather than read from the
 * environment.
 */

/** Providers whose ratings a slice may be calibrated against. */
export const PROVIDERS = ["lichess", "chesscom"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const SPEEDS = ["bullet", "blitz", "rapid", "classical", "correspondence"] as const;
export type Speed = (typeof SPEEDS)[number];

/**
 * The rating bands Forma is willing to talk about at all.
 *
 * Platform spec 3.2 puts the calibrated range at 1000-2200. Bands are 100 wide
 * and half-open on the right, so 1200 is in [1200, 1300) and nothing lands in
 * two bands.
 */
export const CALIBRATED_RATING_FLOOR = 1000;
export const CALIBRATED_RATING_CEILING = 2200;
export const RATING_BAND_WIDTH = 100;

export interface RatingBand {
  low: number;
  /** Exclusive. */
  high: number;
}

/** Every band inside the calibrated range, low to high. */
export const RATING_BANDS: readonly RatingBand[] = Object.freeze(
  Array.from(
    { length: (CALIBRATED_RATING_CEILING - CALIBRATED_RATING_FLOOR) / RATING_BAND_WIDTH },
    (_, index) => {
      const low = CALIBRATED_RATING_FLOOR + index * RATING_BAND_WIDTH;
      return Object.freeze({ low, high: low + RATING_BAND_WIDTH });
    },
  ),
);

/**
 * The band a rating falls in, or null outside the calibrated range.
 *
 * Null is the answer, not an error and not the nearest band. Platform spec 3.2
 * is explicit that players outside 1000-2200 may still use Forma; what they may
 * not get is a number that pretends to have been calibrated on them.
 */
export function ratingBandFor(rating: number): RatingBand | null {
  if (!Number.isFinite(rating)) return null;
  if (rating < CALIBRATED_RATING_FLOOR || rating >= CALIBRATED_RATING_CEILING) return null;
  const low =
    CALIBRATED_RATING_FLOOR +
    Math.floor((rating - CALIBRATED_RATING_FLOOR) / RATING_BAND_WIDTH) * RATING_BAND_WIDTH;
  return { low, high: low + RATING_BAND_WIDTH };
}

/** The slice a claim is made under. */
export interface CalibrationSliceKey {
  provider: Provider;
  speed: Speed;
  band: RatingBand;
}

export function sliceKeyString(slice: CalibrationSliceKey): string {
  return `${slice.provider}:${slice.speed}:${slice.band.low}-${slice.band.high}`;
}

/**
 * Why a practical claim could not be made.
 *
 * These strings are the database's `unavailable_reason` vocabulary. They are
 * deliberately about *us* rather than about the player: "we did not calibrate
 * this" is a fact about Forma, and phrasing it as a property of the user is how
 * a limitation turns into a judgement.
 */
export const UNAVAILABLE_REASONS = [
  "no_promoted_model",
  "slice_not_calibrated",
  "slice_unsupported",
  "context_incomplete",
  "inference_failed",
  "objective_candidates_missing",
  "model_withdrawn",
] as const;
export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number];

/**
 * The named method behind `practical_pressure`.
 *
 * Stored on every row so a later change is visible as a different method rather
 * than as a silent shift in everyone's numbers.
 */
export const PRESSURE_METHOD = "adequate_mass_interval_v1" as const;

/**
 * How many policy moves an inference retains.
 *
 * Kept small on purpose. The mass outside the top-k is recorded explicitly, so
 * a larger k buys precision on the bound rather than correctness, and a policy
 * with 40 legal moves does not become 40 rows per position.
 */
export const RETAINED_MOVE_LIMIT = 12;

/**
 * Promotion thresholds (platform spec 12.3, delivery plan E14).
 *
 * A candidate must clear every one of these in aggregate *and* in every slice
 * it claims to support. A slice that fails is not fatal to the promotion: it is
 * recorded as unsupported, and positions in it return unavailable. What is
 * fatal is a candidate with no supported slice at all, because that is a
 * promotion with nothing behind it.
 */
export interface PromotionThresholds {
  /** Minimum holdout positions in a slice before it may be called supported. */
  minSliceSampleSize: number;
  /** Minimum positions across all slices. */
  minTotalSampleSize: number;
  /** Minimum distinct accounts, so a slice is not one player's habits. */
  minSliceAccounts: number;
  /** Top-1 move agreement floor. Below this the model is not modelling anyone. */
  minTop1Accuracy: number;
  /** Expected calibration error ceiling: stated confidence must mean something. */
  maxExpectedCalibrationError: number;
  /** Brier ceiling on the top-1 prediction. */
  maxBrierScore: number;
  /** Fraction of positions the model may fail to answer. */
  maxFailureRate: number;
  /** Per-position wall-clock budget, milliseconds, p95. */
  maxLatencyP95Ms: number;
  /** Minimum number of supported slices for the promotion to mean anything. */
  minSupportedSlices: number;
}

export const PROMOTION_THRESHOLDS: PromotionThresholds = Object.freeze({
  minSliceSampleSize: 400,
  minTotalSampleSize: 5_000,
  minSliceAccounts: 25,
  minTop1Accuracy: 0.4,
  maxExpectedCalibrationError: 0.08,
  maxBrierScore: 0.6,
  maxFailureRate: 0.01,
  maxLatencyP95Ms: 250,
  minSupportedSlices: 2,
});

/** The version string that identifies this policy set in a component version. */
export const CALIBRATION_POLICY_VERSION = "1" as const;

/**
 * The reliability bins used for expected calibration error.
 *
 * Ten equal-width bins over [0, 1]. Equal-width rather than equal-mass because
 * the question is "when the model says 0.7, does it happen 70% of the time",
 * and equal-mass bins move the goalposts with the distribution.
 */
export const CALIBRATION_BIN_COUNT = 10;

/**
 * Named budgets for the paths this epic adds, asserted by `models:performance`.
 *
 * The wall-clock numbers are advisory ceilings: the gate prints the measurement
 * and fails only an order of magnitude past them, because a CI runner and a
 * laptop disagree about milliseconds and a gate that fails on the same commit
 * twice out of three runs teaches people to ignore gates. What is asserted
 * exactly is the count: how many model calls a run pays for.
 */
export const PRACTICAL_CONTEXT_BUDGETS = Object.freeze({
  /** Writing the practical layer for one 80-transition game. */
  writePerGameMs: 4_000,
  /** Reading a whole review page, practical layer included. */
  reviewReadMs: 250,
  /** One inference, p95, on the deployment that owns cpu_model. */
  inferenceP95Ms: 250,
});
