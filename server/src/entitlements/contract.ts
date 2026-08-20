/**
 * The entitlement contract: what a person may do, why, and until when.
 *
 * The rule that shapes everything: an entitlement changes what is *shown* and
 * never what is *true*. Nothing here is read by an estimator, a finding or a
 * report as a fact. A free reader and a paying reader see the same evidence and
 * the same uncertainty; what differs is depth, continuity and how much compute
 * the product will spend on their behalf.
 */

export const FEATURE_KEYS = [
  "analysis.deep_review",
  "analysis.monthly_games",
  "report.pro_detail",
  "practice.daily_drills",
  "explorer.depth",
  "export.data",
] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

export const GRANT_SOURCES = [
  "subscription",
  "trial",
  "promotion",
  "editorial",
  "admin",
] as const;
export type GrantSource = (typeof GRANT_SOURCES)[number];

/**
 * Which source wins when two grants overlap.
 *
 * Higher wins. `admin` is at the top because it is the deliberate act of a
 * named person fixing something for somebody, and it should not be silently
 * overridden by a subscription tier changing underneath them. `subscription` is
 * at the bottom because it is the default everyone has, and a trial or a
 * promotion is always something extra on top of it.
 */
export const SOURCE_PRECEDENCE: Readonly<Record<GrantSource, number>> = Object.freeze({
  subscription: 1,
  trial: 2,
  promotion: 3,
  editorial: 4,
  admin: 5,
});

export const SUBSCRIPTION_STATUSES = [
  "trialing",
  "active",
  "past_due",
  "canceled",
  "incomplete",
  "incomplete_expired",
  "unpaid",
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/**
 * Which statuses still entitle somebody.
 *
 * `past_due` does. Someone whose card expired has not stopped being a customer,
 * and cutting their access the hour a renewal fails is how a product loses a
 * person it had already convinced. The grace window is the dunning period; the
 * subscription moves to `unpaid` or `canceled` if it never resolves.
 */
export const ENTITLING_STATUSES: readonly SubscriptionStatus[] = Object.freeze([
  "trialing",
  "active",
  "past_due",
]);

/**
 * The prices the server will accept, by key.
 *
 * A client sends `"pro_monthly"`, never a Stripe price id. An identifier
 * arriving from a browser is one nobody approved, and an allowlist keyed by our
 * own vocabulary is what makes "arbitrary price" unrepresentable rather than
 * merely discouraged.
 *
 * The values are read from the environment because they differ between a test
 * account and a live one, and neither belongs in the repository.
 */
export const PRICE_KEYS = ["pro_monthly", "pro_yearly"] as const;
export type PriceKey = (typeof PRICE_KEYS)[number];

export function isPriceKey(value: string): value is PriceKey {
  return (PRICE_KEYS as readonly string[]).includes(value);
}

/**
 * Return URLs the checkout and portal flows may send somebody back to.
 *
 * Path suffixes on our own origin, resolved server-side. A caller supplies a
 * key; it never supplies a URL. An open redirect on a billing return is one of
 * the more effective phishing primitives a payment flow can hand out.
 */
export const RETURN_PATHS = Object.freeze({
  billing_success: "/settings/billing?checkout=success",
  billing_cancelled: "/settings/billing?checkout=cancelled",
  billing_portal: "/settings/billing",
});
export type ReturnKey = keyof typeof RETURN_PATHS;

export function isReturnKey(value: string): value is ReturnKey {
  return Object.prototype.hasOwnProperty.call(RETURN_PATHS, value);
}

/** The grants a subscription at each price implies. */
export const PRICE_ENTITLEMENTS: Readonly<
  Record<PriceKey, readonly { featureKey: FeatureKey; limit: number | null }[]>
> = Object.freeze({
  pro_monthly: [
    { featureKey: "analysis.deep_review", limit: null },
    { featureKey: "analysis.monthly_games", limit: 500 },
    { featureKey: "report.pro_detail", limit: null },
    { featureKey: "practice.daily_drills", limit: null },
    { featureKey: "explorer.depth", limit: 20 },
    { featureKey: "export.data", limit: null },
  ],
  pro_yearly: [
    { featureKey: "analysis.deep_review", limit: null },
    { featureKey: "analysis.monthly_games", limit: 500 },
    { featureKey: "report.pro_detail", limit: null },
    { featureKey: "practice.daily_drills", limit: null },
    { featureKey: "explorer.depth", limit: 20 },
    { featureKey: "export.data", limit: null },
  ],
});

/**
 * What everybody gets without any grant.
 *
 * Not zero. A free account is a usable product, not a demo with the lights off:
 * the report is complete and truthful, the analysis is real, and the limits are
 * on volume and depth rather than on honesty.
 */
export const DEFAULT_LIMITS: Readonly<Record<FeatureKey, number | null>> = Object.freeze({
  "analysis.deep_review": 0,
  "analysis.monthly_games": 30,
  "report.pro_detail": 0,
  "practice.daily_drills": 10,
  "explorer.depth": 6,
  "export.data": 1,
});

export const RELEASE_REASONS = [
  "work_failed",
  "work_cancelled",
  "reservation_expired",
  "refunded",
] as const;
export type ReleaseReason = (typeof RELEASE_REASONS)[number];

export interface BillingPolicy {
  version: string;
  /** A reservation older than this is released by the sweep. */
  reservationTtlMinutes: number;
  /** How long a `past_due` subscription keeps its entitlements. */
  dunningGraceDays: number;
  /** Webhook attempts before an event is parked as failed. */
  maxWebhookAttempts: number;
  /** Signature timestamps outside this window are rejected as replays. */
  webhookToleranceSeconds: number;
}

export const BILLING_POLICY: BillingPolicy = Object.freeze({
  version: "billing_policy_v1",
  reservationTtlMinutes: 30,
  dunningGraceDays: 14,
  maxWebhookAttempts: 8,
  webhookToleranceSeconds: 300,
});

/** Named budgets, asserted by `entitlements:performance`. */
export const ENTITLEMENT_BUDGETS = Object.freeze({
  maxResolveQueries: 2,
  resolveMs: 50,
  reserveMs: 100,
});
