/**
 * The Beta distribution, to the precision an interval needs.
 *
 * `estimator_v1` is a discounted Beta model, so every interval it publishes is
 * a Beta quantile. Doing that with a normal approximation would be wrong in
 * exactly the case the product cares most about — small samples, where the
 * posterior is skewed and the approximation puts the bound outside [0, 1] or
 * far from where it belongs.
 *
 * Everything here is deterministic and dependency-free. The three pieces are
 * standard: a Lanczos log-gamma, a Lentz continued fraction for the regularized
 * incomplete beta, and bisection for its inverse. Bisection rather than
 * Newton's method because it cannot diverge and 60 halvings of [0, 1] reach
 * double precision, which costs microseconds on a page that is built once.
 */

const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** Log of the gamma function, Lanczos approximation, g = 7, n = 9. */
export function logGamma(x: number): number {
  if (x < 0.5) {
    // Reflection, so the series is only ever evaluated where it converges well.
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const z = x - 1;
  let a = 0.99999999999980993;
  for (let i = 0; i < LANCZOS.length; i += 1) a += LANCZOS[i]! / (z + i + 1);
  const t = z + LANCZOS.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

export function logBeta(a: number, b: number): number {
  return logGamma(a) + logGamma(b) - logGamma(a + b);
}

/**
 * The regularized incomplete beta function `I_x(a, b)`, i.e. the Beta CDF.
 *
 * The continued fraction converges quickly for `x < (a + 1) / (a + b + 2)`, so
 * the other side is reached by the symmetry `I_x(a, b) = 1 - I_(1-x)(b, a)`.
 */
export function betaCdf(x: number, a: number, b: number): number {
  if (!(a > 0 && b > 0)) throw new Error("Beta parameters must be positive");
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  if (x > (a + 1) / (a + b + 2)) return 1 - betaCdf(1 - x, b, a);

  const front = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - logBeta(a, b)) / a;
  return front * continuedFraction(x, a, b);
}

/**
 * Lentz's algorithm for the continued fraction of the incomplete beta.
 *
 * The even and odd steps have different coefficients and must be taken as a
 * pair inside one iteration; folding them into a single alternating step looks
 * equivalent and is not. Written here in the Numerical Recipes form for exactly
 * that reason.
 */
function continuedFraction(x: number, a: number, b: number): number {
  const tiny = 1e-30;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;

  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;

  for (let m = 1; m <= 300; m += 1) {
    const m2 = 2 * m;

    // Even step.
    let numerator = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + numerator * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + numerator / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;

    // Odd step.
    numerator = (-((a + m) * (qab + m) * x)) / ((a + m2) * (qap + m2));
    d = 1 + numerator * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + numerator / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const step = d * c;
    h *= step;

    if (Math.abs(step - 1) < 1e-15) return h;
  }
  // Three hundred iterations without convergence means the parameters are
  // extreme enough that the answer would be untrustworthy anyway.
  return h;
}

/**
 * The inverse Beta CDF by bisection.
 *
 * Sixty halvings take the bracket from 1 to 2^-60, which is below double
 * precision, so the loop always ends on precision rather than on iterations.
 */
export function betaQuantile(p: number, a: number, b: number): number {
  if (!(p >= 0 && p <= 1)) throw new Error("a quantile needs a probability");
  if (p === 0) return 0;
  if (p === 1) return 1;
  let low = 0;
  let high = 1;
  for (let i = 0; i < 60; i += 1) {
    const mid = (low + high) / 2;
    if (betaCdf(mid, a, b) < p) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/** The Beta density at `x`. Used to integrate one posterior against another. */
export function betaPdf(x: number, a: number, b: number): number {
  if (x <= 0 || x >= 1) return 0;
  return Math.exp((a - 1) * Math.log(x) + (b - 1) * Math.log(1 - x) - logBeta(a, b));
}

/**
 * `P(X > Y)` for two independent Beta variables, by Simpson's rule.
 *
 * This is the improvement probability: how likely it is that the player's
 * recent form is genuinely better than their baseline, rather than the same
 * ability sampled twice. Numeric integration rather than Monte Carlo because
 * the result is stored, and a stored number that changes when you recompute it
 * is not evidence.
 *
 * The interval is open on both ends: both densities can diverge at 0 and 1 for
 * parameters below one, and Simpson's rule does not need the endpoints.
 */
export function probabilityGreater(
  x: { alpha: number; beta: number },
  y: { alpha: number; beta: number },
  panels = 2_000,
): number {
  const n = panels % 2 === 0 ? panels : panels + 1;
  const h = 1 / n;
  let total = 0;
  for (let i = 1; i < n; i += 1) {
    const t = i * h;
    const weight = i % 2 === 0 ? 2 : 4;
    total += weight * betaPdf(t, x.alpha, x.beta) * betaCdf(t, y.alpha, y.beta);
  }
  const value = (h / 3) * total;
  return Math.min(1, Math.max(0, value));
}
