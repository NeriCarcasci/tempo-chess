import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isDeployed, type RuntimeEnv } from "../security/config.js";

/**
 * The kernel's one symmetric secret.
 *
 * It keys three things that must not be forgeable or offline-testable: the
 * opaque pagination cursors, the idempotency request digests, and the
 * rate-limit subject keys. One key rather than three because they share a
 * lifetime and a rotation story, and because every use is domain-separated by
 * an explicit purpose string — so a cursor signature can never be replayed as
 * an idempotency digest.
 *
 * Fail-closed, like E01's database configuration: a deployed process without a
 * usable key refuses to start rather than silently signing with something
 * predictable. Outside a deployment the key may be absent, and a random
 * per-process key is used instead; that is honest for local development
 * (cursors stop working across a restart, which is exactly what an unset secret
 * means) and it is never the deployed path.
 *
 * The key itself never leaves this module. Findings name the field, not the
 * value.
 */

export const SIGNING_KEY_ENV = "FORMA_API_SIGNING_KEY";

/** Below this a shared secret is not worth calling one. */
export const MINIMUM_KEY_BYTES = 32;

/** Domain separation. A signature is only ever valid for the purpose it was made for. */
export type SigningPurpose = "cursor" | "idempotency-digest" | "rate-limit-subject";

export interface KernelConfigFinding {
  code: string;
  message: string;
}

export class KernelConfigError extends Error {
  constructor(readonly findings: readonly KernelConfigFinding[]) {
    super(`api kernel configuration rejected: ${findings.map((f) => f.code).join(", ")}`);
    this.name = "KernelConfigError";
  }
}

export interface KernelEnv extends RuntimeEnv {
  FORMA_API_SIGNING_KEY?: string;
}

/**
 * Every blocking reason this configuration must not serve `/v1`. An empty array
 * is the only acceptable result for a deployed process.
 */
export function inspectKernelConfig(env: KernelEnv): KernelConfigFinding[] {
  const raw = env[SIGNING_KEY_ENV as "FORMA_API_SIGNING_KEY"];
  if (!raw) {
    if (!isDeployed(env)) return [];
    return [
      {
        code: "API_SIGNING_KEY_MISSING",
        message: `${SIGNING_KEY_ENV} is not set; the /v1 kernel cannot sign cursors or digests`,
      },
    ];
  }
  if (Buffer.byteLength(raw, "utf8") < MINIMUM_KEY_BYTES) {
    return [
      {
        code: "API_SIGNING_KEY_TOO_SHORT",
        message: `${SIGNING_KEY_ENV} must be at least ${MINIMUM_KEY_BYTES} bytes`,
      },
    ];
  }
  return [];
}

/** Startup gate. Throws before the process can serve a single `/v1` request. */
export function assertKernelConfig(env: KernelEnv): void {
  const findings = inspectKernelConfig(env);
  if (findings.length > 0) throw new KernelConfigError(findings);
}

let cachedKey: Buffer | null = null;

/**
 * The signing key for this process. Resolved once: a key that changed under a
 * running process would silently invalidate every cursor it had already issued.
 */
export function signingKey(env: KernelEnv = process.env): Buffer {
  if (cachedKey) return cachedKey;
  assertKernelConfig(env);
  const raw = env[SIGNING_KEY_ENV as "FORMA_API_SIGNING_KEY"];
  cachedKey = raw ? Buffer.from(raw, "utf8") : randomBytes(MINIMUM_KEY_BYTES);
  return cachedKey;
}

/** Test seam: replace the process key. Rejected once a deployed key is in use. */
export function setSigningKeyForTest(key: Buffer): void {
  if (isDeployed(process.env)) {
    throw new Error("the signing key cannot be replaced in a deployed process");
  }
  cachedKey = key;
}

/** Hex HMAC of `parts`, domain-separated by `purpose`. */
export function sign(purpose: SigningPurpose, parts: readonly string[], env?: KernelEnv): string {
  const hmac = createHmac("sha256", signingKey(env));
  hmac.update(purpose);
  for (const part of parts) {
    // Length-prefixed so ["a", "bc"] and ["ab", "c"] cannot collide.
    hmac.update("\u0000");
    hmac.update(String(part.length));
    hmac.update("\u0000");
    hmac.update(part);
  }
  return hmac.digest("hex");
}

/** Constant-time comparison of two hex signatures of the same purpose. */
export function signatureMatches(expected: string, presented: string): boolean {
  if (expected.length !== presented.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(presented, "hex"));
  } catch {
    // A non-hex presented value cannot match a hex expected one.
    return false;
  }
}
