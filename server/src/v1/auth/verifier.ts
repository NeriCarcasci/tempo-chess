import { createHash } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { LocalJwtVerifier, classifyHeader, type LocalResult } from "./jwt.js";

/**
 * The one place a bearer token becomes an actor.
 *
 * Local JWKS verification first, Supabase's `getUser` as a controlled fallback,
 * per plans/v1-platform-spec.md §6.1. "Controlled" means three things: the
 * fallback is only reachable for token shapes that could legitimately need it,
 * it is the only path that costs a network round trip, and a route may demand
 * it when the answer must reflect revocation rather than signature.
 *
 * The verified result is cached by *token digest*. The prototype cached by raw
 * token (audit §10), which put a live credential in a long-lived process map
 * where a heap dump or an accidental log of the cache would expose it. A
 * SHA-256 of the token is just as good a cache key and is not a credential.
 */

export type AuthMode = "jwks" | "fallback";

export interface VerifiedToken {
  actorId: string;
  email: string | null;
  mode: AuthMode;
  /** Token expiry as epoch seconds, when the token carried one. */
  expiresAt: number | null;
}

/** Why verification failed. Deliberately coarse: a caller learns "no". */
export type VerificationFailure = "absent" | "rejected" | "unavailable";

export type VerificationResult =
  | { ok: true; token: VerifiedToken }
  | { ok: false; reason: VerificationFailure };

/** Never let a cache entry outlive the token it describes. */
const MAX_CACHE_TTL_MS = 60_000;
const CACHE_LIMIT = 1_024;

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

interface CacheEntry {
  token: VerifiedToken;
  expiresAtMs: number;
}

export interface TokenVerifierOptions {
  supabaseUrl: string;
  supabaseAnonKey: string;
  /** Test seam: a static JWKS instead of the project's published one. */
  keySet?: ConstructorParameters<typeof LocalJwtVerifier>[0]["keySet"];
  /** Test seam: stand in for `supabase.auth.getUser`. */
  getUser?: (token: string) => Promise<{ id: string; email: string | null } | null>;
}

export class TokenVerifier {
  private readonly local: LocalJwtVerifier;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly supabase: SupabaseClient | null;
  private readonly getUserOverride: TokenVerifierOptions["getUser"];

  constructor(options: TokenVerifierOptions) {
    this.local = new LocalJwtVerifier({
      supabaseUrl: options.supabaseUrl,
      keySet: options.keySet,
    });
    this.getUserOverride = options.getUser;
    this.supabase = options.getUser
      ? null
      : createClient(options.supabaseUrl, options.supabaseAnonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        });
  }

  /**
   * @param revocationSensitive forces the fallback, so the answer reflects a
   *   session that was signed out rather than a signature that is still valid.
   */
  async verify(
    token: string | null,
    options: { revocationSensitive?: boolean } = {},
  ): Promise<VerificationResult> {
    if (!token) return { ok: false, reason: "absent" };

    const key = digest(token);
    if (!options.revocationSensitive) {
      const cached = this.cache.get(key);
      if (cached && cached.expiresAtMs > Date.now()) return { ok: true, token: cached.token };
    }

    if (options.revocationSensitive) {
      // Skip the local path entirely: its whole weakness is that it cannot see
      // a revoked session, which is precisely what this caller is asking about.
      const fallback = await this.viaGetUser(token);
      if (fallback.ok) this.remember(key, fallback.token);
      return fallback;
    }

    const header = classifyHeader(token);
    if (header.local) {
      const result = await this.local.verify(token);
      if (result.ok) {
        const verified = toVerified(result, "jwks");
        this.remember(key, verified);
        return { ok: true, token: verified };
      }
      // An outright rejection is final. Only "we could not check" is worth a
      // network call — otherwise a forged header buys an attacker a round trip
      // against Supabase on every request.
      if (result.rejection === "invalid" || result.rejection === "unsupported") {
        return { ok: false, reason: "rejected" };
      }
    } else if (header.algorithm !== "HS256") {
      // Not a shape we verify locally and not the legacy symmetric shape the
      // fallback exists for: `alg: none`, an unknown algorithm, or not a JWT.
      return { ok: false, reason: "rejected" };
    }

    const fallback = await this.viaGetUser(token);
    if (fallback.ok) this.remember(key, fallback.token);
    return fallback;
  }

  private async viaGetUser(token: string): Promise<VerificationResult> {
    try {
      if (this.getUserOverride) {
        const user = await this.getUserOverride(token);
        return user
          ? { ok: true, token: { actorId: user.id, email: user.email, mode: "fallback", expiresAt: null } }
          : { ok: false, reason: "rejected" };
      }
      const { data, error } = await this.supabase!.auth.getUser(token);
      if (error || !data.user) return { ok: false, reason: "rejected" };
      return {
        ok: true,
        token: {
          actorId: data.user.id,
          email: data.user.email ?? null,
          mode: "fallback",
          expiresAt: null,
        },
      };
    } catch {
      // Supabase being unreachable is not the same as the token being bad, and
      // the caller logs it differently. Neither one lets the request through.
      return { ok: false, reason: "unavailable" };
    }
  }

  private remember(key: string, token: VerifiedToken): void {
    const now = Date.now();
    const tokenLifetimeMs = token.expiresAt ? token.expiresAt * 1000 - now : MAX_CACHE_TTL_MS;
    const ttl = Math.min(MAX_CACHE_TTL_MS, tokenLifetimeMs);
    if (ttl <= 0) return;
    if (this.cache.size >= CACHE_LIMIT) {
      for (const [existing, entry] of this.cache) {
        if (entry.expiresAtMs <= now) this.cache.delete(existing);
      }
      // Still full after sweeping expired entries: drop the oldest insertion.
      if (this.cache.size >= CACHE_LIMIT) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
    }
    this.cache.set(key, { token, expiresAtMs: now + ttl });
  }

  /** Drop a token's cached verification, e.g. after an explicit sign-out. */
  forget(token: string): void {
    this.cache.delete(digest(token));
  }
}

function toVerified(result: Extract<LocalResult, { ok: true }>, mode: AuthMode): VerifiedToken {
  const payload = result.payload;
  return {
    actorId: payload.sub as string,
    email: typeof payload.email === "string" ? payload.email : null,
    mode,
    expiresAt: typeof payload.exp === "number" ? payload.exp : null,
  };
}

/** Extract a bearer token from an Authorization header value. */
export function bearerToken(header: string | null | undefined): string | null {
  const match = /^Bearer\s+(.+)$/i.exec((header ?? "").trim());
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : null;
}

let shared: TokenVerifier | null = null;

/** The process-wide verifier, built from the environment on first use. */
export function tokenVerifier(): TokenVerifier {
  if (shared) return shared;
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY are required");
  }
  shared = new TokenVerifier({ supabaseUrl: url, supabaseAnonKey: anonKey });
  return shared;
}

/** Test seam: install a verifier built over a static key set. */
export function setTokenVerifierForTest(verifier: TokenVerifier | null): void {
  shared = verifier;
}
