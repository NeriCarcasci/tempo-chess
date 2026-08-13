import { redirect } from "react-router";
import { getSupabase, supabaseConfigured } from "./supabase";

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
  accounts: LinkedAccount[];
  subscription: Subscription;
  limits: PlanLimits;
  usage: UsageSummary;
}

const API = import.meta.env.DEV
  ? "/api"
  : (import.meta.env.VITE_ENGINE_URL ?? import.meta.env.VITE_API_URL ?? "/api");

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

  current = {
    userId: body.user.id,
    email: body.user.email,
    username: body.accounts[0]?.username ?? "",
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
 * user with no linked chess account is sent to onboarding instead, since every
 * study surface needs games to work from.
 */
export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) throw redirect("/login");
  if (!session.username) throw redirect("/account/connect");
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
