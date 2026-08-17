import { createLocalJWKSet, createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from "jose";
import type { JSONWebKeySet, JWTPayload, KeyObject } from "jose";

/**
 * Local Supabase access-token verification, per plans/v1-platform-spec.md §6.1.
 *
 * The prototype verified every request by asking Supabase's auth server
 * (audit §10: "auth verification adds a Supabase network request"). That is a
 * network round trip on the hot path of every authenticated call, and it fails
 * when Supabase is slow for reasons that have nothing to do with us.
 *
 * Supabase publishes an asymmetric JWKS, so the ordinary case is verifiable
 * locally: signature against a cached public key, then issuer, audience, and
 * expiry. What local verification *cannot* see is a session revoked before its
 * token expired — that is what the controlled `getUser` fallback in
 * `verifier.ts` is for, and why a route can demand it.
 *
 * The algorithm allowlist is the security boundary here. A token presenting
 * `alg: none`, or `HS256` with a `kid` that names an asymmetric key, is
 * rejected outright rather than referred to the fallback: an attacker must not
 * be able to spend our network budget by sending garbage.
 */

/** The only algorithms a locally verified token may use. */
export const LOCAL_ALGORITHMS = ["ES256", "RS256"] as const;

/** Supabase issues access tokens with this audience. */
export const EXPECTED_AUDIENCE = "authenticated";

/** Clock skew we tolerate on `exp`/`nbf`. Small on purpose. */
export const CLOCK_TOLERANCE_SECONDS = 5;

/** How long a fetched key set is trusted before a background refresh. */
export const JWKS_CACHE_MS = 10 * 60_000;

/** The shortest gap between two refetches provoked by an unknown `kid`. */
export const JWKS_COOLDOWN_MS = 30_000;

export type LocalAlgorithm = (typeof LOCAL_ALGORITHMS)[number];

export function issuerFor(supabaseUrl: string): string {
  return `${supabaseUrl.replace(/\/+$/, "")}/auth/v1`;
}

export function jwksUrlFor(supabaseUrl: string): URL {
  return new URL(`${issuerFor(supabaseUrl)}/.well-known/jwks.json`);
}

/** Why a token could not be verified locally. Structure only; never token text. */
export type LocalRejection =
  /** Malformed, or an algorithm we will never accept. Do not fall back. */
  | "unsupported"
  /** Well-formed and asymmetric, but this key set does not know the `kid`. */
  | "unknown_key"
  /** Signature, issuer, audience, or expiry failed. Do not fall back. */
  | "invalid"
  /** No key set is available at all. Fall back if the caller can. */
  | "unavailable";

export interface LocalVerified {
  ok: true;
  payload: JWTPayload;
}

export interface LocalFailed {
  ok: false;
  rejection: LocalRejection;
}

export type LocalResult = LocalVerified | LocalFailed;

type KeyLookup = Parameters<typeof jwtVerify>[1];

/**
 * Classify the token header before spending a signature verification on it.
 *
 * `alg: none` is the textbook forgery and has no legitimate caller. An
 * asymmetric `kid` paired with a symmetric `alg` is the confusion attack that
 * turns a public key into a shared secret; we hold no HMAC secret at all, so
 * there is nothing for it to confuse, but it is still refused rather than
 * quietly passed to the network fallback.
 */
export function classifyHeader(token: string): {
  algorithm: string | null;
  kid: string | null;
  local: boolean;
} {
  try {
    const header = decodeProtectedHeader(token);
    const algorithm = typeof header.alg === "string" ? header.alg : null;
    const kid = typeof header.kid === "string" ? header.kid : null;
    return {
      algorithm,
      kid,
      local: algorithm !== null && (LOCAL_ALGORITHMS as readonly string[]).includes(algorithm),
    };
  } catch {
    return { algorithm: null, kid: null, local: false };
  }
}

export interface JwksVerifierOptions {
  supabaseUrl: string;
  /** Overridden by tests with a static key set; production fetches the URL. */
  keySet?: JSONWebKeySet | KeyObject | Uint8Array;
  fetchTimeoutMs?: number;
}

/**
 * A verifier over one project's key set.
 *
 * `jose`'s remote key set already handles caching, cooldown, and rotation. That
 * is deliberate reuse: a hand-rolled JWKS cache is exactly the kind of security
 * code that looks finished and is not.
 */
export class LocalJwtVerifier {
  private readonly issuer: string;
  private readonly lookup: KeyLookup;
  /** True while the remote key set has never successfully loaded. */
  private cold = true;

  constructor(options: JwksVerifierOptions) {
    this.issuer = issuerFor(options.supabaseUrl);
    if (options.keySet && "keys" in (options.keySet as JSONWebKeySet)) {
      this.lookup = createLocalJWKSet(options.keySet as JSONWebKeySet);
      this.cold = false;
    } else if (options.keySet) {
      this.lookup = options.keySet as KeyLookup;
      this.cold = false;
    } else {
      this.lookup = createRemoteJWKSet(jwksUrlFor(options.supabaseUrl), {
        cacheMaxAge: JWKS_CACHE_MS,
        cooldownDuration: JWKS_COOLDOWN_MS,
        timeoutDuration: options.fetchTimeoutMs ?? 3_000,
      });
    }
  }

  async verify(token: string): Promise<LocalResult> {
    const header = classifyHeader(token);
    if (!header.local) return { ok: false, rejection: "unsupported" };
    try {
      const { payload } = await jwtVerify(token, this.lookup, {
        issuer: this.issuer,
        audience: EXPECTED_AUDIENCE,
        algorithms: [...LOCAL_ALGORITHMS],
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
      });
      this.cold = false;
      // Supabase puts the user id in `sub`. A token without one is not an
      // access token whatever else it verified against.
      if (typeof payload.sub !== "string" || payload.sub.length === 0) {
        return { ok: false, rejection: "invalid" };
      }
      return { ok: true, payload };
    } catch (error) {
      return { ok: false, rejection: this.classifyFailure(error) };
    }
  }

  /**
   * Only two outcomes may reach the network fallback: a key we have not seen,
   * and a key set we could not load. Everything else is a token that failed a
   * check it should have passed, and retrying it against Supabase would just be
   * a slower "no".
   */
  private classifyFailure(error: unknown): LocalRejection {
    const code = (error as { code?: unknown })?.code;
    if (code === "ERR_JWKS_NO_MATCHING_KEY" || code === "ERR_JWKS_MULTIPLE_MATCHING_KEYS") {
      return "unknown_key";
    }
    if (
      code === "ERR_JWKS_TIMEOUT" ||
      code === "ERR_JWKS_INVALID" ||
      (this.cold && code === "ERR_JOSE_GENERIC")
    ) {
      return "unavailable";
    }
    return "invalid";
  }
}
