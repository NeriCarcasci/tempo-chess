import { createLocalJWKSet, createRemoteJWKSet, jwtVerify } from "jose";
import type { JSONWebKeySet } from "jose";
import { isDeployed } from "../../security/config.js";

/**
 * Who is allowed to call `/internal/v1`.
 *
 * plans/v1-api-contract.md §15: private ingress, Google OIDC audience, and a
 * service-account allowlist. Two of those three are the platform's job — Cloud
 * Run's ingress setting and its IAM invoker binding. This file is the third,
 * and it exists because "the platform will stop the wrong caller" is a claim
 * that stops being true the first time someone opens ingress to debug
 * something.
 *
 * So the token is verified here as well: Google's signature, our audience, our
 * issuer, and the exact service-account address the token was minted for. A
 * worker service account cannot call an ops endpoint even though both are
 * legitimate internal callers, because the allowlists are separate.
 *
 * Nothing here trusts a header. The service account comes from the verified
 * token's `email` claim, not from anything the caller wrote.
 */

export const GOOGLE_ISSUER = "https://accounts.google.com";
export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
export const OIDC_ALGORITHMS = ["RS256", "ES256"] as const;
export const CLOCK_TOLERANCE_SECONDS = 5;

/**
 * Which allowlist a route requires. `ops` and `worker` are separate on purpose:
 * a worker service account cannot drive the dispatcher even though both are
 * legitimate internal callers. `any` accepts either, and is only for readiness,
 * which every internal deployment has to be able to probe.
 */
export type ServiceRole = "ops" | "worker" | "any";

export interface ServiceCaller {
  serviceAccount: string;
  /** The allowlist the caller satisfied, not a claim it made about itself. */
  role: ServiceRole;
}

export type ServiceRejection = "absent" | "rejected" | "not_allowed" | "unavailable" | "unconfigured";

export type ServiceVerification =
  | { ok: true; caller: ServiceCaller }
  | { ok: false; reason: ServiceRejection };

export interface InternalIngressConfig {
  audience: string;
  ops: readonly string[];
  workers: readonly string[];
  issuer: string;
  /** Test seam: a static key set instead of Google's published one. */
  keySet?: JSONWebKeySet;
}

export interface InternalConfigFinding {
  code: string;
  message: string;
}

function list(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/**
 * Every blocking reason this configuration must not serve `/internal/v1`.
 *
 * An empty allowlist is a finding rather than a default-deny, even though it
 * denies: a process that starts with no allowlist would answer nothing and look
 * like a networking fault for as long as it took someone to check.
 */
export function inspectInternalConfig(env: NodeJS.ProcessEnv): InternalConfigFinding[] {
  const findings: InternalConfigFinding[] = [];
  if (!env.FORMA_INTERNAL_AUDIENCE) {
    findings.push({
      code: "FORMA_INTERNAL_AUDIENCE_MISSING",
      message: "the OIDC audience internal callers must present is not set",
    });
  }
  if (list(env.FORMA_OPS_SERVICE_ACCOUNTS).length === 0) {
    findings.push({
      code: "FORMA_OPS_SERVICE_ACCOUNTS_MISSING",
      message: "no operator service account is allowed to call /internal/v1",
    });
  }
  if (list(env.FORMA_WORKER_SERVICE_ACCOUNTS).length === 0) {
    findings.push({
      code: "FORMA_WORKER_SERVICE_ACCOUNTS_MISSING",
      message: "no worker service account is allowed to call /internal/v1",
    });
  }
  return findings;
}

export function internalIngressConfig(env: NodeJS.ProcessEnv = process.env): InternalIngressConfig | null {
  if (inspectInternalConfig(env).length > 0) return null;
  return {
    audience: env.FORMA_INTERNAL_AUDIENCE!,
    ops: list(env.FORMA_OPS_SERVICE_ACCOUNTS),
    workers: list(env.FORMA_WORKER_SERVICE_ACCOUNTS),
    issuer: env.FORMA_INTERNAL_ISSUER ?? GOOGLE_ISSUER,
  };
}

let remoteKeySet: ReturnType<typeof createRemoteJWKSet> | null = null;
let overrideConfig: InternalIngressConfig | null = null;

/**
 * Test seam: an issuer and key set this process will accept instead of
 * Google's. Refused in a deployed process, so it cannot become a production
 * bypass by way of an environment variable someone copied.
 */
export function setInternalIngressForTest(config: InternalIngressConfig | null): void {
  if (isDeployed(process.env)) {
    throw new Error("internal ingress verification cannot be replaced in a deployed process");
  }
  overrideConfig = config;
}

function resolveConfig(env: NodeJS.ProcessEnv): InternalIngressConfig | null {
  return overrideConfig ?? internalIngressConfig(env);
}

/**
 * Verify a Google-signed ID token and place its subject on an allowlist.
 *
 * `not_allowed` is kept distinct from `rejected` for the audit trail: a valid
 * Google token from a service account we do not recognise is a very different
 * event from a forged one, and collapsing them would hide a misrouted
 * deployment inside a stream of noise.
 */
export async function verifyServiceCaller(
  token: string | null,
  required: ServiceRole,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ServiceVerification> {
  if (!token) return { ok: false, reason: "absent" };
  const config = resolveConfig(env);
  if (!config) return { ok: false, reason: "unconfigured" };

  let email: string;
  try {
    const keys = config.keySet
      ? createLocalJWKSet(config.keySet)
      : (remoteKeySet ??= createRemoteJWKSet(new URL(GOOGLE_JWKS_URL)));
    const { payload } = await jwtVerify(token, keys, {
      issuer: config.issuer,
      audience: config.audience,
      algorithms: [...OIDC_ALGORITHMS],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
    });
    // Google sets `email_verified` on a service-account identity token. An
    // unverified address is not an identity we accept, whatever it says.
    if (typeof payload.email !== "string" || payload.email_verified !== true) {
      return { ok: false, reason: "rejected" };
    }
    email = payload.email.toLowerCase();
  } catch (error) {
    // A key set we could not *fetch* is not a token we rejected, and an
    // operator reading the audit needs to tell those apart. A key set that
    // answered and did not contain the signer is a rejection: that is what a
    // token minted by someone else looks like, and reporting it as an outage
    // would turn every forgery into a 503 the caller is invited to retry.
    const code = (error as { code?: string }).code;
    return { ok: false, reason: code === "ERR_JWKS_TIMEOUT" ? "unavailable" : "rejected" };
  }

  const allowed =
    required === "ops" ? config.ops : required === "worker" ? config.workers : [...config.ops, ...config.workers];
  if (!allowed.includes(email)) return { ok: false, reason: "not_allowed" };
  return { ok: true, caller: { serviceAccount: email, role: required } };
}
