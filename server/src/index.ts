import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { analyzeFens, botMove } from "./engine/stockfish.js";
import {
  cancelImport,
  createLichessImport,
  getImport,
  getLichessCoverage,
  listImports,
  recoverPipeline,
} from "./pipeline/service.js";
import {
  buildPlayerOpeningGraph,
  createOpeningDrill,
  getOpeningExplorer,
  setOpeningRepertoireMove,
} from "./openings/service.js";
import { importOpeningCatalogue } from "./openings/catalogue.js";
import {
  getMistakeDrills,
  getPracticeActivity,
  listLessonProgress,
  listRepertoire,
  recordTrainingResult,
  saveLessonProgress,
  setRepertoireOpening,
} from "./openings/progress.js";
import {
  AccountError,
  currentUser,
  linkAccount,
  listLinkedAccounts,
  requireAccountUsername,
  requireAuth,
  type AuthUser,
} from "./auth.js";
import { getPlayerSummarySource } from "./players/summary.js";
import { getPublicReach } from "./players/reach.js";
import { PLAN_LIST, PLANS } from "./billing/plans.js";
import {
  billingConfigured,
  createCheckoutSession,
  createPortalSession,
  getSubscription,
  handleWebhook,
} from "./billing/service.js";
import { getDailyDrillUsage, getUsageSummary, recordUsage } from "./usage.js";
import { betaSignupSchema, rateLimit, recordBetaSignup } from "./beta.js";

const app = new Hono<{ Variables: { user: AuthUser } }>();

// Allow the Cloudflare Pages origin (set WEB_ORIGIN in Cloud Run env).
// Falls back to "*" in local dev so the SPA can talk to the API.
const webOrigin = process.env.WEB_ORIGIN;
app.use(
  "*",
  cors({
    origin: webOrigin ? [webOrigin] : "*",
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    // Let browsers cache the CORS preflight for a day so cross-origin GETs from the
    // SPA don't pay an extra OPTIONS round-trip on every request.
    maxAge: 86400,
  }),
);

/** Turns the identity helpers' failures into their intended status codes. */
function fail(c: Context, error: unknown) {
  if (error instanceof AccountError) return c.json({ error: error.message }, error.status);
  return c.json({ error: error instanceof Error ? error.message : String(error) }, 404);
}

// --- public ---------------------------------------------------------------

app.get("/health", (c) =>
  c.json({ status: "ok", service: "tempo-chess-api", ts: Date.now() }),
);

/**
 * How many players' games we have analysed. The landing page quotes this, so it
 * has to be reachable without a session. Deliberately not under `/players/*`,
 * which is behind `requireAuth`.
 */
app.get("/stats/reach", async (c) => {
  const reach = await getPublicReach();
  c.header("Cache-Control", "public, max-age=300");
  return c.json(reach);
});

/**
 * The landing page's "join beta testing" form. Public by necessity: the people
 * filling it in do not have accounts yet, which is the point.
 *
 * Rate limited by client address, and the response never distinguishes a new
 * signup from a repeat one to the caller beyond `created` — there is no way to
 * probe this endpoint to find out whether a given address is on the list.
 */
app.post("/beta-signups", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = betaSignupSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "expected { name, email, platform, username?, rating?, goal? }" }, 400);
  }
  const from =
    c.req.header("cf-connecting-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";
  if (!rateLimit(from)) {
    return c.json({ error: "Too many signups from here. Try again later." }, 429);
  }
  try {
    const result = await recordBetaSignup(parsed.data);
    return c.json(result, result.created ? 201 : 200);
  } catch (error) {
    console.error("beta signup failed", error);
    return c.json({ error: "Could not save that. Try again in a moment." }, 500);
  }
});

/** The pricing page is public, so the plan catalogue has to be too. */
app.get("/billing/plans", (c) => c.json({ plans: PLAN_LIST, configured: billingConfigured }));

/**
 * Stripe posts here without a user session; it authenticates with a signature
 * instead. Registered before `requireAuth` so it stays reachable.
 */
app.post("/billing/webhook", async (c) => {
  const raw = await c.req.text();
  const result = await handleWebhook(raw, c.req.header("stripe-signature") ?? null);
  return result.handled ? c.json(result) : c.json(result, 400);
});

// --- everything below needs a signed-in user ------------------------------

app.use("/me/*", requireAuth);
app.use("/billing/checkout", requireAuth);
app.use("/billing/portal", requireAuth);
app.use("/billing/subscription", requireAuth);
app.use("/imports", requireAuth);
app.use("/imports/*", requireAuth);
app.use("/players/*", requireAuth);
app.use("/opening-explorer", requireAuth);
app.use("/opening-explorer/*", requireAuth);
app.use("/repertoire", requireAuth);
app.use("/training/*", requireAuth);
app.use("/lessons/*", requireAuth);
app.use("/analyze", requireAuth);
app.use("/engine/*", requireAuth);

