# Tempo Chess

Automatic multi-game chess analysis for chess.com and Lichess. Beyond single-game
review: per-player stats, accurate blunder/mistake capture, a plain-English reason
for every move, personalized puzzles from your own mistakes, and opening
recommendations matched to how you actually play.

## Architecture

| Piece | Tech | Deploys to |
| --- | --- | --- |
| Web app (SPA) | React Router v7 (SPA mode) + Tailwind | **Cloudflare Pages** |
| API + analysis | Hono (TypeScript) | **Google Cloud Run** |
| Engine | native Stockfish (queued) | Cloud Run |
| Data + Auth | Supabase (Postgres + Auth) | — |
| Blobs (raw PGN + analysis JSON) | Google Cloud Storage | — |
| Chess logic (attacks, SEE, motifs) | `chessops` / `chess.js` | server-side |

Auth is token-based across the two origins: Supabase issues a JWT in the browser;
the SPA sends it as a `Bearer` token; the API verifies it.

## Layout

```
/            web app (Cloudflare Pages)  — app/, public/, vite.config.ts
/server      API + analysis (Cloud Run)  — src/, Dockerfile
  src/db/    Drizzle schema + client
  drizzle/   generated SQL migrations
```

## Develop

```bash
npm run dev                      # web (Vite dev server)
npm --prefix server run dev      # api (Hono, hot reload)
```

Copy `.env.example` → `.env` (web) and `server/.env.example` → `server/.env`.

## Database (Drizzle + Supabase Postgres)

```bash
npm --prefix server run db:generate   # generate SQL migration from schema (offline)
npm --prefix server run db:migrate    # apply migrations (needs DATABASE_URL)
```

## Build

```bash
npm run build                    # web → build/client (static, for Pages)
npm --prefix server run build    # api → server/dist
```
