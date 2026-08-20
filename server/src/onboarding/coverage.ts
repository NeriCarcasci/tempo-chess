import {
  COVERAGE_POLICY,
  type CoveragePolicy,
  type CoverageState,
  type Limitation,
} from "./contract.js";

/**
 * `coverage_policy_v1` — deciding how much Forma is entitled to say.
 *
 * The output is not a score. It is a state plus a list of named limitations,
 * because platform spec 14.5 requires a user with fewer than fifty games to see
 * "a useful limited report and the exact missing evidence, not a failure
 * screen". A number cannot be the exact missing evidence; a sentence naming the
 * gap can.
 *
 * Every limitation is phrased as a fact about the sample rather than about the
 * player. "We have few of your endgames" is something Forma knows; "you avoid
 * endgames" is a judgement it has not earned.
 */

export interface GameFacts {
  playedAt: Date;
  speed: string;
  hasClock: boolean;
  reachedMiddlegame: boolean;
  reachedEndgame: boolean;
  eligible: boolean;
}

export interface DimensionFacts {
  dimensionKey: string;
  observationCount: number;
  effectiveCount: number;
  earliestPlayedAt: Date | null;
  latestPlayedAt: Date | null;
}

export interface DimensionCoverage extends DimensionFacts {
  state: CoverageState;
  limitationReason: string | null;
}