// --- me: identity, linked accounts, hub data ------------------------------

app.get("/me", async (c) => {
  const user = currentUser(c);
  const [accounts, subscription, usage] = await Promise.all([
    listLinkedAccounts(user.id),
    getSubscription(user.id),
    getUsageSummary(user.id),
  ]);
  return c.json({
    user: { id: user.id, email: user.email },
    accounts,
    subscription,
    limits: PLANS[subscription.plan].limits,
    usage,
  });
});

app.post("/me/accounts", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({
    platform: z.enum(["lichess", "chesscom"]).default("lichess"),
    username: z.string().trim().min(2).max(40),
  }).safeParse(body);
  if (!parsed.success) return c.json({ error: "expected { username, platform? }" }, 400);
  try {
    const account = await linkAccount(currentUser(c).id, parsed.data.platform, parsed.data.username);
    return c.json({ account }, 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
  }
});

/**
 * The hub's data, rebuilt from our own database. Always answers, even when
 * Lichess is rate-limiting; the client overlays live profile data on top.
 */
app.get("/me/summary", async (c) => {
  const user = currentUser(c);
  try {
    const username = await requireAccountUsername(user.id, c.req.query("username"));
    const source = await getPlayerSummarySource(user.id, username);
    c.header("Cache-Control", "private, max-age=15");
    return c.json(source);
  } catch (error) {
    return fail(c, error);
  }
});

// --- billing --------------------------------------------------------------

app.get("/billing/subscription", async (c) =>
  c.json(await getSubscription(currentUser(c).id)),
);

app.post("/billing/checkout", async (c) => {
  const user = currentUser(c);
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({
    plan: z.enum(["free", "pro"]).default("pro"),
    interval: z.enum(["monthly", "yearly"]).default("monthly"),
    successUrl: z.string().url(),
    cancelUrl: z.string().url(),
  }).safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "expected { plan?, interval?, successUrl, cancelUrl }" }, 400);
  }
  return c.json(await createCheckoutSession({ userId: user.id, email: user.email, ...parsed.data }));
});

app.post("/billing/portal", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ returnUrl: z.string().url() }).safeParse(body);
  if (!parsed.success) return c.json({ error: "expected { returnUrl }" }, 400);
  return c.json(await createPortalSession(currentUser(c).id, parsed.data.returnUrl));
});

// --- imports --------------------------------------------------------------

app.get("/imports", async (c) => c.json({ imports: await listImports(currentUser(c).id) }));

app.get("/imports/:id", async (c) => {
  const item = await getImport(c.req.param("id"), currentUser(c).id);
  return item ? c.json({ import: item }) : c.json({ error: "Import not found" }, 404);
});

app.post("/imports/lichess", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({
    username: z.string().trim().min(2).max(40).optional(),
    games: z.union([z.literal("all"), z.number().int().min(1).max(500)]).default("all"),
  }).safeParse(body);
  if (!parsed.success) return c.json({ error: "expected { username?, games?: \"all\" | 1..500 }" }, 400);
  try {
    const username = await requireAccountUsername(currentUser(c).id, parsed.data.username);
    const user = currentUser(c);
    const coverage = await getLichessCoverage(username, user.id);
    const planLimit = PLANS[user.plan].limits.analysedGames;
    const importLimit = Math.min(coverage.importLimit, planLimit ?? coverage.importLimit);
    const games = parsed.data.games === "all"
      ? Math.min(coverage.availableGames, importLimit)
      : Math.min(parsed.data.games, importLimit);
    return c.json({
      import: await createLichessImport(username, games, user.id),
      coverage: { ...coverage, importLimit },
    }, 202);
  } catch (error) {
    return fail(c, error);
  }
});

app.get("/players/:username/coverage", async (c) => {
  try {
    const username = await requireAccountUsername(currentUser(c).id, c.req.param("username"));
    const user = currentUser(c);
    const coverage = await getLichessCoverage(username, user.id);
    const planLimit = PLANS[user.plan].limits.analysedGames;
    return c.json({ ...coverage, importLimit: Math.min(coverage.importLimit, planLimit ?? coverage.importLimit) });
  } catch (error) {
    return fail(c, error);
  }
});

app.post("/imports/:id/cancel", async (c) => {
  const item = await cancelImport(c.req.param("id"), currentUser(c).id);
  return item ? c.json({ import: item }) : c.json({ error: "Import not found" }, 404);
});

