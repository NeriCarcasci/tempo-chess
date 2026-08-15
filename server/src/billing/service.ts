import { client } from "../db/client.js";
import { PLANS, type Plan, type PlanId } from "./plans.js";

/**
 * Billing seam. Stripe is deliberately not a dependency yet — this module owns
 * the shape of every billing operation so that plugging Stripe in later is an
 * edit inside these three functions and nothing else.
 *
 * What is real today: the plan stored on `profiles.plan`, entitlement lookups,
 * and the HTTP surface the client calls. What is stubbed: the hosted checkout
 * and customer-portal redirects, and webhook signature verification.
 */

const stripeSecret = process.env.STRIPE_SECRET_KEY ?? null;
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET ?? null;

export const billingConfigured = Boolean(stripeSecret);

export interface Subscription {
  plan: PlanId;
  status: "active" | "none";
  /** Null until Stripe is live and we start storing periods. */
  currentPeriodEnd: string | null;
  /** True when the plan was granted manually rather than bought. */
  comped: boolean;
}

export async function getSubscription(userId: string): Promise<Subscription> {
  const rows = await client`select plan from profiles where id = ${userId} limit 1`;
  const plan: PlanId = rows[0]?.plan === "pro" ? "pro" : "free";
  return {
    plan,
    status: plan === "pro" ? "active" : "none",
    currentPeriodEnd: null,
    // Without Stripe there is no purchase record, so any Pro plan on the books
    // today was set by hand. Once checkout is live this reads the Stripe record.
    comped: plan === "pro" && !billingConfigured,
  };
}

export interface CheckoutRequest {
  userId: string;
  email: string | null;
  plan: PlanId;
  interval: "monthly" | "yearly";
  successUrl: string;
  cancelUrl: string;
}

export interface CheckoutSession {
  /** Where the browser should go next. Null while Stripe is unconfigured. */
  url: string | null;
  /** Tells the client to show "billing isn't live yet" instead of redirecting. */
  configured: boolean;
  message: string;
}

/**
 * Create a hosted-checkout session.
 *
 * TO WIRE STRIPE: set STRIPE_SECRET_KEY + the STRIPE_PRICE_* ids, add the
 * `stripe` package, and replace the stub branch with:
 *
 *   const session = await stripe.checkout.sessions.create({
 *     mode: "subscription",
 *     customer_email: req.email ?? undefined,
 *     client_reference_id: req.userId,
 *     line_items: [{ price: priceId, quantity: 1 }],
 *     success_url: req.successUrl,
 *     cancel_url: req.cancelUrl,
 *   });
 *   return { url: session.url, configured: true, message: "" };
 *
 * Everything else — the route, the client call, the redirect handling, the
 * post-payment `?checkout=success` landing — already works.
 */
export async function createCheckoutSession(req: CheckoutRequest): Promise<CheckoutSession> {
  const target: Plan = PLANS[req.plan];
  const priceId = req.interval === "yearly" ? target.priceIdYearly : target.priceIdMonthly;

  if (!billingConfigured || !priceId) {
    return {
      url: null,
      configured: false,
      message:
        "Checkout isn't live yet. Forma is free while we finish billing — you already have full access.",
    };
  }

  throw new Error("Stripe checkout is configured but not implemented yet");
}

/**
 * Customer-portal link for managing or cancelling an existing subscription.
 * TO WIRE STRIPE: `stripe.billingPortal.sessions.create({ customer, return_url })`.
 */
export async function createPortalSession(
  userId: string,
  returnUrl: string,
): Promise<CheckoutSession> {
  void userId;
  void returnUrl;
  if (!billingConfigured) {
    return {
      url: null,
      configured: false,
      message: "There's no subscription to manage yet.",
    };
  }
  throw new Error("Stripe billing portal is configured but not implemented yet");
}

/**
 * Apply a plan change. Called by the Stripe webhook once it is live; kept
 * separate from the webhook so it can also back a manual/admin grant.
 */
export async function setPlan(userId: string, plan: PlanId): Promise<Subscription> {
  await client`update profiles set plan = ${plan}::plan where id = ${userId}`;
  return getSubscription(userId);
}

export interface WebhookResult {
  handled: boolean;
  message: string;
}

/**
 * Stripe webhook endpoint.
 * TO WIRE STRIPE: verify with `stripe.webhooks.constructEvent(rawBody, sig,
 * webhookSecret)`, then map `checkout.session.completed` and
 * `customer.subscription.*` onto setPlan(). Until then this refuses everything,
 * so an unsigned POST can never grant a plan.
 */
export async function handleWebhook(
  rawBody: string,
  signature: string | null,
): Promise<WebhookResult> {
  void rawBody;
  if (!webhookSecret || !signature) {
    return { handled: false, message: "Billing webhooks are not configured" };
  }
  throw new Error("Stripe webhook secret is set but handling is not implemented yet");
}
