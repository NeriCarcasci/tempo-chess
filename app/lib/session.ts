import { redirect } from "react-router";
import { getSupabase, supabaseConfigured } from "./supabase";
import { invalidateCache } from "./loaderCache";
import type { Me } from "./v1/types";

/**
 * The signed-in user, as the app sees them.
 *
 * Identity comes from Supabase (email + auth.uid()) and from `GET /v1/me`,
 * which answers for the *canonical* system: `app.profiles`, the personal
 * analysis subject, and `app.linked_accounts`. It used to answer from the
 * prototype's `/me`, which reads a different set of tables in the same
 * database — `public.games` and friends — that the analysis pipeline stopped
 * writing to. Every page keys its data off this object, so while it pointed at
 * the prototype the whole product reported the prototype's numbers: 168 games
 * stored and none analysed, next to a pipeline that had analysed everything.
 *
 * The subject is resolved from the access token on the server. Nothing here
 * sends a username or a subject id, and no page may: the API derives who you
 * are and refuses a body that names somebody else.
 *
 * `/v1/me` carries identity and linked accounts and nothing else, so the plan,
 * the plan limits and the usage counters that used to hang off this object are
 * gone rather than kept on the prototype. There is no entitlement read on `/v1`
 * yet; when there is, it belongs here.
 */

/** The wire shape, straight from the OpenAPI document. */
type V1Account = Me["accounts"][number];

export interface LinkedAccount {
  id: string;
  platform: "lichess" | "chesscom";
  /**
   * The name they play under, or null.
   *
   * Null is a real state, not a bug: the handle is the provider identity's
   * current display username, and it is unset until a provider tells us one.
   * A linked account with no name is still a linked account.
   */
  username: string | null;
  normalizedUsername: string | null;
  connectionKind: V1Account["connectionKind"];
  verificationStatus: V1Account["verificationStatus"];
  /** `disconnected` rows never reach here — see `connected`. */
  status: V1Account["status"];
  /** ISO 8601, as the API sends it. */
  createdAt: string;
}

/**
 * What `/v1` analyses for this person.
 *
 * The id is what every canonical read is scoped to server-side, so a screen
 * that needs to name the thing it is showing has it without a second call.
 * `displayLabel` is the constant "My games" today: a label for the analysis,
 * never a name for the player.
 */
export interface PersonalSubject {
  id: string;
  displayLabel: string;
  status: string;
}

export interface Session {
  /** `app.profiles.user_id`. The server's answer, not the client's claim. */
  userId: string;
  email: string | null;
  /** What Forma analyses for this person, or null before the first link. */
  subject: PersonalSubject | null;
  /** The active account's handle, or "" when the provider has not named it. */
  username: string;
  /** The site that account plays on. Study surfaces read live data from it. */
  platform: "lichess" | "chesscom";
  /** The full row for `username`, or null before anything is linked. */
  activeAccount: LinkedAccount | null;
  /** Connected accounts. A disconnected link is history, not a choice. */
  accounts: LinkedAccount[];
  locale: string | null;
  timezone: string | null;
}

// Same order of preference as `lib/v1/client.ts`, because this now calls the
// same surface and a session resolved against a different host than every
// subsequent read would be a very confusing way to fail.
const API = import.meta.env.DEV
  ? "/api"
  : (import.meta.env.VITE_API_URL ?? import.meta.env.VITE_ENGINE_URL ?? "/api");

/**
 * Which linked account the product is currently looking at.
 *
 * A user may play on both sites, or under two names on one, and the API has
 * always been able to serve any account they have linked — every study endpoint
 * takes a `?username=`. What was missing was a way to *say* which one. Without
 * it the client silently used the first row it was given, so linking a second
 * account imported its games into a corner of the database nothing could reach.
 *
 * The choice lives in localStorage rather than the database because it is a
 * per-device view preference, not account state: the same person can have their
 * laptop on one account and their phone on the other. Keyed by user id so two
 * people sharing a browser do not inherit each other's choice, and validated
 * against the linked rows on every load so an unlinked account falls back to
 * the first one rather than leaving the app pointed at nothing.
 */
