import { z } from "zod";
import { PLAN_LIST } from "../../billing/plans.js";
import { billingConfigured } from "../../billing/service.js";
import { PLATFORM_CHOICES, RATING_CHOICES, recordBetaSignup } from "../../beta.js";
import { getPublicReach } from "../../players/reach.js";
import { POLICIES } from "../rate-limit.js";
import type { RouteDefinition } from "../registry.js";

/**
 * The public `/v1` surface, per plans/v1-api-contract.md §3.
 *
 * Three routes, chosen because they are the ones §3 defines that no later epic
 * owns, and because between them they exercise every kernel behaviour that can
 * be exercised without product data: envelope, ETag, caching, validation,
 * problem details, distributed abuse control, and durable idempotency.
 *
 * They sit *beside* the unversioned routes, which keep serving the current
 * frontend byte-for-byte. Migrating a consumer is a later epic's work.
 */

const reachSchema = z.object({
  players: z.number().int(),
  games: z.number().int(),
  counted: z.object({ players: z.number().int(), games: z.number().int() }),
  baseline: z.object({ players: z.number().int(), games: z.number().int() }),
  playersList: z.array(
    z.object({ username: z.string(), platform: z.enum(["lichess", "chesscom"]) }),
  ),
  updatedAt: z.string(),
});

/**
 * `GET /v1/public/stats` — the reach figures the landing page quotes.
 *
 * Cacheable and ETagged: it changes when the pipeline finishes work, which is
 * far less often than the landing page is loaded.
 */
const publicStats: RouteDefinition<never, never, z.infer<typeof reachSchema>> = {
  method: "GET",
  path: "/v1/public/stats",
  operationId: "getPublicStats",
  summary: "Approved aggregate product reach",
  description:
    "Public. Counted from rows rather than typed in, so the figure cannot drift from the truth. No small-cell counts and no private segmentation.",
  kind: "read",
  auth: "public",
  envelope: "resource",
  successStatus: 200,
  dataSchema: reachSchema,
  etag: true,
  cacheControl: "public, max-age=300",
  rateLimits: [{ policy: POLICIES.publicRead, source: "address" }],
  async handler() {
    const reach = await getPublicReach();
    return {
      data: {
        players: reach.players,
        games: reach.games,
        counted: reach.counted,
        baseline: reach.baseline,
        // Renamed from the legacy body's `players_list`: §16 of the platform
        // spec fixes camelCase for `/v1`, and the legacy route keeps its own
        // spelling for the client that still reads it.
        playersList: reach.players_list,
        updatedAt: reach.updatedAt,
      },
    };
  },
};

const planSchema = z.object({
  plans: z.array(
    z.object({
      id: z.enum(["free", "pro"]),
      name: z.string(),
      tagline: z.string(),
      priceMonthly: z.number().int(),
      priceYearly: z.number().int(),
      currency: z.literal("usd"),
      features: z.array(z.object({ label: z.string(), included: z.boolean() })),
    }),
  ),
  checkoutAvailable: z.boolean(),
});

/**
 * `GET /v1/public/plans` — the display catalogue.
 *
 * Display copy and prices only. Stripe price ids and the server's entitlement
 * limits stay out of it: §3 says server entitlements remain authoritative, and
 * a public endpoint that published the limit table would invite a client to
 * enforce it instead.
 */
const publicPlans: RouteDefinition<never, never, z.infer<typeof planSchema>> = {
  method: "GET",
  path: "/v1/public/plans",
  operationId: "getPublicPlans",
  summary: "Display plan catalogue",
  description:
    "Public. Prices, currency, intervals and feature copy, plus whether checkout is available. Server entitlements remain authoritative.",
  kind: "read",
  auth: "public",
  envelope: "resource",
  successStatus: 200,
  dataSchema: planSchema,
  etag: true,
  cacheControl: "public, max-age=300",
  rateLimits: [{ policy: POLICIES.publicRead, source: "address" }],
  async handler() {
    return {
      data: {
        plans: PLAN_LIST.map((plan) => ({
          id: plan.id,
          name: plan.name,
          tagline: plan.tagline,
          priceMonthly: plan.priceMonthly,
          priceYearly: plan.priceYearly,
          currency: plan.currency,
          features: plan.features,
        })),
        checkoutAvailable: billingConfigured,
      },
    };
  },
};

/**
 * §3's request shape. `ratingBand` rather than the legacy column's `rating`,
 * because the contract names it that and the value has always been a band.
 */
const betaSignupBody = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().toLowerCase().max(160).email(),
  platform: z.enum(PLATFORM_CHOICES),
  username: z.string().trim().max(60).optional(),
  ratingBand: z.enum(RATING_CHOICES).optional(),
  goal: z.string().trim().max(400).optional(),
});

const acceptedSchema = z.object({ accepted: z.literal(true) });

/**
 * `POST /v1/public/beta-signups` — the one public command.
 *
 * The response is `{ accepted: true }` and nothing else, on every path. §3
 * requires that it "never confirms whether an email already exists", and the
 * legacy route's `created` flag does exactly that — so the `/v1` body drops it.
 * That non-disclosure is also what makes anonymous idempotency safe here: the
 * stored replay body carries no information about the caller.
 *
 * Two rate-limit policies: one on the address, so a bored person with a loop
 * gets nowhere, and one on the email, so a rotating address cannot be used to
 * repeatedly overwrite one person's entry. Both are shared across instances.
 */
const betaSignups: RouteDefinition<never, z.infer<typeof betaSignupBody>, z.infer<typeof acceptedSchema>> = {
  method: "POST",
  path: "/v1/public/beta-signups",
  operationId: "createBetaSignup",
  summary: "Join the beta testing list",
  description:
    "Public command with distributed address and email abuse controls. Requires an Idempotency-Key. The response never reveals whether the address was already on the list.",
  kind: "command",
  auth: "public",
  envelope: "resource",
  successStatus: 202,
  bodySchema: betaSignupBody,
  dataSchema: acceptedSchema,
  rateLimits: [
    { policy: POLICIES.betaSignupAddress, source: "address" },
    {
      policy: POLICIES.betaSignupEmail,
      // Already normalized to lower case by the schema.
      source: (body) => (body as z.infer<typeof betaSignupBody> | undefined)?.email ?? null,
    },
  ],
  async handler({ body }) {
    await recordBetaSignup({
      name: body.name,
      email: body.email,
      platform: body.platform,
      username: body.username,
      rating: body.ratingBand,
      goal: body.goal,
    });
    return { data: { accepted: true as const } };
  },
};

export const PUBLIC_ROUTES = [publicStats, publicPlans, betaSignups] as const;
