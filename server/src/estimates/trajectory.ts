import { ALIGNMENT_POLICY, type AlignmentPolicy } from "./contract.js";

/**
 * `trajectory_alignment_v1` — the homepage curve.
 *
 * The rule that shapes everything here is platform spec 3.5's last line: the
 * display must not imply that all games follow one exact curve. So:
 *
 * - each reached phase is normalized to 0–100% *independently*, which is what
 *   makes a 20-move opening and a 6-move opening comparable without stretching
 *   one over the other;
 * - a game contributes to a phase only if it reached it. An endgame nobody
 *   played is an absent bin, never an imputed one;
 * - games are weighted equally, so a 200-move marathon does not outvote ten
 *   short games in the middlegame bins;
 * - every bin carries the share of games that reached its phase, so a smooth
 *   endgame line drawn from a fifth of the games is visibly that.
 *
 * There is no dynamic time warping. 18.3 rules it out for the canonical graph,
 * and the reason is worth keeping: unconstrained warping will align any two
 * curves, which makes the resulting average a picture of the algorithm rather
 * than of the player.
 */

export type Phase = "opening" | "middlegame" | "endgame";

/** One position in one game, as the assessment recorded it. */
export interface TrajectoryPoint {
  ply: number;
  phase: Phase;
  /** Expected score from the subject's perspective, 0–1. */
  expectedScore: number;
}

export interface TrajectoryGame {
  gameKey: string;
  points: readonly TrajectoryPoint[];
}

export interface TrajectoryBin {
  phase: Phase;
  binOrdinal: number;
  progressLow: number;
  progressHigh: number;
  gamesContributing: number;
  medianExpectedScore: number;
  p25ExpectedScore: number;
  p75ExpectedScore: number;
  intervalLow: number | null;
  intervalHigh: number | null;
  phaseReachRate: number;
  adverseChangeRate: number | null;
  recoverySlope: number | null;
}

const PHASES: readonly Phase[] = ["opening", "middlegame", "endgame"];

/**
 * Align a set of games into phase-normalized bins.
 *
 * `seed` makes the bootstrap deterministic. A stored interval that changes when
 * you recompute it is not evidence, so the resampler is a small seeded PRNG
 * rather than `Math.random`.
 */
export function alignTrajectory(
  games: readonly TrajectoryGame[],
  options: { policy?: AlignmentPolicy; seed?: number } = {},
): TrajectoryBin[] {
  const policy = options.policy ?? ALIGNMENT_POLICY;
  const totalGames = games.length;
  if (totalGames === 0) return [];

  const bins: TrajectoryBin[] = [];

  for (const phase of PHASES) {
    // One value per game per bin, so a game with forty middlegame plies and a
    // game with six weigh the same in every bin they both reach.
    const perBin: number[][] = Array.from({ length: policy.binsPerPhase }, () => []);
    let gamesReachingPhase = 0;

    for (const game of games) {
      const points = game.points
        .filter((point) => point.phase === phase)
        .sort((a, b) => a.ply - b.ply);
      if (points.length < policy.minPliesPerPhase) continue;
      gamesReachingPhase += 1;

      const first = points[0]!.ply;
      const last = points[points.length - 1]!.ply;
      const span = last - first;

      const collected: number[][] = Array.from({ length: policy.binsPerPhase }, () => []);
      for (const point of points) {
        // A phase of one ply would divide by zero; it also has no progress to
        // speak of, so it all lands in the first bin.
        const progress = span === 0 ? 0 : (point.ply - first) / span;
        const index = Math.min(policy.binsPerPhase - 1, Math.floor(progress * policy.binsPerPhase));
        collected[index]!.push(point.expectedScore);
      }
      for (let index = 0; index < policy.binsPerPhase; index += 1) {
        const values = collected[index]!;
        if (values.length > 0) perBin[index]!.push(mean(values));
      }
    }

    if (gamesReachingPhase === 0) continue;
    const reachRate = gamesReachingPhase / totalGames;

    for (let index = 0; index < policy.binsPerPhase; index += 1) {
      const values = perBin[index]!;
      // No games in this bin is no bin. 18.3 forbids imputing what nobody
      // played, and a row of zeros is the most convincing way to do exactly
      // that.
      if (values.length === 0) continue;
      const sorted = [...values].sort((a, b) => a - b);
      const interval =
        policy.bootstrapResamples > 0 && values.length >= 3
          ? bootstrapMedianInterval(sorted, policy.bootstrapResamples, (options.seed ?? 1) + index)
          : null;

      bins.push({
        phase,
        binOrdinal: index,
        progressLow: index / policy.binsPerPhase,
        progressHigh: (index + 1) / policy.binsPerPhase,
        gamesContributing: values.length,
        medianExpectedScore: quantile(sorted, 0.5),
        p25ExpectedScore: quantile(sorted, 0.25),
        p75ExpectedScore: quantile(sorted, 0.75),
        intervalLow: interval?.low ?? null,
        intervalHigh: interval?.high ?? null,
        phaseReachRate: reachRate,
        adverseChangeRate: null,
        recoverySlope: null,
      });
    }
  }

  return bins;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Linear-interpolated quantile of an already-sorted sample. */
export function quantile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) throw new Error("no sample");
  if (sorted.length === 1) return sorted[0]!;
  const position = p * (sorted.length - 1);
  const low = Math.floor(position);
  const high = Math.ceil(position);
  if (low === high) return sorted[low]!;
  return sorted[low]! + (position - low) * (sorted[high]! - sorted[low]!);
}

/** A small deterministic PRNG, so a stored interval is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function bootstrapMedianInterval(
  sorted: readonly number[],
  resamples: number,
  seed: number,
): { low: number; high: number } {
  const random = mulberry32(seed);
  const medians: number[] = [];
  for (let i = 0; i < resamples; i += 1) {
    const sample: number[] = [];
    for (let j = 0; j < sorted.length; j += 1) {
      sample.push(sorted[Math.floor(random() * sorted.length)]!);
    }
    sample.sort((a, b) => a - b);
    medians.push(quantile(sample, 0.5));
  }
  medians.sort((a, b) => a - b);
  return { low: quantile(medians, 0.05), high: quantile(medians, 0.95) };
}

/**
 * A recovery episode, measured from the player's own moves.
 *
 * Platform spec 3.4: recovery is not "the final result was good", and an
 * opponent's concession is not the player's recovery. So the slope is computed
 * over the plies where the *subject* was to move, and the original adverse
 * change is returned untouched beside it — a blunder that was later rebuilt is
 * still a blunder.
 */
export interface RecoveryMeasurement {
  adverseChange: number;
  recoverySlope: number | null;
  stabilized: boolean;
  /** True when the gain came from the opponent's errors rather than the player's moves. */
  counterpartyDriven: boolean;
}

export function measureRecovery(input: {
  beforeScore: number;
  troughScore: number;
  endScore: number;
  subjectPlies: number;
  /** Expected-score gained on plies where the opponent, not the subject, moved. */
  counterpartyGain: number;
}): RecoveryMeasurement {
  const adverseChange = input.beforeScore - input.troughScore;
  const totalGain = input.endScore - input.troughScore;
  const subjectGain = totalGain - input.counterpartyGain;
  return {
    adverseChange,
    recoverySlope: input.subjectPlies > 0 ? subjectGain / input.subjectPlies : null,
    // Stabilization is about ending above the trough, not about ending above
    // where the player started. Requiring the latter would call every
    // successful defence a failure.
    stabilized: input.endScore > input.troughScore,
    counterpartyDriven: totalGain > 0 && subjectGain <= 0,
  };
}
