/**
 * The CORS contract assertions, run in process against the real app.
 *
 * These are the deterministic half of the CORS contract; the rehearsal runs the
 * same predicates over HTTP against a live local API. Both are required: an
 * in-process check cannot prove a real socket sets the header, and a live check
 * cannot prove the startup rejection without killing the process.
 *
 * The original eight were about *which origin* is answered. The three added
 * below are about *which headers* cross the boundary once an origin is allowed,
 * which turned out to matter just as much: `/v1` requires an `Idempotency-Key`
 * on every command, and a preflight that does not grant it stops the request in
 * the browser, before any of the eight above get a chance to be right.
 */

import type { AssertionBody } from "./security/assertions.js";
import { ALLOWED_ORIGINS } from "./security/contract.js";
import { CorsConfigError, resolveAllowedOrigins } from "./cors.js";
import { SYNTHETIC_POOLED_URL } from "./security/fixtures/synthetic-credentials.js";

const DISALLOWED_ORIGIN = "https://evil.example";

/**
 * Synthetic runtime configuration. The app validates its database configuration
 * at import time, so the CORS tests must present a valid one; nothing here ever
 * opens a connection.
 */
function synthesiseEnv(): void {
  process.env.DATABASE_URL ??= SYNTHETIC_POOLED_URL;
  process.env.DATABASE_ROLE ??= "forma_api";
  process.env.SUPABASE_URL ??= "http://127.0.0.1:1/synthetic";
  process.env.SUPABASE_ANON_KEY ??= "sb_publishable_synthetic_fixture_key";
}

type App = { request: (input: string, init?: RequestInit) => Promise<Response> };

let cached: Promise<App> | undefined;

/** The real app, imported once. Importing it must not bind a port. */
export function loadApp(): Promise<App> {
  if (!cached) {
    synthesiseEnv();
    cached = import("./index.js").then((module) => module.default as unknown as App);
  }
  return cached;
}

function requireNoAcao(response: Response, context: string): void {
  const acao = response.headers.get("Access-Control-Allow-Origin");
  if (acao !== null) {
    throw new Error(`${context} returned Access-Control-Allow-Origin: ${acao}`);
  }
}

function allowedOriginBody(origin: string): AssertionBody {
  return async () => {
    const app = await loadApp();
    const response = await app.request("/health", { headers: { Origin: origin } });
    const acao = response.headers.get("Access-Control-Allow-Origin");
    if (acao === "*") throw new Error("response used a wildcard Access-Control-Allow-Origin");
    if (acao !== origin) throw new Error(`Access-Control-Allow-Origin is ${acao}, expected ${origin}`);
    return `${origin} echoed exactly; no wildcard`;
  };
}

const varyBody: AssertionBody = async () => {
  const app = await loadApp();
  const response = await app.request("/health", { headers: { Origin: ALLOWED_ORIGINS[0] } });
  // `getSetCookie`-style multi-value headers are joined by the Headers API, so
  // counting occurrences in the joined value catches a duplicated append.
  const vary = response.headers.get("Vary") ?? "";
  const occurrences = vary
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value === "origin").length;
  if (occurrences !== 1) throw new Error(`Vary contains Origin ${occurrences} times: "${vary}"`);
  return "Vary contains Origin exactly once";
};

const disallowedPreflightBody: AssertionBody = async () => {
  const app = await loadApp();
  const response = await app.request("/health", {
    method: "OPTIONS",
    headers: {
      Origin: DISALLOWED_ORIGIN,
      "Access-Control-Request-Method": "GET",
    },
  });
  if (response.status !== 403) {
    throw new Error(`disallowed preflight returned ${response.status}, expected 403`);
  }
  requireNoAcao(response, "disallowed preflight");
  return "disallowed preflight rejected with 403 and no ACAO";
};

const disallowedActualBody: AssertionBody = async () => {
  const app = await loadApp();
  const response = await app.request("/health", { headers: { Origin: DISALLOWED_ORIGIN } });
  requireNoAcao(response, "disallowed actual request");
  return `disallowed origin got HTTP ${response.status} and no ACAO`;
};

const absentOriginBody: AssertionBody = async () => {
  const app = await loadApp();
  const response = await app.request("/health");
  if (response.status !== 200) {
    throw new Error(`request without Origin returned ${response.status}, expected 200`);
  }
  const body = (await response.json()) as { status?: string };
  if (body.status !== "ok") throw new Error("request without Origin did not return a usable body");
  requireNoAcao(response, "request without Origin");
  return "request without Origin remains usable and receives no ACAO";
};

