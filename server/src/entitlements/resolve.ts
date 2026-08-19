import {
  BILLING_POLICY,
  DEFAULT_LIMITS,
  ENTITLING_STATUSES,
  SOURCE_PRECEDENCE,
  type BillingPolicy,
  type FeatureKey,
  type GrantSource,
  type SubscriptionStatus,
} from "./contract.js";

/**
 * Resolving what somebody may do, deterministically.
 *
 * Two grants can overlap — a subscription and a promotion, a trial and an admin
 * fix — so the resolution has to be a function of the grants and the time,
 * never of insertion order or of which row the query happened to return first.
 * A user who reloads a page and sees a different limit has been told the
 * product is guessing.
 */

export interface Grant {
  featureKey: FeatureKey;
  source: GrantSource;
  /** Null means unlimited; zero means explicitly denied. */
  quantitativeLimit: number | null;
  validFrom: Date;
  validTo: Date | null;
}

export interface Resolution {
  featureKey: FeatureKey;
  /** Null is unlimited. Zero is denied. */
  limit: number | null;
  /** Where the answer came from, or null when it is the default. */
  source: GrantSource | null;
  /** When this answer stops being true, if it does. */
  until: Date | null;
}

/** Whether a grant is in force at an instant. */
export function isActive(grant: Grant, at: Date): boolean {
  if (grant.validFrom > at) return false;
  return grant.validTo === null || grant.validTo > at;
}

/**
 * The effective limit for one feature.
 *
 * Precedence first, then the more generous limit, then the later start. The
 * tie-breaks matter: two promotions granted the same day should not resolve
 * differently depending on which row came back first, and when they genuinely
 * differ the user gets the better of the two. Being stingy on a tie is the kind
 * of decision that is invisible in code review and infuriating in support.
 *
 * An explicit zero from a higher-precedence source beats a generous lower one —
 * that is a deliberate denial, usually from support handling abuse, and it has
 * to survive the subscription underneath it.
 */
export function resolveFeature(
  featureKey: FeatureKey,
  grants: readonly Grant[],
  at: Date,
): Resolution {
  const applicable = grants.filter(
    (grant) => grant.featureKey === featureKey && isActive(grant, at),
  );
  if (applicable.length === 0) {
    return {
      featureKey,
      limit: DEFAULT_LIMITS[featureKey] ?? 0,
      source: null,
      until: null,
    };
  }

  const best = applicable.reduce((winner, candidate) => {
    const byPrecedence =
      SOURCE_PRECEDENCE[candidate.source] - SOURCE_PRECEDENCE[winner.source];
    if (byPrecedence !== 0) return byPrecedence > 0 ? candidate : winner;
    const byGenerosity = compareLimits(candidate.quantitativeLimit, winner.quantitativeLimit);
    if (byGenerosity !== 0) return byGenerosity > 0 ? candidate : winner;
    return candidate.validFrom > winner.validFrom ? candidate : winner;
  });

  return {
    featureKey,
    limit: best.quantitativeLimit,
    source: best.source,
    until: best.validTo,
  };
}

/** Unlimited beats any number; a larger number beats a smaller one. */
function compareLimits(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

/** Resolve every feature at once, for a page that needs the whole picture. */
export function resolveAll(
  grants: readonly Grant[],
  at: Date,
): Record<FeatureKey, Resolution> {
  const out = {} as Record<FeatureKey, Resolution>;
  for (const featureKey of Object.keys(DEFAULT_LIMITS) as FeatureKey[]) {
    out[featureKey] = resolveFeature(featureKey, grants, at);
  }
  return out;
}

export interface SubscriptionState {
  status: SubscriptionStatus;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

/**
 * Whether a subscription still entitles somebody, and until when.
 *
 * `past_due` keeps its entitlements for the dunning window. Somebody whose card
 * expired has not stopped being a customer, and cutting access the hour a
 * renewal fails is how a product loses a person it had already convinced.
 *
 * A subscription set to cancel at period end is entitled *until* that end, not
 * from the moment they clicked cancel. They paid for the month.
 */
export function subscriptionEntitles(
  state: SubscriptionState,
  at: Date,
  policy: BillingPolicy = BILLING_POLICY,
): { entitled: boolean; until: Date | null; reason: string } {
  if (!ENTITLING_STATUSES.includes(state.status)) {
    return { entitled: false, until: null, reason: `subscription is ${state.status}` };
  }
  if (state.status === "past_due") {
    const deadline = state.currentPeriodEnd
      ? new Date(state.currentPeriodEnd.getTime() + policy.dunningGraceDays * 86_400_000)
      : null;
    if (deadline !== null && at > deadline) {
      return {
        entitled: false,
        until: deadline,
        reason: "the payment retry window has passed",
      };
    }
    return {
      entitled: true,
      until: deadline,
      reason: "payment has not gone through, and access continues while it is retried",
    };
  }
  return {
    entitled: true,
    until: state.cancelAtPeriodEnd ? state.currentPeriodEnd : null,
    reason: state.cancelAtPeriodEnd
      ? "cancelled, and paid for until the end of the period"
      : `subscription is ${state.status}`,
  };
}

/**
 * What a user is told when a feature is not available to them.
 *
 * An offer, never a scold, and never a claim that the underlying fact is
 * different. "There is more detail behind a plan" is honest; "we could not
 * analyse this" would not be.
 */
export function describeLimit(resolution: Resolution): string | null {
  if (resolution.limit === null) return null;
  if (resolution.limit === 0) {
    return resolution.source === "admin"
      ? "This is turned off on your account. Support can tell you why."
      : "This is part of a paid plan. Everything already in your report stays exactly as it is.";
  }
  return `Your plan covers ${resolution.limit} of these.`;
}
