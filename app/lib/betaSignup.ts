import { apiFetch } from "./api";

/**
 * The landing page's beta signup. Posts to the one public write endpoint we
 * have; see server/src/beta.ts for what happens to the row.
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

export interface BetaSignup {
  name: string;
  email: string;
  platform: string;
  username?: string;
  rating?: string;
  goal?: string;
}

export interface BetaSignupResult {
  created: boolean;
}

/**
 * Throws with a message meant to be shown to the person who just typed their
 * email in, so every branch says what to do next rather than what went wrong
 * internally.
 */
export async function submitBetaSignup(input: BetaSignup): Promise<BetaSignupResult> {
  let response: Response;
  try {
    response = await apiFetch("/beta-signups", { json: input, anonymous: true });
  } catch {
    throw new Error("Could not reach us. Check your connection and try again.");
  }
  if (response.ok) return (await response.json()) as BetaSignupResult;
  if (response.status === 429) {
    throw new Error("That is a lot of signups from one place. Try again in an hour.");
  }
  if (response.status === 400) {
    throw new Error("Something in that form did not look right. Check your email address.");
  }
  throw new Error("We could not save that. Try again in a moment.");
}