const wildcardFallbackBody: AssertionBody = async () => {
  const rejected: string[] = [];
  const invalidSets = [
    "*",
    "",
    "  ",
    DISALLOWED_ORIGIN,
    ALLOWED_ORIGINS.slice(0, 2).join(","),
    [...ALLOWED_ORIGINS, DISALLOWED_ORIGIN].join(","),
    `https://formachess.com,*`,
  ];
  for (const value of invalidSets) {
    try {
      resolveAllowedOrigins({ WEB_ORIGINS: value }, true);
    } catch (error) {
      if (!(error instanceof CorsConfigError)) throw error;
      rejected.push(JSON.stringify(value));
      continue;
    }
    throw new Error(`deployed configuration WEB_ORIGINS=${JSON.stringify(value)} was accepted`);
  }
  return `deployed wildcard, empty, arbitrary-only, partial, and approved-plus-extra allowlists rejected: ${rejected.length} cases`;
};

/** Keyed by the manifest's `target` so IDs and predicates cannot drift apart. */
/**
 * The preflight has to grant the headers the kernel requires.
 *
 * `Idempotency-Key` is mandatory on every /v1 command and is not on the CORS
 * safelist, so a preflight that does not name it makes every command from the
 * browser fail before it reaches a handler — invisibly, because the request is
 * never sent. The conditional headers are the same case.
 */
const preflightHeadersBody: AssertionBody = async () => {
  const app = await loadApp();
  const response = await app.request("/v1/goals", {
    method: "OPTIONS",
    headers: {
      Origin: ALLOWED_ORIGINS[0],
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization, content-type, idempotency-key",
    },
  });
  if (response.status !== 204) {
    throw new Error(`allowed preflight returned ${response.status}, expected 204`);
  }
  const granted = (response.headers.get("Access-Control-Allow-Headers") ?? "")
    .split(",")
    .map((header) => header.trim().toLowerCase());
  for (const required of ["authorization", "content-type", "idempotency-key", "if-match", "if-none-match"]) {
    if (!granted.includes(required)) {
      throw new Error(`preflight did not grant ${required}; granted "${granted.join(", ")}"`);
    }
  }
  return "preflight grants every header the kernel requires";
};

/**
 * A header the browser cannot read is a header the client does not have.
 *
 * Only six response headers reach cross-origin script by default. `Retry-After`
 * carries the number a rate-limit notice shows and `ETag` is what a later
 * `If-Match` quotes, so both have to be exposed explicitly or the client
 * degrades to guessing while appearing to work.
 */
const exposedHeadersBody: AssertionBody = async () => {
  const app = await loadApp();
  const response = await app.request("/health", { headers: { Origin: ALLOWED_ORIGINS[0] } });
  const exposed = (response.headers.get("Access-Control-Expose-Headers") ?? "")
    .split(",")
    .map((header) => header.trim().toLowerCase());
  for (const required of ["etag", "retry-after"]) {
    if (!exposed.includes(required)) {
      throw new Error(`${required} is not exposed; exposed "${exposed.join(", ")}"`);
    }
  }
  return "ETag and Retry-After are readable cross-origin";
};

/** A refused origin gets no exposure list either. */
const disallowedExposeBody: AssertionBody = async () => {
  const app = await loadApp();
  const response = await app.request("/health", { headers: { Origin: DISALLOWED_ORIGIN } });
  const exposed = response.headers.get("Access-Control-Expose-Headers");
  if (exposed !== null) {
    throw new Error(`disallowed origin was handed Access-Control-Expose-Headers: ${exposed}`);
  }
  return "disallowed origin got no exposure list";
};

export function corsBodies(): Map<string, AssertionBody> {
  return new Map<string, AssertionBody>([
    [ALLOWED_ORIGINS[0], allowedOriginBody(ALLOWED_ORIGINS[0])],
    [ALLOWED_ORIGINS[1], allowedOriginBody(ALLOWED_ORIGINS[1])],
    [ALLOWED_ORIGINS[2], allowedOriginBody(ALLOWED_ORIGINS[2])],
    ["Vary header", varyBody],
    ["Vary", varyBody],
    ["disallowed preflight", disallowedPreflightBody],
    ["disallowed actual request", disallowedActualBody],
    ["disallowed actual", disallowedActualBody],
    ["absent Origin", absentOriginBody],
    ["deployed wildcard fallback", wildcardFallbackBody],
    ["wildcard fallback", wildcardFallbackBody],
    ["preflight headers", preflightHeadersBody],
    ["exposed headers", exposedHeadersBody],
    ["disallowed expose", disallowedExposeBody],
  ]);
}
