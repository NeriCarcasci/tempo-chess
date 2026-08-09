/**
 * Plan definitions — the single source of truth for what each tier costs and
 * what it unlocks. The client imports the same shape over `GET /billing/plans`
 * so the pricing page and the server's entitlement checks can never drift.
 *
 * Stripe is not wired up yet. `priceId` is the seam: fill these from the Stripe
 * dashboard (or STRIPE_PRICE_* env vars) and the checkout stub in ./service.ts
 * becomes a real session without any other file changing.
 */

export type PlanId = "free" | "pro";

export interface PlanFeature {
  label: string;
  /** false renders as a struck-through / muted row on the pricing table. */
  included: boolean;
}

export interface Plan {
  id: PlanId;
  name: string;
  tagline: string;
  /** Price in minor units (cents), billed monthly. */
  priceMonthly: number;
  priceYearly: number;
  currency: "usd";
  /** Stripe price ids — null until the Stripe account is live. */
  priceIdMonthly: string | null;
  priceIdYearly: string | null;
  features: PlanFeature[];
  limits: PlanLimits;
}

export interface PlanLimits {
  /** Games kept in the analysed history. null = unlimited. */
  analysedGames: number | null;
  /** Mistake drills served per day. null = unlimited. */
  dailyDrills: number | null;
  /** Depth the opening explorer will walk, in plies. */
  explorerDepth: number;
  deepEngineAnalysis: boolean;
  fullRepertoireMap: boolean;
}

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: "free",
    name: "Free",
    tagline: "See where your play actually breaks down.",
    priceMonthly: 0,
    priceYearly: 0,
    currency: "usd",
    priceIdMonthly: null,
    priceIdYearly: null,
    limits: {
      analysedGames: 50,
      dailyDrills: 10,
      explorerDepth: 12,
      deepEngineAnalysis: false,
      fullRepertoireMap: false,
    },
    features: [
      { label: "Your last 50 games analysed", included: true },
      { label: "Record, ratings and opening breakdown", included: true },
      { label: "10 mistake drills a day", included: true },
      { label: "All 13 guided lessons", included: true },
      { label: "Opening explorer to move 6", included: true },
      { label: "Full history analysis", included: false },
      { label: "Deep engine review of every game", included: false },
      { label: "Complete repertoire map", included: false },
    ],
  },
  pro: {
    id: "pro",
    name: "Pro",
    tagline: "Your whole history, analysed to the bottom.",
    priceMonthly: 900,
    priceYearly: 9000,
    currency: "usd",
    priceIdMonthly: process.env.STRIPE_PRICE_PRO_MONTHLY ?? null,
    priceIdYearly: process.env.STRIPE_PRICE_PRO_YEARLY ?? null,
    limits: {
      analysedGames: null,
      dailyDrills: null,
      explorerDepth: 40,
      deepEngineAnalysis: true,
      fullRepertoireMap: true,
    },
    features: [
      { label: "Every game you have ever played, analysed", included: true },
      { label: "Deep engine review, not just a screening pass", included: true },
      { label: "Unlimited mistake drills", included: true },
      { label: "Complete repertoire map with gap detection", included: true },
      { label: "Opening explorer to move 20", included: true },
      { label: "Personalised puzzles from your own blunders", included: true },
      { label: "Play-out from any position at your rating", included: true },
      { label: "Priority analysis queue", included: true },
    ],
  },
};

export const PLAN_LIST: Plan[] = [PLANS.free, PLANS.pro];

export function limitsFor(plan: PlanId): PlanLimits {
  return PLANS[plan].limits;
}