const ACTIVE_ACCOUNT_KEY = "tempo.activeAccount";

function readStoredAccountId(userId: string): string | null {
  try {
    return localStorage.getItem(`${ACTIVE_ACCOUNT_KEY}.${userId}`);
  } catch {
    return null; // private mode, or storage disabled — fall back to the first
  }
}

function writeStoredAccountId(userId: string, accountId: string | null): void {
  try {
    const key = `${ACTIVE_ACCOUNT_KEY}.${userId}`;
    if (accountId) localStorage.setItem(key, accountId);
    else localStorage.removeItem(key);
  } catch {
    /* the choice just does not survive the reload */
  }
}

function resolveActive(userId: string, accounts: LinkedAccount[]): LinkedAccount | null {
  const stored = readStoredAccountId(userId);
  const match = stored ? accounts.find((a) => a.id === stored) : undefined;
  if (stored && !match) writeStoredAccountId(userId, null); // unlinked since
  // An active account before a paused one. Both are connected and both are
  // legitimate choices, but only an active one has games still arriving, and
  // landing a returning player on the paused one shows them a history that has
  // stopped moving with nothing on screen saying why.
  return match ?? accounts.find((a) => a.status === "active") ?? accounts[0] ?? null;
}

/**
 * Point the product at one of the user's linked accounts.
 *
 * Everything downstream is keyed by username — loader caches included — so the
 * session and the cache both have to go before the next loader runs. Callers
 * follow this with a navigation.
 */
export function setActiveAccount(userId: string, accountId: string): void {
  writeStoredAccountId(userId, accountId);
  current = null;
  invalidateCache();
}

// Loaders run before render, so components can read the last resolved session
// synchronously instead of every nav bar doing its own async fetch.
let current: Session | null = null;
let inFlight: Promise<Session | null> | null = null;
/** When `current` was resolved, for the reuse window below. */
let currentAt = 0;

/**
 * How long a resolved session is reused across navigations.
 *
 * `getSession` de-duplicated *concurrent* callers and then threw the answer
 * away, so every client-side navigation re-ran `loadSession` and paid a full
 * `/v1/me` round trip — measured at about a second — **before** the route it
 * was navigating to could start fetching its own data. That was most of the
 * delay between pressing a nav item and seeing the page.
 *
 * Reuse is safe because the invalidation points are explicit: sign-in,
 * sign-up, sign-out, account switch and account linking all clear `current`,
 * and a 401 on any `/v1` read redirects to `/login` rather than trusting this.
 * The window is short so a change made in another tab is picked up quickly
 * without anyone having to remember to clear it.
 */
const SESSION_REUSE_MS = 30_000;

/** The last resolved session. Safe in components; null before the first loader. */
/**
 * Whether the last session read found an account that has not been let in.
 *
 * A separate flag rather than a variant of `Session`, because an unapproved
 * account is *not* a session as far as any product screen is concerned: it has
 * no subject, no linked account and nothing to render. Every existing caller of
 * `getSession()` keeps getting `null` and keeps behaving correctly. The two
 * functions that have to tell "signed out" from "waiting" read this.
 *
 * Advisory only. The gate is the API's, and it refuses the request whatever
 * this says.
 */
let awaitingAccess = false;

export function awaitingApproval(): boolean {
  return awaitingAccess;
}

export function peekSession(): Session | null {
  return current;
}

/** The Supabase access token for the current session, or null. */
export async function getAccessToken(): Promise<string | null> {
  if (!supabaseConfigured) return null;
  const { data } = await getSupabase().auth.getSession();
  return data.session?.access_token ?? null;
}

const DEV_EMAIL = import.meta.env.VITE_DEV_AUTOLOGIN_EMAIL as string | undefined;
const DEV_PASSWORD = import.meta.env.VITE_DEV_AUTOLOGIN_PASSWORD as string | undefined;

