import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";

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

// Cloud Run injects PORT (defaults to 8080).
const port = Number(process.env.PORT ?? 8080);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`tempo-chess api listening on :${info.port}`);
});

export default app;
