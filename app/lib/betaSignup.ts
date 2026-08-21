import { v1Data } from "./v1/client";
import { ProblemError } from "./v1/problem";
import type { PublicBetaSignupBody } from "./v1/types";

/**
 * The landing page's beta signup, on `POST /v1/public/beta-signups`.
 *
 * It used to post to the prototype's `/beta-signups`, which is about to be
 * deleted along with the rest of that surface. The versioned route stores the
 * same row; what changed is the contract around it. Two differences matter to
 * this file:
 *
 *   * the field is `ratingBand`, because the value has always been a band and
 *     the contract finally names it that;
 *   * the response is `{ accepted: true }` on every path. The old route
 *     answered `{ created }`, which told an anonymous caller whether an address
 *     was already on the list. Nothing here returns a value, so no caller can
 *     start branching on one again.
 */

export const PLATFORMS = [
  { value: "lichess", label: "Lichess" },
  { value: "chesscom", label: "Chess.com" },
  { value: "both", label: "Both" },
  { value: "otb", label: "Over the board" },
] as const;

export const RATINGS = [
  { value: "under-1000", label: "Under 1000" },
  { value: "1000-1400", label: "1000–1400" },
  { value: "1400-1800", label: "1400–1800" },
  { value: "1800-2200", label: "1800–2200" },
  { value: "over-2200", label: "2200+" },
  { value: "unrated", label: "Not sure" },
] as const;

export type Platform = PublicBetaSignupBody["platform"];
export type RatingBand = NonNullable<PublicBetaSignupBody["ratingBand"]>;

export interface BetaSignup {
  name: string;
  email: string;
  platform: Platform;
  username?: string;
  ratingBand?: RatingBand;
  goal?: string;
}

/**
 * Throws with a message meant to be shown to the person who just typed their
 * email in, so every branch says what to do next rather than what went wrong
 * internally.
 *
 * No idempotency key is passed, so `v1()` mints one per call. That is the right
 * reading of "one key per user intent" here: the form blocks a second submit
 * while the first is in flight, and a person who corrects a typo and presses
 * again means a *different* request, which reusing the key would turn into a
 * 409 rather than a signup.
 */
export async function submitBetaSignup(input: BetaSignup): Promise<void> {
  // Empty optional fields are dropped rather than sent as "". The contract
  // accepts them either way, but a stored row with an empty goal reads as a
  // person who answered nothing, which is what happened.
  const body: PublicBetaSignupBody = {
    name: input.name,
    email: input.email,
    platform: input.platform,
    ...(input.username ? { username: input.username } : {}),
    ...(input.ratingBand ? { ratingBand: input.ratingBand } : {}),
    ...(input.goal ? { goal: input.goal } : {}),
  };

  try {
    await v1Data<{ accepted: true }>("/v1/public/beta-signups", { json: body, anonymous: true });
  } catch (error) {
    if (error instanceof Response) throw error; // a redirect must propagate
    if (!(error instanceof ProblemError)) {
      throw new Error("Could not reach us. Check your connection and try again.");
    }
    if (error.is("RATE_LIMITED")) {
      throw new Error("That is a lot of signups from one place. Try again in an hour.");
    }
    if (error.is("VALIDATION_FAILED")) {
      throw new Error("Something in that form did not look right. Check your email address.");
    }
    throw new Error("We could not save that. Try again in a moment.");
  }
}
