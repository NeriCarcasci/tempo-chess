import type { Context, MiddlewareHandler, Next } from "hono";
import { client } from "./db/client.js";
import { CuratedError } from "./security/redaction.js";
import { buildAuthorizationContext } from "./v1/auth/context.js";
import { bearerToken, tokenVerifier } from "./v1/auth/verifier.js";
import { accessDetail, grantsProductAccess, type AccessState } from "./access/contract.js";

/**
 * Identity for the API. The browser holds a Supabase session; every protected
 * request carries its access token as `Authorization: Bearer <jwt>`. We resolve
 * that token to a profile id here, so no endpoint ever takes a caller's identity
 * from a query string again.
 *
 * E03 moved verification itself into the `/v1` kernel: the token is checked
 * locally against Supabase's published JWKS, with `getUser` as a controlled
 * fallback for legacy symmetric tokens. The legacy routes delegate to the same
 * verifier so there is one implementation of "who is this", not two — and so
 * the audit's finding about a per-request Supabase round trip and a cache keyed
 * on the raw bearer token is fixed everywhere at once, not just under `/v1`.
 *
 * The response contract of these routes is deliberately unchanged: the same
 * `{ error }` body, the same statuses. Migrating a legacy endpoint to problem
 * details is the work of the epic that owns that endpoint.
 */

export interface AuthUser {
  /** profiles.id — equal to Supabase auth.uid(). */
  id: string;
  email: string | null;
  plan: "free" | "pro";
  /** Whether the closed beta has let this account in. */
  accessState: AccessState;
}

function bearer(c: Context): string | null {
  return bearerToken(c.req.header("Authorization"));
}

/** Resolve a bearer token to a profile, or null if it is missing/invalid. */
export async function userFromToken(token: string | null): Promise<AuthUser | null> {
  if (!token) return null;
  const verified = await tokenVerifier().verify(token);
  if (!verified.ok) return null;
  const context = await buildAuthorizationContext(verified.token);
  return {
    id: context.profileId,
    email: context.email,
    plan: context.plan,
    accessState: context.access.state,
  };
}

/**
 * Rejects anonymous callers with 401; hands the profile to the handler.
 *
 * It also enforces the closed beta, which is not `/v1`'s job to do twice but is
 * nobody else's job here. `/imports`, `/analyze` and `/engine/*` are on this
 * middleware and every one of them spends real Stockfish time on Cloud Run, so
 * an account that has not been let in and can still reach them makes the gate
 * decorative. The legacy surface is being retired in a separate piece of work;
 * until it is gone it is a product surface, and this is the one place that
 * covers all fourteen of its route prefixes at once.
 *
 * The body shape is the legacy `{ error }` rather than a problem document,
 * because these routes' contract is deliberately unchanged and a client parsing
 * `{ error }` should not start getting something else. The code lives in the
 * body so the browser can still tell this apart from a plain refusal.
 */
export const requireAuth: MiddlewareHandler = async (c: Context, next: Next) => {
  const user = await userFromToken(bearer(c));
  if (!user) return c.json({ error: "Sign in to continue" }, 401);
  if (!grantsProductAccess(user.accessState)) {
    return c.json({ error: accessDetail(user.accessState), code: "ACCESS_NOT_APPROVED" }, 403);
  }
  c.set("user", user);
  await next();
};

export function currentUser(c: Context): AuthUser {
  const user = c.get("user") as AuthUser | undefined;
  if (!user) throw new Error("currentUser() called outside requireAuth");
  return user;
}

// --- linked chess accounts -------------------------------------------------

export interface LinkedAccount {
  id: string;
  platform: "lichess" | "chesscom";
  username: string;
  normalizedUsername: string;
}

export async function listLinkedAccounts(userId: string): Promise<LinkedAccount[]> {
  const rows = await client`
    select id, platform, username, normalized_username
    from linked_accounts where user_id = ${userId}
    order by created_at asc`;
  return rows.map((r) => ({
    id: String(r.id),
    platform: r.platform as LinkedAccount["platform"],
    username: String(r.username),
    normalizedUsername: String(r.normalized_username),
  }));
}

/**
 * The chess username whose games back this user's study data. Most of the
 * analysis layer is still addressed by username, so authenticated handlers
 * resolve the caller to one here instead of trusting a query parameter.
 */
export async function primaryUsername(userId: string): Promise<string | null> {
  const accounts = await listLinkedAccounts(userId);
  return accounts[0]?.username ?? null;
}

/**
 * The username an authenticated request may operate on.
 *
 * Endpoints still address the analysis layer by chess username, so a request
 * may name one — but only one the caller has actually linked. Anything else is
 * refused rather than silently retargeted, and a caller who names nothing gets
 * their primary account. This is what closes the old `?username=anyone` hole.
 */
export async function requireAccountUsername(
  userId: string,
  requested?: string | null,
): Promise<string> {
  const accounts = await listLinkedAccounts(userId);
  if (accounts.length === 0) {
    throw new AccountError("Link a Lichess or Chess.com account first", 409);
  }
  if (!requested || !requested.trim()) return accounts[0].username;
  const normalized = requested.trim().toLowerCase();
  const match = accounts.find((a) => a.normalizedUsername === normalized);
  if (!match) throw new AccountError(`"${requested}" is not linked to your account`, 403);
  return match.username;
}

/**
 * Carries the right HTTP status out of the identity helpers.
 *
 * Marked as a curated message: these strings were written for the caller and
 * contain nothing but that caller's own input, so the safe-error layer lets them
 * through instead of collapsing them to the generic sentence.
 */
export class AccountError extends CuratedError {
  constructor(message: string, readonly status: 403 | 409) {
    super(message);
    this.name = "AccountError";
  }
}

/**
 * Link a chess account to a profile. Claiming a username that another profile
 * already imported is refused — otherwise linking would be a way to read
 * someone else's analysed games.
 */
export async function linkAccount(
  userId: string,
  platform: "lichess" | "chesscom",
  username: string,
): Promise<LinkedAccount> {
  const normalized = username.trim().toLowerCase();
  const taken = await client`
    select user_id from linked_accounts
    where platform = ${platform} and normalized_username = ${normalized}
    limit 1`;
  if (taken[0] && String(taken[0].user_id) !== userId) {
    throw new AccountError(`"${username}" is already linked to another Forma account`, 409);
  }
  const rows = await client`
    insert into linked_accounts (user_id, platform, username, normalized_username)
    values (${userId}, ${platform}, ${username.trim()}, ${normalized})
    on conflict (user_id, platform, normalized_username)
      do update set username = excluded.username
    returning id, platform, username, normalized_username`;
  const r = rows[0];
  return {
    id: String(r.id),
    platform: r.platform as LinkedAccount["platform"],
    username: String(r.username),
    normalizedUsername: String(r.normalized_username),
  };
}
