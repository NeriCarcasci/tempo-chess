import { redirect } from "react-router";
import { getSupabase, supabaseConfigured } from "./supabase";
import { invalidateCache } from "./loaderCache";

/**
 * The signed-in user, as the app sees them.
 *
 * Identity comes from Supabase (email + auth.uid()); the chess account and plan
 * come from our API's `/me`. Routes read this instead of trusting a username in
 * their own URL, and the API re-checks everything against the access token, so
 * a tampered client can't reach another player's data.
 */

export interface LinkedAccount {
  id: string;
  platform: "lichess" | "chesscom";
  username: string;
  normalizedUsername: string;
}

export interface Subscription {
  plan: "free" | "pro";
  status: "active" | "none";
  currentPeriodEnd: string | null;
  comped: boolean;
}

export interface PlanLimits {
  analysedGames: number | null;
  dailyDrills: number | null;
  explorerDepth: number;
  deepEngineAnalysis: boolean;
  fullRepertoireMap: boolean;
}

export interface UsageSummary {
  gamesStored: number;
  gamesAnalyzed: number;
  positionsAnalyzed: number;
  drillsToday: number;
  drillsAllTime: number;
  lessonsCompleted: number;
  enginePositionsToday: number;
  byAccount: Array<{
    accountId: string;
    platform: "lichess" | "chesscom";
    username: string;
    gamesStored: number;
    gamesAnalyzed: number;
  }>;
}

export interface Session {
  userId: string;
  email: string | null;
  /** The chess account whose games back the study surfaces. */
  username: string;
  /** The site that account plays on. Study surfaces read live data from it. */
  platform: "lichess" | "chesscom";
  /** The full row for `username`, or null before anything is linked. */
  activeAccount: LinkedAccount | null;
  accounts: LinkedAccount[];
  subscription: Subscription;
  limits: PlanLimits;
  usage: UsageSummary;
}

const API = import.meta.env.DEV
  ? "/api"
  : (import.meta.env.VITE_ENGINE_URL ?? import.meta.env.VITE_API_URL ?? "/api");

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
  return match ?? accounts[0] ?? null;
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

/** The last resolved session. Safe in components; null before the first loader. */
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

async function loadSession(): Promise<Session | null> {
  if (!supabaseConfigured) return null;
  let { data } = await getSupabase().auth.getSession();
  if (!data.session && (await devAutoSignIn())) {
    ({ data } = await getSupabase().auth.getSession());
  }
  const authUser = data.session?.user;
  if (!authUser) {
    current = null;
    return null;
  }

  const response = await fetch(`${API}/me`, {
    headers: { Authorization: `Bearer ${data.session!.access_token}` },
  });
  if (!response.ok) {
    // A rejected token means the session is stale; clear it so the user gets a
    // clean sign-in rather than a page that half-loads and then 401s.
    if (response.status === 401) await getSupabase().auth.signOut();
    current = null;
    return null;
  }
  const body = await response.json() as {
    user: { id: string; email: string | null };
    accounts: LinkedAccount[];
    subscription: Subscription;
    limits: PlanLimits;
    usage: UsageSummary;
  };

  const active = resolveActive(body.user.id, body.accounts);

  current = {
    userId: body.user.id,
    email: body.user.email,
    username: active?.username ?? "",
    platform: active?.platform ?? "lichess",
    activeAccount: active,
    accounts: body.accounts,
    subscription: body.subscription,
    limits: body.limits,
    usage: body.usage,
  };
  return current;
}

/**
 * Resolve the session, de-duplicating the concurrent calls a page full of
 * parallel loaders would otherwise make.
 */
export function getSession(): Promise<Session | null> {
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
 */
export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) throw redirect("/login");
  // `/welcome` is where a new person connects an account and the examination
  // starts. `/account/connect` is still mounted for "link another account",
  // which is a different errand.
  if (!session.username) throw redirect("/welcome");
  return session;
}

/**
 * Like requireSession, but tolerates a missing chess account — used by the
 * onboarding and account screens, which exist precisely to link one.
 */
export async function requireUser(): Promise<Session> {
  const session = await getSession();
  if (!session) throw redirect("/login");
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

/** Forget the cached session so the next loader refetches `/me`. */
export function invalidateSession(): void {
  current = null;
}
