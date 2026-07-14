import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { analyzeFens } from "./engine/stockfish.js";

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

export default app;
