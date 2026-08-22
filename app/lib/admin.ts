import { newIdempotencyKey, v1, v1Data } from "./v1/client";
import type {
  AccessState,
  AdminAccessRequest,
  AdminAccount,
  AdminOperations,
} from "./v1/types";

/**
 * The admin surface's calls.
 *
 * Nothing here is a permission check. Every one of these endpoints asks the
 * database whether the caller holds an operator grant and is refused by it if
 * not, so the worst a tampered bundle achieves is a 403. What this module does
 * is keep the admin screens from reaching for `fetch` directly and losing the
 * problem-document handling every other screen gets.
 */

export const ADMIN_HOST = "admin.formachess.com";

/**
 * True in the artifact built for the admin subdomain (`VITE_SURFACE=admin`).
 *
 * The admin deployment is its own Cloudflare Pages project with its own route
 * tree, so paths that are correct in the product build are wrong in it: there
 * is no `/today` to send a signed-in operator to, and the console lives at `/`
 * rather than `/admin`. Anything that names such a path reads these two
 * constants instead of hardcoding one.
 */
export const ADMIN_BUILD = import.meta.env.VITE_SURFACE === "admin";

/** Where the console is mounted: the root in the admin build, `/admin` otherwise. */
export const ADMIN_BASE = ADMIN_BUILD ? "" : "/admin";

/**
 * Where a signed-in person belongs.
 *
 * `/today` does not exist in the admin build, so redirecting there would sign
 * an operator in and then drop them on a route that is not in the bundle.
 */
export const SIGNED_IN_PATH = ADMIN_BUILD ? "/" : "/today";

/**
 * Whether this browser is on the admin host.
 *
 * A presentation gate, not a security one, and the difference matters: the app
 * is a static bundle on Cloudflare Pages, so anybody can fetch the admin chunk
 * from any hostname that serves it. What this buys is that the admin screens
 * are not one mistyped path away from the product, and that a link pasted into
 * a public page does not render an operator console for a signed-in customer to
 * be confused by. Authorisation is the API's, always.
 *
 * `localhost` counts, because otherwise the surface cannot be developed.
 */
export function isAdminHost(hostname: string): boolean {
  return (
    hostname === ADMIN_HOST ||
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname.endsWith(".localhost")
  );
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

async function page<T>(path: string, query: Record<string, string | undefined>): Promise<Page<T>> {
  const result = await v1<T[]>(path, { query });
  return { items: result.data, nextCursor: result.page?.nextCursor ?? null };
}

export function listAccessRequests(options: {
  state?: AccessState;
  cursor?: string;
}): Promise<Page<AdminAccessRequest>> {
  return page<AdminAccessRequest>("/v1/admin/access-requests", {
    state: options.state,
    cursor: options.cursor,
  });
}

export function listAccounts(options: {
  state?: AccessState;
  cursor?: string;
}): Promise<Page<AdminAccount>> {
  return page<AdminAccount>("/v1/admin/accounts", {
    state: options.state,
    cursor: options.cursor,
  });
}

export function getOperations(): Promise<AdminOperations> {
  return v1Data<AdminOperations>("/v1/admin/operations");
}

/**
 * Approve or decline one account.
 *
 * A fresh idempotency key per press. Deciding the same account twice is a real
 * thing an operator may want to do (a decline reversed on second thoughts), so
 * reusing a key derived from the account id would make the second decision a
 * silent replay of the first.
 */
export function decide(
  userId: string,
  decision: "approved" | "declined",
  note?: string,
): Promise<{ userId: string; state: string }> {
  return v1Data(`/v1/admin/access-requests/${userId}/decision`, {
    method: "POST",
    json: note ? { decision, note } : { decision },
    idempotencyKey: newIdempotencyKey(),
  });
}
