import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { analyzeFens } from "./engine/stockfish.js";
import { cancelImport, createLichessImport, getImport, listImports, recoverPipeline } from "./pipeline/service.js";
import {
  buildPlayerOpeningGraph,
  createOpeningDrill,
  getOpeningExplorer,
  setOpeningRepertoireMove,
} from "./openings/service.js";
import { importOpeningCatalogue } from "./openings/catalogue.js";

const app = new Hono();

// Allow the Cloudflare Pages origin (set WEB_ORIGIN in Cloud Run env).
// Falls back to "*" in local dev so the SPA can talk to the API.
const webOrigin = process.env.WEB_ORIGIN;
app.use(
  "*",
  cors({
    origin: webOrigin ? [webOrigin] : "*",
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  }),
);

app.get("/health", (c) =>
  c.json({ status: "ok", service: "tempo-chess-api", ts: Date.now() }),
);

app.get("/imports", async (c) => c.json({ imports: await listImports() }));

app.get("/imports/:id", async (c) => {
  const item = await getImport(c.req.param("id"));
  return item ? c.json({ import: item }) : c.json({ error: "Import not found" }, 404);
});

app.post("/imports/lichess", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ username: z.string().trim().min(2).max(40), games: z.number().int().min(1).max(500).default(30) }).safeParse(body);
  if (!parsed.success) return c.json({ error: "expected { username: string, games: 1..500 }" }, 400);
  return c.json({ import: await createLichessImport(parsed.data.username, parsed.data.games) }, 202);
});

app.post("/imports/:id/cancel", async (c) => {
  const item = await cancelImport(c.req.param("id"));
  return item ? c.json({ import: item }) : c.json({ error: "Import not found" }, 404);
});

const explorerQuery = z.object({
  username: z.string().trim().min(2).max(40).default("ncarcasc"),
  platform: z.enum(["all", "lichess", "chesscom"]).default("all"),
  speed: z.enum(["all", "bullet", "blitz", "rapid", "classical", "correspondence"]).default("all"),
  color: z.enum(["all", "white", "black"]).default("all"),
  since: z.string().optional(),
  family: z.string().optional(),
  node: z.string().optional(),
});

app.get("/opening-explorer", async (c) => {
  const parsed = explorerQuery.safeParse(c.req.query());
  if (!parsed.success) return c.json({ error: "Invalid opening explorer filters" }, 400);
  try {
    return c.json(await getOpeningExplorer(parsed.data.username, parsed.data));
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 404);
  }
});

app.post("/opening-explorer/rebuild", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ username: z.string().trim().min(2).max(40) }).safeParse(body);
  if (!parsed.success) return c.json({ error: "expected { username: string }" }, 400);
  return c.json(await buildPlayerOpeningGraph(parsed.data.username));
});

app.post("/opening-explorer/catalogue/import", async (c) =>
  c.json(await importOpeningCatalogue()),
);

app.post("/opening-explorer/drills", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({
    username: z.string().trim().min(2).max(40),
    positionKey: z.string().min(12),
  }).safeParse(body);
  if (!parsed.success) return c.json({ error: "expected { username, positionKey }" }, 400);
  try {
    return c.json({ drill: await createOpeningDrill(parsed.data.username, parsed.data.positionKey) }, 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
  }
});

app.post("/opening-explorer/repertoire", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({
    username: z.string().trim().min(2).max(40),
    positionKey: z.string().min(12),
    moveUci: z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/),
    enabled: z.boolean().default(true),
  }).safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "expected { username, positionKey, moveUci, enabled? }" }, 400);
  }
  try {
    const result = await setOpeningRepertoireMove(
      parsed.data.username,
      parsed.data.positionKey,
      parsed.data.moveUci,
      parsed.data.enabled,
    );
    await buildPlayerOpeningGraph(parsed.data.username);
    return c.json({ repertoireMove: result });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
  }
});

// Stockfish analysis: evaluate a list of positions (White's perspective).
app.post("/analyze", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z
    .object({
      fens: z.array(z.string().min(12)).min(1).max(160),
      depth: z.number().int().min(6).max(18).optional(),
    })
    .safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "expected { fens: string[], depth?: number }" }, 400);
  }
  const results = await analyzeFens(parsed.data.fens, parsed.data.depth ?? 12);
  return c.json({ results });
});

// Cloud Run injects PORT (defaults to 8080).
const port = Number(process.env.PORT ?? 8080);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`tempo-chess api listening on :${info.port}`);
});
void recoverPipeline().catch((error) => console.error("pipeline recovery failed", error));

export default app;
