import { createClient } from "@supabase/supabase-js";
import type { Context, MiddlewareHandler, Next } from "hono";
import { client } from "./db/client.js";
import { CuratedError } from "./security/redaction.js";

/**
 * Identity for the API. The browser holds a Supabase session; every protected
 * request carries its access token as `Authorization: Bearer <jwt>`. We resolve
 * that token to a profile id here, so no endpoint ever takes a caller's identity
 * from a query string again.
 *
 * Verification goes through Supabase's auth server rather than a local JWT
 * check: it works for both the legacy HS256 secret and the newer asymmetric
 * signing keys, and it honours revoked sessions. The round-trip is cached for a
 * few seconds so a page that fires six parallel loaders pays for it once.
 */

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY are required");
}

const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export interface AuthUser {
  /** profiles.id — equal to Supabase auth.uid(). */
  id: string;
  email: string | null;
  plan: "free" | "pro";
}

interface CacheEntry {
  user: AuthUser;
  expiresAt: number;
}

const TOKEN_TTL_MS = 15_000;
const tokenCache = new Map<string, CacheEntry>();

/** Drop expired entries so a long-lived process doesn't accumulate dead tokens. */
function sweep(now: number): void {
  if (tokenCache.size < 256) return;
  for (const [token, entry] of tokenCache) {
    if (entry.expiresAt <= now) tokenCache.delete(token);
  }
}

/**
 * Ensure a profiles row exists for a freshly signed-up user. Supabase owns
 * auth.users; `profiles` is our mirror, and everything else in the schema keys
 * off it, so a missing row would break every subsequent query.
 */
async function ensureProfile(id: string, email: string | null): Promise<"free" | "pro"> {
  const rows = await client`
    insert into profiles (id, email)
    values (${id}, ${email})
    on conflict (id) do update set email = coalesce(excluded.email, profiles.email)
    returning plan`;
  const plan = rows[0]?.plan;
  return plan === "pro" ? "pro" : "free";
}

function bearer(c: Context): string | null {
  const header = c.req.header("Authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/** Resolve a bearer token to a profile, or null if it is missing/invalid. */
export async function userFromToken(token: string | null): Promise<AuthUser | null> {
  if (!token) return null;
  const now = Date.now();
  const cached = tokenCache.get(token);
  if (cached && cached.expiresAt > now) return cached.user;
  sweep(now);

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return null;

  const plan = await ensureProfile(data.user.id, data.user.email ?? null);
  const user: AuthUser = { id: data.user.id, email: data.user.email ?? null, plan };
  tokenCache.set(token, { user, expiresAt: now + TOKEN_TTL_MS });
  return user;
}

/** Rejects anonymous callers with 401; hands the profile to the handler. */
export const requireAuth: MiddlewareHandler = async (c: Context, next: Next) => {
  const user = await userFromToken(bearer(c));
  if (!user) return c.json({ error: "Sign in to continue" }, 401);
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
