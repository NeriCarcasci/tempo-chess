import { redirect } from "react-router";
import { getAccessToken } from "../session";
import { ProblemError, type ProblemDocument } from "./problem";

/**
 * The `/v1` door.
 *
 * `lib/api.ts` is the legacy one and still serves the current site; this is the
 * versioned surface, and it is separate rather than a flag on the old client
 * because the two differ in every respect that matters: the envelope, the
 * failure shape, idempotency, cursors and what a 404 means.
 *
 * Four things happen here so that no screen has to remember them:
 *
 *   * every command carries an `Idempotency-Key`, and a retry reuses it;
 *   * a failure arrives as a `ProblemError` with a `code` to branch on;
 *   * the envelope is unwrapped, with `page` and `meta` kept beside the data,
 *     because `meta.redactions` is content and dropping it would silently turn
 *     "you may not see this" into "this does not exist";
 *   * a 401 bounces to sign-in rather than rendering an empty page.
 */

const BASE = import.meta.env.DEV
  ? "/api"
  : (import.meta.env.VITE_API_URL ?? import.meta.env.VITE_ENGINE_URL ?? "/api");

export type RedactionReason = "entitlement" | "projection";

export interface Redaction {
  path: string;
  reason: RedactionReason;
}

export interface ResponseMeta {
  requestId: string;
  redactions?: Redaction[];
}

export interface PageBlock {
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * A response, with everything the API said about it.
 *
 * Deliberately not just `data`. A caller that only wants the payload writes
 * `.data`; one that renders honestly reads `meta.redactions` too, and it is
 * right there rather than behind a second call.
 */
export interface V1Result<T> {
  data: T;
  meta: ResponseMeta;
  page?: PageBlock;
}

export interface V1Options extends Omit<RequestInit, "body" | "method"> {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  json?: unknown;
  /** Skip the bearer token. Public routes behave identically either way. */
  anonymous?: boolean;
  /**
   * The idempotency key for a command.
   *
   * Supply one per *user intent* and reuse it across retries of that intent —
   * that is the whole point. Omitted, one is generated, which is correct for a
   * single fire-and-forget call and wrong for anything the user might press
   * twice.
   */
  idempotencyKey?: string;
  /** The current ETag, for a write the server guards with `If-Match`. */
  ifMatch?: string;
  query?: Record<string, string | number | boolean | null | undefined>;
}

function withQuery(path: string, query: V1Options["query"]): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined || value === "") continue;
    params.set(key, String(value));
  }
  const suffix = params.toString();
  return suffix ? `${path}?${suffix}` : path;
}

/** A key per intent. `crypto.randomUUID` is available in every target browser. */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

/**
 * One request.
 *
 * Returns the envelope. Throws `ProblemError` on failure, or a redirect on 401
 * — a redirect is a `Response`, which React Router understands and which must
 * be allowed to propagate rather than being swallowed by a `catch`.
 */
export async function v1<T>(path: string, options: V1Options = {}): Promise<V1Result<T>> {
  const { json, anonymous, idempotencyKey, ifMatch, query, headers, ...rest } = options;
  const method = options.method ?? (json !== undefined ? "POST" : "GET");
  const merged = new Headers(headers);

  if (!anonymous) {
    const token = await getAccessToken();
    if (token) merged.set("Authorization", `Bearer ${token}`);
  }
  if (json !== undefined) merged.set("Content-Type", "application/json");
  if (method !== "GET") merged.set("Idempotency-Key", idempotencyKey ?? newIdempotencyKey());
  if (ifMatch) merged.set("If-Match", ifMatch);

  const response = await fetch(`${BASE}${withQuery(path, query)}`, {
    ...rest,
    method,
    headers: merged,
    body: json === undefined ? undefined : JSON.stringify(json),
  });

  if (response.status === 401 && !anonymous) throw redirect("/login");

  if (!response.ok) {
    const document = (await response.json().catch(() => null)) as ProblemDocument | null;
    const retryAfter = response.headers.get("retry-after");
    throw new ProblemError(
      document ?? {
        type: "about:blank",
        title: "Request failed",
        status: response.status,
        code: response.status >= 500 ? "INTERNAL_ERROR" : "CONFLICT",
      },
      retryAfter === null ? null : Number(retryAfter),
    );
  }

  if (response.status === 204) {
    return { data: undefined as T, meta: { requestId: "" } };
  }

  const body = (await response.json()) as V1Result<T>;
  return body;
}

/** The payload alone, for the many callers that do not need the envelope. */
export async function v1Data<T>(path: string, options: V1Options = {}): Promise<T> {
  return (await v1<T>(path, options)).data;
}

/**
 * A read that degrades to null rather than throwing.
 *
 * For panels that are genuinely optional. It swallows problems, so it must not
 * be used for anything the person is waiting on — an empty panel where an error
 * belongs is the failure mode this whole client exists to avoid.
 */
export async function v1Maybe<T>(path: string, options: V1Options = {}): Promise<T | null> {
  try {
    return await v1Data<T>(path, options);
  } catch (error) {
    if (error instanceof Response) throw error;
    return null;
  }
}

/**
 * Walk a cursor-paged collection.
 *
 * The cursor is opaque and bound to the route *and its filters*: it is passed
 * straight back and never inspected. `limit` guards against a loop that would
 * page forever if the server ever stopped setting `hasMore` honestly.
 */
export async function v1Collect<T>(
  path: string,
  options: V1Options & { pages?: number } = {},
): Promise<T[]> {
  const maxPages = options.pages ?? 10;
  const out: T[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < maxPages; page += 1) {
    const result: V1Result<T[]> = await v1<T[]>(path, {
      ...options,
      query: { ...options.query, cursor },
    });
    out.push(...result.data);
    if (!result.page?.hasMore || !result.page.nextCursor) break;
    cursor = result.page.nextCursor;
  }
  return out;
}

/**
 * Was this path withheld, and why?
 *
 * `meta.redactions` names paths like `data.providerHandles`. A component asks
 * this rather than inferring absence, because the three cases — absent,
 * withheld by plan, not carried by this endpoint — are three different things
 * to show.
 */
export function redactionFor(meta: ResponseMeta | undefined, path: string): Redaction | null {
  return meta?.redactions?.find((entry) => entry.path === path) ?? null;
}