// --- opening explorer -----------------------------------------------------

const explorerQuery = z.object({
  username: z.string().trim().min(2).max(40).optional(),
  platform: z.enum(["all", "lichess", "chesscom"]).default("all"),
  speed: z.enum(["all", "bullet", "blitz", "rapid", "classical", "correspondence"]).default("all"),
  color: z.enum(["all", "white", "black"]).default("all"),
  since: z.string().optional(),
  family: z.string().optional(),
  node: z.string().optional(),
  from: z.string().optional(),
  move: z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/).optional(),
  // graph=0 skips the full position graph (used by lazy per-position lookups).
  graph: z.enum(["0", "1"]).optional(),
});

app.get("/opening-explorer", async (c) => {
  const parsed = explorerQuery.safeParse(c.req.query());
  if (!parsed.success) return c.json({ error: "Invalid opening explorer filters" }, 400);
  try {
    const username = await requireAccountUsername(currentUser(c).id, parsed.data.username);
    const data = await getOpeningExplorer(username, parsed.data, currentUser(c).id);
    // Per-user data, but safe to reuse briefly within a browsing session; this also
    // covers the explorer's direct (non-loader) lazy position lookups.
    c.header("Cache-Control", "private, max-age=30");
    return c.json(data);
  } catch (error) {
    return fail(c, error);
  }
});

app.post("/opening-explorer/rebuild", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ username: z.string().trim().min(2).max(40).optional() }).safeParse(body ?? {});
  if (!parsed.success) return c.json({ error: "expected { username? }" }, 400);
  try {
    const username = await requireAccountUsername(currentUser(c).id, parsed.data.username);
    return c.json(await buildPlayerOpeningGraph(username, currentUser(c).id));
  } catch (error) {
    return fail(c, error);
  }
});

app.post("/opening-explorer/catalogue/import", async (c) =>
  c.json(await importOpeningCatalogue()),
);

app.post("/opening-explorer/drills", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({
    username: z.string().trim().min(2).max(40).optional(),
    positionKey: z.string().min(12),
  }).safeParse(body);
  if (!parsed.success) return c.json({ error: "expected { positionKey, username? }" }, 400);
  try {
    const username = await requireAccountUsername(currentUser(c).id, parsed.data.username);
    return c.json({ drill: await createOpeningDrill(username, parsed.data.positionKey, currentUser(c).id) }, 201);
  } catch (error) {
    return fail(c, error);
  }
});

app.post("/opening-explorer/repertoire", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({
    username: z.string().trim().min(2).max(40).optional(),
    positionKey: z.string().min(12),
    moveUci: z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/),
    enabled: z.boolean().default(true),
  }).safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "expected { positionKey, moveUci, enabled?, username? }" }, 400);
  }
  try {
    const username = await requireAccountUsername(currentUser(c).id, parsed.data.username);
    const result = await setOpeningRepertoireMove(
      username,
      parsed.data.positionKey,
      parsed.data.moveUci,
      parsed.data.enabled,
      currentUser(c).id,
    );
    await buildPlayerOpeningGraph(username, currentUser(c).id);
    return c.json({ repertoireMove: result });
  } catch (error) {
    return fail(c, error);
  }
});

// --- Repertoire selection + practice tracking (the account page) -----------

app.get("/repertoire", async (c) => {
  try {
    const username = await requireAccountUsername(currentUser(c).id, c.req.query("username"));
    return c.json(await listRepertoire(currentUser(c).id));
  } catch (error) {
    return fail(c, error);
  }
});

app.post("/repertoire", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({
    username: z.string().trim().min(2).max(40).optional(),
    color: z.enum(["white", "black"]),
    family: z.string().trim().min(1).max(80),
    enabled: z.boolean().default(true),
  }).safeParse(body);
  if (!parsed.success) return c.json({ error: "expected { color, family, enabled?, username? }" }, 400);
  try {
    const username = await requireAccountUsername(currentUser(c).id, parsed.data.username);
    return c.json(await setRepertoireOpening(currentUser(c).id, parsed.data.color, parsed.data.family, parsed.data.enabled));
  } catch (error) {
    return fail(c, error);
  }
});

