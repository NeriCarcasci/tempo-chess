import { z } from "zod";
import { client } from "./db/client.js";

/**
 * Beta testing signups from the landing page.
 *
 * This is the only write in the API that does not require a session, which
 * makes it the only one a stranger can aim at. Everything here is shaped by
 * that: the payload is small and strictly bounded, the insert is idempotent on
 * email so a double-submit is not a duplicate row, and there is a per-address
 * rate limit in front of it.
 *
 * Nothing here reads back. There is no public endpoint that lists signups —
 * the list lives in the database and is looked at with SQL, because an API that
 * can return other people's email addresses is a liability we do not need.
 */

/** Where they play. `both` is a real answer and the one power users pick. */
export const PLATFORM_CHOICES = ["lichess", "chesscom", "both", "otb"] as const;

/**
 * Bands, not numbers. Ratings differ by hundreds of points across sites and
 * time controls, so an exact figure would be false precision; a band is what
 * someone can answer without looking it up, which is the whole point of a form
 * that claims to take thirty seconds.
 */
export const RATING_CHOICES = [
  "under-1000",
  "1000-1400",
  "1400-1800",
  "1800-2200",
  "over-2200",
  "unrated",
] as const;

export const betaSignupSchema = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().toLowerCase().email().max(160),
  platform: z.enum(PLATFORM_CHOICES),
  // Optional across the board: every extra required field costs signups, and
  // we can ask again by email.
  username: z.string().trim().max(60).optional().or(z.literal("")),
  rating: z.enum(RATING_CHOICES).optional(),
  goal: z.string().trim().max(400).optional().or(z.literal("")),
});

export type BetaSignupInput = z.infer<typeof betaSignupSchema>;

export interface BetaSignupResult {
  /** False when this address had already signed up. The caller thanks them either way. */
  created: boolean;
}

/** Empty strings arrive from untouched optional inputs; store null, not "". */
function nullIfBlank(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Upsert on email. Someone who signs up twice is telling us the same thing
 * twice, and the second answer is the fresher one, so it wins — but the row
 * keeps its original `created_at`, which is when they actually found us.
 */
export async function recordBetaSignup(input: BetaSignupInput): Promise<BetaSignupResult> {
  const rows = await client`
    insert into beta_signups (name, email, platform, username, rating, goal)
    values (
      ${input.name},
      ${input.email},
      ${input.platform},
      ${nullIfBlank(input.username)},
      ${input.rating ?? null},
      ${nullIfBlank(input.goal)}
    )
    on conflict (email) do update set
      name = excluded.name,
      platform = excluded.platform,
      username = coalesce(excluded.username, beta_signups.username),
      rating = coalesce(excluded.rating, beta_signups.rating),
      goal = coalesce(excluded.goal, beta_signups.goal)
    returning (xmax = 0) as inserted`;
  return { created: rows[0]?.inserted === true };
}

/**
 * Per-key fixed window. Deliberately small and in-process: this is a form on a
 * marketing page, not an auth endpoint, and the job is to stop a bored person
 * with a loop rather than to survive a botnet. A real flood is Cloudflare's
 * problem, one layer up.
 */
const WINDOW_MS = 60 * 60_000;
const MAX_PER_WINDOW = 5;
const hits = new Map<string, number[]>();

export function rateLimit(key: string): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((at) => now - at < WINDOW_MS);
  if (recent.length >= MAX_PER_WINDOW) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  // Bounded cleanup so a long-lived process does not accumulate a key per
  // visitor for the life of the deployment.
  if (hits.size > 5000) {
    for (const [k, times] of hits) {
      if (times.every((at) => now - at >= WINDOW_MS)) hits.delete(k);
    }
  }
  return true;
}
