/**
 * Anonymous HTTP probes against a Data API.
 *
 * Only `GET` is ever issued. The probe asks for one row of one internal table
 * with a browser-safe publishable key and requires a refusal; a `200` is a
 * failure, because the public-projection allowlist is empty and every one of the
 * 22 tables is internal.
 *
 * Existence is proven through the catalogue before the request is made, which is
 * what lets a `404` be classified as a failed probe rather than a denial.
 */

import { MAX_PROBE_TIMEOUT_SECONDS } from "../contract.js";
import { classifyHttpProbe, classifyTransportError, type ProbeVerdict } from "../assertions.js";

export interface DataApiTarget {
  /** e.g. `https://<ref>.supabase.co/rest/v1` */
  restUrl: string;
  /** Browser-safe publishable/anon key. Never a service-role key. */
  publishableKey: string;
}

export interface AnonymousProbeResult {
  verdict: ProbeVerdict;
  status: number | null;
}

/** One anonymous read attempt, with a hard timeout. */
export async function probeAnonymousSelect(
  target: DataApiTarget,
  table: string,
  timeoutSeconds: number = MAX_PROBE_TIMEOUT_SECONDS,
): Promise<AnonymousProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  try {
    const response = await fetch(
      `${target.restUrl}/${encodeURIComponent(table)}?select=*&limit=1`,
      {
        method: "GET",
        headers: { apikey: target.publishableKey, Accept: "application/json" },
        signal: controller.signal,
      },
    );
    const body = await response.text();
    return { verdict: classifyHttpProbe(response.status, body), status: response.status };
  } catch (error) {
    return { verdict: classifyTransportError(error), status: null };
  } finally {
    clearTimeout(timer);
  }
}

export interface LivenessResult {
  status: number;
  body: Record<string, unknown>;
}

/** Unauthenticated `GET /health`. Read-only by construction. */
export async function probeLiveness(
  url: string,
  timeoutSeconds: number = MAX_PROBE_TIMEOUT_SECONDS,
): Promise<LivenessResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  try {
    const response = await fetch(url, { method: "GET", signal: controller.signal });
    const text = await response.text();
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error("liveness response was not JSON");
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/** The exact public liveness contract: alive, and disclosing nothing else. */
export function assertLivenessContract(result: LivenessResult): string {
  if (result.status !== 200) throw new Error(`GET /health returned ${result.status}`);
  const keys = Object.keys(result.body).sort();
  if (keys.join(",") !== "service,status,ts") {
    throw new Error(`liveness body shape is {${keys.join(",")}}, expected {service,status,ts}`);
  }
  if (result.body.status !== "ok" || result.body.service !== "forma-chess-api") {
    throw new Error("liveness body does not carry the expected public values");
  }
  const serialised = JSON.stringify(result.body).toLowerCase();
  for (const disclosure of ["role", "revision", "secret", "digest", "database", "current_user"]) {
    if (serialised.includes(disclosure)) {
      throw new Error(`liveness body discloses "${disclosure}"`);
    }
  }
  return "HTTP 200 {status,service,ts}; no database, revision, or secret disclosure";
}
