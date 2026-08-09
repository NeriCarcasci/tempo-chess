import { api, apiFetch } from "./api";

/**
 * Client half of the billing seam. Mirrors `server/src/billing/plans.ts`; the
 * plan catalogue is fetched rather than duplicated so the pricing page can
 * never advertise a tier the server doesn't honour.
 */

export type PlanId = "free" | "pro";
export type Interval = "monthly" | "yearly";

export interface PlanFeature {
  label: string;
  included: boolean;
}

export interface PlanLimits {
  analysedGames: number | null;
  dailyDrills: number | null;
  explorerDepth: number;
  deepEngineAnalysis: boolean;
  fullRepertoireMap: boolean;
}

export interface Plan {
  id: PlanId;
  name: string;
  tagline: string;
  priceMonthly: number;
  priceYearly: number;
  currency: "usd";
  priceIdMonthly: string | null;
  priceIdYearly: string | null;
  features: PlanFeature[];
  limits: PlanLimits;
}

export interface PlanCatalogue {
  plans: Plan[];
  /** False until Stripe keys are set on the API. */
  configured: boolean;
}

export function fetchPlans(): Promise<PlanCatalogue> {
  // Public: the pricing page has to work for signed-out visitors.
  return api<PlanCatalogue>("/billing/plans", { anonymous: true });
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

export interface CheckoutResult {
  url: string | null;
  configured: boolean;
  message: string;
}

/**
 * Start a subscription. When Stripe is live this returns a hosted-checkout URL
 * and we hand the browser over; until then the server answers `configured:
 * false` and the caller shows the message instead of redirecting.
 */
export async function startCheckout(plan: PlanId, interval: Interval): Promise<CheckoutResult> {
  const result = await api<CheckoutResult>("/billing/checkout", {
    json: {
      plan,
      interval,
      successUrl: `${location.origin}/account?checkout=success`,
      cancelUrl: `${location.origin}/pricing?checkout=cancelled`,
    },
  });
  if (result.url) location.href = result.url;
  return result;
}

/** Open the customer portal to change or cancel an existing subscription. */
export async function openBillingPortal(): Promise<CheckoutResult> {
  const response = await apiFetch("/billing/portal", {
    json: { returnUrl: `${location.origin}/account` },
  });
  const result = await response.json() as CheckoutResult;
  if (result.url) location.href = result.url;
  return result;
}
