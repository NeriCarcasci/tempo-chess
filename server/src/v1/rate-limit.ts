import { client } from "../db/client.js";
import { sign, type KernelEnv } from "./signing.js";

/**
 * Distributed rate limiting, per plans/v1-platform-spec.md §17 and the audit's
 * §10 finding that the current limiter is "instance-specific".
 *
 * An in-process counter is not a rate limit on an autoscaling service: five
 * instances means five times the limit, and a cold start resets it. The counter
 * therefore lives in PostgreSQL, incremented by one atomic upsert, so every
 * instance shares one budget.
 *
 * PostgreSQL rather than Redis because there is no cache tier to reuse, and
 * adding one is a "new infrastructure family" decision under platform spec §22.
 * A fixed window at these volumes costs a single indexed upsert; if that stops
 * being true, the interface here does not change.
 *
 * The rate-limited identity is never stored. `subject_key` is a keyed HMAC, so
 * the table cannot be mined for client addresses or email addresses — a limiter
 * that quietly builds a log of who visited is a privacy problem, not a control.
 */

export interface RateLimitPolicy {
  /** Stored as `bucket`; also the domain separator for the subject key. */
  readonly name: string;
  readonly windowSeconds: number;
  readonly max: number;
}

/** The policies the API ships. Adding one is a code change, not a runtime knob. */
export const POLICIES = {
  publicRead: { name: "public_read", windowSeconds: 60, max: 120 },
  betaSignupAddress: { name: "public_beta_signup_ip", windowSeconds: 3_600, max: 5 },
  betaSignupEmail: { name: "public_beta_signup_email", windowSeconds: 86_400, max: 3 },
  /**
   * E12's bounded interactive evaluation. Counted per actor rather than per
   * address, because what this endpoint spends is engine time and engine time
   * is spent by whoever is signed in — an address limit would let one account
   * behind a changing address run the worker pool flat.
   */
  interactiveEvaluation: { name: "interactive_evaluation", windowSeconds: 60, max: 30 },
  /** CPU model work. A human cannot reasonably make more than twenty replies a minute. */
  maiaContinuation: { name: "maia_continuation", windowSeconds: 60, max: 20 },
  /**
   * One bot move in a game against the engine. Per actor, for the same reason
   * as the evaluation above: engine time is spent by whoever is signed in.
   *
   * Sixty a minute is deliberately generous against a person and tight against
   * a script. A human playing a bot game makes a move every few seconds and
   * will never approach it; a loop asking for a move as fast as the API answers
   * would otherwise keep an engine process running continuously on one account.
   * Higher than the evaluation limit because a game is many small requests
   * where an evaluation is one large one.
   */
  playMove: { name: "play_move", windowSeconds: 60, max: 60 },
  /**
   * E16's onboarding surface. Counted per actor: an onboarding screen polls
   * while a sync runs, so the read limit is generous, and the command limit is
   * tight because every command here either starts real work or records a
   * decision a person made once.
   */
  onboardingRead: { name: "onboarding_read", windowSeconds: 60, max: 120 },
  onboardingCommand: { name: "onboarding_command", windowSeconds: 60, max: 20 },
  /**
   * E20's public player directory. Much tighter than `publicRead`, and per
   * address, because a prefix search over handles is the one public read whose
   * abuse case is enumeration rather than load: thirty queries a minute is
   * plenty for a person looking somebody up and useless for walking the
   * alphabet.
   */
  directorySearch: { name: "public_directory_search", windowSeconds: 60, max: 30 },
  /**
   * The closed beta's own two endpoints. Per actor.
   *
   * These are the only routes an account that has not been let in can reach,
   * which makes them the only authenticated surface open to the population we
   * have explicitly decided not to trust yet. Leaving the one door unlocked
   * because it is small is how the small door becomes the interesting one.
   *
   * The read is generous because the waiting screen is something a person
   * refreshes; the write is tight because saving a note is an act somebody
   * performs a handful of times and never in a loop.
   */
  accessRead: { name: "access_read", windowSeconds: 60, max: 60 },
  accessCommand: { name: "access_command", windowSeconds: 60, max: 10 },
} as const satisfies Record<string, RateLimitPolicy>;