export interface CoverageDecision {
  overallState: CoverageState;
  totalGames: number;
  eligibleGames: number;
  earliestPlayedAt: Date | null;
  latestPlayedAt: Date | null;
  speedsCovered: string[];
  clockAvailableGames: number;
  openingReachCount: number;
  middlegameReachCount: number;
  endgameReachCount: number;
  ratingInCalibratedRange: boolean | null;
  limitations: Limitation[];
  dimensions: DimensionCoverage[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function decideCoverage(
  games: readonly GameFacts[],
  dimensions: readonly DimensionFacts[],
  context: { providerRating: number | null },
  policy: CoveragePolicy = COVERAGE_POLICY,
): CoverageDecision {
  const eligible = games.filter((game) => game.eligible);
  const limitations: Limitation[] = [];

  const played = eligible.map((game) => game.playedAt.getTime());
  const earliest = played.length > 0 ? new Date(Math.min(...played)) : null;
  const latest = played.length > 0 ? new Date(Math.max(...played)) : null;
  const speeds = [...new Set(eligible.map((game) => game.speed))].sort();

  const clockAvailable = eligible.filter((game) => game.hasClock).length;
  // Every eligible game has an opening. Middlegames and endgames are reached.
  const openingReach = eligible.length;
  const middlegameReach = eligible.filter((game) => game.reachedMiddlegame).length;
  const endgameReach = eligible.filter((game) => game.reachedEndgame).length;

  if (eligible.length < policy.sufficientGames) limitations.push("few_games");
  if (
    earliest !== null &&
    latest !== null &&
    latest.getTime() - earliest.getTime() < 7 * DAY_MS &&
    eligible.length > 0
  ) {
    // A fortnight of games taken from one weekend says how someone played that
    // weekend. Naming it stops a burst of blitz from reading as a career.
    limitations.push("narrow_date_range");
  }
  if (speeds.length === 1) limitations.push("single_speed");
  if (eligible.length > 0 && clockAvailable === 0) limitations.push("no_clock_data");
  if (middlegameReach < policy.minimumPhaseReach) limitations.push("few_middlegames");
  if (endgameReach < policy.minimumPhaseReach) limitations.push("few_endgames");

  let ratingInRange: boolean | null = null;
  if (context.providerRating !== null) {
    ratingInRange =
      context.providerRating >= policy.calibratedRatingLow &&
      context.providerRating < policy.calibratedRatingHigh;
    // Out of range is not a failure and not a smaller report: platform spec 3.2
    // says such a player still sees objective game facts. What is suppressed is
    // the cohort comparison, and saying so is the whole point of the flag.
    if (!ratingInRange) limitations.push("outside_calibrated_rating");
  }

  const measured = dimensions.map((dimension) => judgeDimension(dimension, policy));
  // Nothing measured at all is a different fact from "measured, and thin", and
  // it has to be said out loud. `decideOverall` asks whether *any* dimension is
  // sufficient, and on an empty list that is vacuously false -- so the state
  // came out `limited` with an empty limitation list, which the schema refuses
  // outright: a report that is not sufficient must name what is missing. The
  // insert failed on that constraint, which was the right outcome and an
  // unhelpful way to find out.
  if (measured.length === 0) {
    limitations.push("no_measured_dimensions");
  } else if (measured.some((dimension) => dimension.state !== "sufficient")) {
    limitations.push("thin_dimensions");
  }

  const overallState = decideOverall(eligible.length, measured, policy);

  return {
    overallState,
    totalGames: games.length,
    eligibleGames: eligible.length,
    earliestPlayedAt: earliest,
    latestPlayedAt: latest,
    speedsCovered: speeds,
    clockAvailableGames: clockAvailable,
    openingReachCount: openingReach,
    middlegameReachCount: middlegameReach,
    endgameReachCount: endgameReach,
    ratingInCalibratedRange: ratingInRange,
    // Deduplicated and ordered, so two runs over the same evidence write the
    // same array and a diff between reports means something changed.
    limitations: [...new Set(limitations)].sort(),
    dimensions: measured,
  };
}

function judgeDimension(
  dimension: DimensionFacts,
  policy: CoveragePolicy,
): DimensionCoverage {
  if (dimension.observationCount < policy.minimumDimensionObservations) {
    return {
      ...dimension,
      state: "insufficient",
      limitationReason: `only ${dimension.observationCount} chances observed`,
    };
  }
  if (dimension.effectiveCount < policy.sufficientDimensionObservations) {
    return {
      ...dimension,
      state: "limited",
      // Effective rather than raw: evidence from a year ago still counts and
      // still counts less, and a user told "we have 30 of these" when 28 are
      // stale has been given a true number and a false impression.
      limitationReason: `${dimension.effectiveCount.toFixed(1)} chances after time weighting`,
    };
  }
  return { ...dimension, state: "sufficient", limitationReason: null };
}

/**
 * The overall state.
 *
 * `sufficient` requires both the game count and at least one dimension that is
 * itself sufficient. Fifty games that never once produced a measurable chance
 * is a lot of evidence about nothing in particular, and calling that state
 * sufficient would be the most defensible-looking way to publish noise.
 */
function decideOverall(
  eligibleGames: number,
  dimensions: readonly DimensionCoverage[],
  policy: CoveragePolicy,
): CoverageState {
  if (eligibleGames < policy.minimumGames) return "insufficient";
  const anySufficient = dimensions.some((dimension) => dimension.state === "sufficient");
  if (eligibleGames >= policy.sufficientGames && anySufficient) return "sufficient";
  return "limited";
}

/**
 * The sentence a user reads for each limitation.
 *
 * Kept beside the vocabulary rather than in a template file, so adding a
 * limitation without saying what it means to a person fails to compile.
 */
export const LIMITATION_TEXT: Readonly<Record<Limitation, string>> = Object.freeze({
  few_games: "We have fewer games than we need for a full picture. More games will fill this in.",
  narrow_date_range:
    "Your games come from a short stretch of time, so this describes a period rather than a habit.",
  single_speed: "All your games are one time control, so nothing here compares your speeds.",
  no_clock_data: "None of your games carry clock data, so nothing here is about time pressure.",
  few_endgames: "Few of your games reached an endgame, so that part of the report is thin.",
  few_middlegames: "Few of your games reached a middlegame, so that part of the report is thin.",
  outside_calibrated_rating:
    "Your rating is outside the range Forma has calibrated, so comparisons to players at your level are not shown. Everything about your own games still applies.",
  thin_dimensions:
    "Some areas have too few chances to measure yet. They are listed with what is missing.",
  no_measured_dimensions:
    "We have your games, but nothing in them has been measured into a skill yet, so this report describes your play rather than rating it.",
});