/**
 * Local convenience: start `npm run dev` already signed in.
 *
 * This is not an auth bypass. It performs an ordinary password sign-in against
 * Supabase, so the token is real and the API still verifies it exactly as it
 * would for anyone else. Two guards keep it out of production: the whole branch
 * sits behind `import.meta.env.DEV`, which Vite folds to `false` and then
 * tree-shakes out of a build, and it does nothing at all unless both env vars
 * are set. Only ever point it at a throwaway local account.
 */
let devSignInTried = false;

async function devAutoSignIn(): Promise<boolean> {
  if (!import.meta.env.DEV) return false;
  if (!DEV_EMAIL || !DEV_PASSWORD || devSignInTried) return false;
  devSignInTried = true; // one attempt per page load, so a bad password cannot loop
  const { error } = await getSupabase().auth.signInWithPassword({
    email: DEV_EMAIL,
    password: DEV_PASSWORD,
  });
  if (error) {
    console.warn(`[dev] auto sign-in as ${DEV_EMAIL} failed: ${error.message}`);
    return false;
  }
  console.info(`[dev] signed in automatically as ${DEV_EMAIL}`);
  return true;
}

/**
 * The wire row as the app names it.
 *
 * `provider`/`handle` on the wire, `platform`/`username` here — the two words
 * for the same thing predate `/v1`, and renaming them across every product
 * screen is a bigger change than this one. The mapping is the whole adapter.
 */
function toAccount(row: V1Account): LinkedAccount {
  return {
    id: row.id,
    platform: row.provider,
    username: row.handle,
    normalizedUsername: row.handle === null ? null : row.handle.toLowerCase(),
    connectionKind: row.connectionKind,
    verificationStatus: row.verificationStatus,
    status: row.status,
    createdAt: row.createdAt,
  };
}

/**
 * Accounts the person still has.
 *
 * A disconnect closes the link and its subject membership rather than deleting
 * anything, so `/v1/me` keeps answering with the row. Offering it in the
 * account switcher would point the product at a subject that no longer
 * receives games.
 */
function connected(accounts: V1Account[]): LinkedAccount[] {
  return accounts.filter((row) => row.status !== "disconnected").map(toAccount);
}

/**
 * Read `/v1/me` directly rather than through `lib/v1/client`.
 *
 * Two reasons, and both are about who may throw. The client turns a 401 into a
 * thrown `redirect("/login")`, which is right inside a loader and wrong here:
 * `getSession()` is also called from components (`PublicShell`) where a thrown
 * `Response` becomes an unhandled rejection, and it would skip the sign-out
 * below, leaving a dead Supabase session that 401s on every subsequent page.
 * The client also imports `getAccessToken` from this module, so calling it from
 * here would close an import cycle for no gain over one `fetch`.
 */
async function loadSession(): Promise<Session | null> {
  if (!supabaseConfigured) return null;
  // Cleared on every read rather than only on success: a stale `true` would
  // send somebody who had just been approved back to the waiting screen.
  awaitingAccess = false;
  let { data } = await getSupabase().auth.getSession();
  if (!data.session && (await devAutoSignIn())) {
    ({ data } = await getSupabase().auth.getSession());
  }
  const authUser = data.session?.user;
  if (!authUser) {
    current = null;
    return null;
  }

  const response = await fetch(`${API}/v1/me`, {
    headers: { Authorization: `Bearer ${data.session!.access_token}` },
  });
  if (!response.ok) {
    // A rejected token means the session is stale; clear it so the user gets a
    // clean sign-in rather than a page that half-loads and then 401s.
    if (response.status === 401) await getSupabase().auth.signOut();
    // Forma is in closed beta and this account has not been let in. The session
    // is perfectly good, so it is deliberately *not* signed out: doing that
    // would drop somebody who is legitimately waiting, and they would have no
    // way back to the screen that tells them so.
    if (response.status === 403) {
      const problem = (await response.json().catch(() => null)) as { code?: string } | null;
      awaitingAccess = problem?.code === "ACCESS_NOT_APPROVED";
    }
    current = null;
    return null;
  }
  // `/v1` answers in an envelope. `meta.redactions` is dropped on purpose:
  // nothing on this payload is withholdable, and a session that carried a
  // redaction list would invite screens to read entitlements off it.
  const body = (await response.json()) as { data: Me };
  const me = body.data;

  const accounts = connected(me.accounts);
  // `me.profileId`, not `authUser.id`. They are the same uuid today, and the
  // one the server resolved is the one every other `/v1` read is scoped to.
  const active = resolveActive(me.profileId, accounts);

  current = {
    userId: me.profileId,
    // The only field Supabase still owns. `/v1/me` does not publish an email,
    // and it should not: the address is authentication, not chess identity.
    email: authUser.email ?? null,
    subject: me.personalSubject,
    username: active?.username ?? "",
    platform: active?.platform ?? "lichess",
    activeAccount: active,
    accounts,
    locale: me.locale,
    timezone: me.timezone,
  };
  currentAt = Date.now();
  return current;
}

