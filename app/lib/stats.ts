// Small-sample statistics for win rates. A rate over 3 games is mostly noise;
// these turn raw proportions into honest, rank-able numbers.

/**
 * Wilson score interval — a confidence interval for a binomial proportion that
 * stays sane at small N and extreme rates (unlike the normal approximation).
 * Ref: Evan Miller, "How Not To Sort By Average Rating".
 */
export function wilson(
  wins: number,
  n: number,
  z = 1.96,
): { p: number; lo: number; hi: number } {
  if (n <= 0) return { p: 0, lo: 0, hi: 0 };
  const phat = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (phat + z2 / (2 * n)) / denom;
  const margin =
    (z * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n))) / denom;
  return {
    p: phat,
    lo: Math.max(0, center - margin),
    hi: Math.min(1, center + margin),
  };
}

/**
 * Empirical-Bayes shrinkage toward a prior. The prior is Beta(mean*strength,
 * (1-mean)*strength); the posterior mean is (wins + a) / (n + a + b). With few
 * games the estimate sits near `priorMean`; with many it approaches the raw
 * rate. `strength` is roughly "how many games of evidence to move the needle".
 */
export function shrink(
  wins: number,
  n: number,
  priorMean: number,
  strength = 12,
): number {
  const a = priorMean * strength;
  const b = (1 - priorMean) * strength;
  return (wins + a) / (n + a + b);
}

/** Coarse sample-size confidence, for labelling. */
export function confidence(n: number): "low" | "medium" | "high" {
  if (n < 6) return "low";
  if (n < 20) return "medium";
  return "high";
}
