import { redirect } from "react-router";
import { getAccessToken } from "./session";

/**
 * The single door to our API. Every call carries the Supabase access token, so
 * routes no longer pass a username and hope the server believes them — the
 * server derives identity from the token and refuses anything else.
 */

const BASE = import.meta.env.DEV
  ? "/api"
  : (import.meta.env.VITE_ENGINE_URL ?? import.meta.env.VITE_API_URL ?? "/api");

export interface ApiOptions extends Omit<RequestInit, "body"> {
  /** JSON-encoded automatically; set `method` yourself if it isn't a POST. */
  json?: unknown;
  /** Skip the Authorization header (public endpoints like /billing/plans). */
  anonymous?: boolean;
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

/** Raw request — returns the Response so callers can branch on status. */
export async function apiFetch(path: string, options: ApiOptions = {}): Promise<Response> {
  const { json, anonymous, headers, ...rest } = options;
  const merged = new Headers(headers);
  if (!anonymous) {
    const token = await getAccessToken();
    if (token) merged.set("Authorization", `Bearer ${token}`);
  }
  if (json !== undefined) merged.set("Content-Type", "application/json");
  return fetch(`${BASE}${path}`, {
    ...rest,
    method: rest.method ?? (json !== undefined ? "POST" : "GET"),
    headers: merged,
    body: json === undefined ? undefined : JSON.stringify(json),
  });
}

/**
 * Request + parse. Throws ApiError on failure, and bounces to sign-in on 401 so
 * an expired token never renders as a confusing empty page.
 */
export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const response = await apiFetch(path, options);
  if (response.status === 401) throw redirect("/login");
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new ApiError(response.status, body?.error ?? `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

/** Request that degrades to null instead of throwing — for optional panels. */
export async function apiMaybe<T>(path: string, options: ApiOptions = {}): Promise<T | null> {
  try {
    return await api<T>(path, options);
  } catch (error) {
    if (error instanceof Response) throw error; // a redirect must propagate
    return null;
  }
}