export type RateLimitStatus = "ok" | "limited" | "degraded";

export interface RateLimitDecision {
  status: RateLimitStatus;
  /** Requests left in this window; null when the store was unavailable. */
  remaining: number | null;
  /** Seconds until the window resets. */
  retryAfterSeconds: number;
}

/**
 * Timestamps cross the driver as ISO strings: the runtime pool disables
 * prepared statements, so postgres.js never learns a parameter's type and
 * refuses to serialize a `Date`. PostgreSQL casts on arrival.
 */
const at = (moment: Date): string => moment.toISOString();

/** Truncate to the window so every instance agrees on the current bucket. */
export function windowStart(policy: RateLimitPolicy, now: Date): Date {
  const ms = policy.windowSeconds * 1_000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

function subjectKey(policy: RateLimitPolicy, identity: string, env?: KernelEnv): string {
  return sign("rate-limit-subject", [policy.name, identity], env).slice(0, 32);
}

/**
 * Count this request against `policy`.
 *
 * `failClosed` is the interesting parameter. When the counter store is
 * unavailable, a command must not become a free write channel, and a public
 * read must not black out the landing page because the database hiccuped — so
 * the two answers genuinely differ and the caller states which it wants. Either
 * way the outcome is `degraded`, and the structured log says so rather than
 * reporting a clean `ok`.
 */
export async function consume(
  policy: RateLimitPolicy,
  identity: string,
  options: { failClosed: boolean; sql?: typeof client; now?: Date; env?: KernelEnv },
): Promise<RateLimitDecision> {
  const sql = options.sql ?? client;
  const now = options.now ?? new Date();
  const start = windowStart(policy, now);
  const expiresAt = new Date(start.getTime() + policy.windowSeconds * 1_000);
  const retryAfterSeconds = Math.max(1, Math.ceil((expiresAt.getTime() - now.getTime()) / 1_000));

  try {
    const rows = await sql<{ count: number }[]>`
      insert into ops.rate_limit_counters (bucket, subject_key, window_start, count, expires_at)
      values (${policy.name}, ${subjectKey(policy, identity, options.env)}, ${at(start)}, 1, ${at(expiresAt)})
      on conflict (bucket, subject_key, window_start) do update
        set count = ops.rate_limit_counters.count + 1
      returning count`;
    const count = rows[0]?.count ?? 1;
    await maybeExpire(sql, now);
    return count > policy.max
      ? { status: "limited", remaining: 0, retryAfterSeconds }
      : { status: "ok", remaining: Math.max(0, policy.max - count), retryAfterSeconds };
  } catch {
    // The error itself is the caller's to log through the redaction layer; a
    // limiter that logged raw driver errors would be a new leak in the one
    // place that sees every public request.
    return {
      status: "degraded",
      remaining: null,
      retryAfterSeconds: options.failClosed ? retryAfterSeconds : 0,
    };
  }
}

/**
 * Opportunistic expiry, roughly one request in fifty.
 *
 * Sampled rather than scheduled so the counter table needs no sweeper of its
 * own, and bounded so a cleanup can never become the slow part of a request.
 * A failure here is invisible on purpose: expired rows are inert, and the next
 * sample will try again.
 */
async function maybeExpire(sql: typeof client, now: Date): Promise<void> {
  if (Math.random() >= 0.02) return;
  try {
    await sql`
      delete from ops.rate_limit_counters
      where ctid in (
        select ctid from ops.rate_limit_counters where expires_at < ${at(now)} limit 500
      )`;
  } catch {
    /* expired counters are inert; the next sample retries */
  }
}

/**
 * The address a public request came from.
 *
 * Cloudflare's header first, then the leftmost `X-Forwarded-For` hop, which is
 * what Cloud Run appends the client address to. `unknown` is a real bucket: it
 * shares one budget across every caller we cannot attribute, which is the safe
 * direction to be wrong in.
 */
export function clientAddress(headers: {
  cfConnectingIp?: string | null;
  forwardedFor?: string | null;
}): string {
  const cf = headers.cfConnectingIp?.trim();
  if (cf) return cf;
  const first = headers.forwardedFor?.split(",")[0]?.trim();
  return first && first.length > 0 ? first : "unknown";
}
