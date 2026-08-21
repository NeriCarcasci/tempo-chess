import { v1Data } from "./v1/client";
import type { PublicPlan, PublicPlans } from "./v1/types";

/**
 * The plan catalogue, from `GET /v1/public/plans`.
 *
 * Fetched rather than duplicated so the pricing page can never advertise a tier
 * the server does not honour.
 *
 * Two things the prototype's `/billing/plans` published are not on the
 * versioned surface, and both are deliberate subtractions rather than gaps to
 * fill in later. The Stripe price ids are gone, because a public catalogue has
 * no business naming them. The limit table is gone, because publishing it
 * invites a client to enforce entitlements that the server is the only
 * authority on.
 *
 * **There is no checkout call.** The prototype had `POST /billing/checkout` and
 * `POST /billing/portal`; `/v1` has neither, and Stripe is not wired. Nothing
 * here fakes one — see `routes/pricing.tsx`, where the button says so.
 */

export type Plan = PublicPlan;
export type PlanId = Plan["id"];
export type Interval = "monthly" | "yearly";
export type PlanCatalogue = PublicPlans;

export function fetchPlans(): Promise<PlanCatalogue> {
  // Public: the pricing page has to work for signed-out visitors.
  return v1Data<PlanCatalogue>("/v1/public/plans", { anonymous: true });
}

/** Dollars, with cents only when they're non-zero. */
export function formatPrice(minorUnits: number): string {
  const value = minorUnits / 100;
  return value % 1 === 0 ? `$${value}` : `$${value.toFixed(2)}`;
}

/** What a yearly plan saves versus paying monthly, as a percentage. */
export function yearlySaving(plan: Plan): number {
  if (!plan.priceMonthly || !plan.priceYearly) return 0;
  const monthlyTotal = plan.priceMonthly * 12;
  return Math.round(((monthlyTotal - plan.priceYearly) / monthlyTotal) * 100);
}