app.post("/training/results", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({
    username: z.string().trim().min(2).max(40).optional(),
    color: z.enum(["white", "black"]),
    family: z.string().trim().min(1).max(80).nullable().default(null),
    lineUci: z.string().min(4).max(400),
    correct: z.number().int().min(0).max(64),
    total: z.number().int().min(0).max(64),
    reveals: z.number().int().min(0).max(64).default(0),
  }).safeParse(body);
  if (!parsed.success) return c.json({ error: "expected { color, lineUci, correct, total, reveals? }" }, 400);
  try {
    const d = parsed.data;
    const user = currentUser(c);
    await requireAccountUsername(user.id, d.username);
    const dailyLimit = PLANS[user.plan].limits.dailyDrills;
    if (dailyLimit != null && await getDailyDrillUsage(user.id) >= dailyLimit) {
      return c.json({ error: `Daily drill limit reached (${dailyLimit})` }, 429);
    }
    return c.json(await recordTrainingResult(user.id, {
      color: d.color, family: d.family, lineUci: d.lineUci, correct: d.correct, total: d.total, reveals: d.reveals,
    }), 201);
  } catch (error) {
    return fail(c, error);
  }
});

app.get("/training/activity", async (c) => {
  try {
    const username = await requireAccountUsername(currentUser(c).id, c.req.query("username"));
    return c.json(await getPracticeActivity(currentUser(c).id));
  } catch (error) {
    return fail(c, error);
  }
});

app.get("/training/mistakes", async (c) => {
  const color = c.req.query("color") === "black" ? "black" : "white";
  try {
    const username = await requireAccountUsername(currentUser(c).id, c.req.query("username"));
    // Free accounts get a capped drill queue; Pro gets the whole backlog.
    const limit = PLANS[currentUser(c).plan].limits.dailyDrills ?? 50;
    return c.json({ drills: await getMistakeDrills(currentUser(c).id, color, Math.min(limit, 50)) });
  } catch (error) {
    return fail(c, error);
  }
});

app.get("/lessons/progress", async (c) => {
  try {
    const username = await requireAccountUsername(currentUser(c).id, c.req.query("username"));
    return c.json({ progress: await listLessonProgress(currentUser(c).id) });
  } catch (error) {
    return fail(c, error);
  }
});

app.post("/lessons/progress", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({
    username: z.string().trim().min(2).max(40).optional(),
    slug: z.string().trim().min(1).max(80),
    completedSteps: z.number().int().min(0).max(200),
    totalSteps: z.number().int().min(0).max(200),
    bestScore: z.number().int().min(0).max(200),
    completed: z.boolean().default(false),
  }).safeParse(body);
  if (!parsed.success) return c.json({ error: "expected { slug, completedSteps, totalSteps, bestScore, completed? }" }, 400);
  try {
    const username = await requireAccountUsername(currentUser(c).id, parsed.data.username);
    return c.json(await saveLessonProgress(currentUser(c).id, parsed.data));
  } catch (error) {
    return fail(c, error);
  }
});

// --- engine ---------------------------------------------------------------

// Stockfish analysis: evaluate a list of positions (White's perspective).
app.post("/analyze", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z
    .object({
      fens: z.array(z.string().min(12)).min(1).max(160),
      depth: z.number().int().min(6).max(18).optional(),
      multipv: z.number().int().min(1).max(5).optional(),
    })
    .safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "expected { fens: string[], depth?: number, multipv?: number }" }, 400);
  }
  const results = await analyzeFens(parsed.data.fens, parsed.data.depth ?? 12, parsed.data.multipv ?? 1);
  await recordUsage({
    userId: currentUser(c).id,
    kind: "engine_positions",
    units: parsed.data.fens.length,
    metadata: { depth: parsed.data.depth ?? 12, multipv: parsed.data.multipv ?? 1 },
  });
  return c.json({ results });
});

// The bot's reply for "play it out from here", at a capped strength.
app.post("/engine/play", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z
    .object({
      fen: z.string().min(12),
      elo: z.number().int().min(600).max(3200).default(1500),
      movetimeMs: z.number().int().min(50).max(2000).optional(),
    })
    .safeParse(body);
  if (!parsed.success) return c.json({ error: "expected { fen, elo?, movetimeMs? }" }, 400);
  try {
    const move = await botMove(parsed.data.fen, parsed.data.elo, parsed.data.movetimeMs ?? 350);
    await recordUsage({ userId: currentUser(c).id, kind: "engine_play", units: 1 });
    return c.json({ move: move ?? null });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

// Cloud Run injects PORT (defaults to 8080).
// Prefer a dedicated API_PORT in dev so a harness/launcher that injects PORT (for the
// web server) can't steal this one. Production (Cloud Run) still uses PORT.
const port = Number(process.env.API_PORT ?? process.env.PORT ?? 8080);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`tempo-chess api listening on :${info.port}`);
});
void recoverPipeline().catch((error) => console.error("pipeline recovery failed", error));

export default app;