/**
 * Resolve the session, de-duplicating the concurrent calls a page full of
 * parallel loaders would otherwise make.
 */
export function getSession(): Promise<Session | null> {
  // A session resolved moments ago is reused rather than re-fetched: this is
  // the difference between a navigation that starts loading its page and one
  // that waits on `/v1/me` first.
  if (current && Date.now() - currentAt < SESSION_REUSE_MS) return Promise.resolve(current);
  if (!inFlight) {
    inFlight = loadSession().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

/**
 * For protected loaders: return the session or redirect to sign-in. A signed-in
 * user with no linked chess account is sent to `/welcome` instead, since every
 * study surface needs games to work from.
 *
 * The gate is **whether an account is connected**, not whether we have a name
 * to print. It used to be `if (!session.username)`, which conflated the two:
 * `handle` is the provider identity's display username and can be null on a
 * perfectly good link, so a connected player with no recorded name was read as
 * a player who had linked nothing. That redirect is one leg of a loop —
 * `/welcome` sends a live run to `/onboarding`, `/onboarding` sends a written
 * report to `/report`, and `/report` calls this function — and it has shipped
 * to a real person once already. Nothing below may reintroduce a test on the
 * *contents* of `username`.
 */
export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) throw redirect(awaitingAccess ? "/access" : "/login");
  // `/welcome` is where a new person connects an account and the examination
  // starts. `/account/connect` is still mounted for "link another account",
  // which is a different errand.
  if (!session.activeAccount) throw redirect("/welcome");
  return session;
}

/**
 * Like requireSession, but tolerates a missing chess account — used by the
 * onboarding and account screens, which exist precisely to link one.
 */
export async function requireUser(): Promise<Session> {
  const session = await getSession();
  if (!session) throw redirect(awaitingAccess ? "/access" : "/login");
  return session;
}

export async function signInWithPassword(email: string, password: string): Promise<void> {
  const { error } = await getSupabase().auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
  current = null;
}

export async function signUpWithPassword(
  email: string,
  password: string,
): Promise<{ needsConfirmation: boolean }> {
  const { data, error } = await getSupabase().auth.signUp({
    email,
    password,
    options: { emailRedirectTo: `${location.origin}/login?confirmed=1` },
  });
  if (error) throw new Error(error.message);
  current = null;
  // With "confirm email" on, Supabase returns a user but no session.
  return { needsConfirmation: !data.session };
}

export async function sendPasswordReset(email: string): Promise<void> {
  const { error } = await getSupabase().auth.resetPasswordForEmail(email, {
    redirectTo: `${location.origin}/reset-password`,
  });
  if (error) throw new Error(error.message);
}

export async function updatePassword(password: string): Promise<void> {
  const { error } = await getSupabase().auth.updateUser({ password });
  if (error) throw new Error(error.message);
  current = null;
  await getSupabase().auth.signOut();
}

export async function signOut(): Promise<void> {
  current = null;
  if (supabaseConfigured) await getSupabase().auth.signOut();
}

/** Forget the cached session so the next loader refetches `/v1/me`. */
export function invalidateSession(): void {
  current = null;
}
