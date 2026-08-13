/**
 * Beta feedback we are allowed to quote.
 *
 * Rules, and they are not negotiable (DESIGN.md, "Public copy rules"):
 *
 * 1. Every entry is something a real person actually wrote to us.
 * 2. They said yes to it appearing on the site, in the wording shown.
 * 3. `quote` is their sentence. Trim for length with a leading or trailing
 *    ellipsis; never reword, never merge two messages into one.
 * 4. Attribution is whatever they agreed to. `handle` is their platform
 *    username, so a reader can check the person exists.
 *
 * Empty is the correct state until the first tester replies. The section
 * renders nothing at all rather than showing placeholders.
 */

export interface Review {
  /** Their words. */
  quote: string;
  /** How they asked to be credited. */
  name: string;
  /** Platform username, if they were happy to be named by it. */
  handle?: string;
  platform?: "lichess" | "chesscom";
  /** Rating at the time, if they mentioned it. Context, not a claim by us. */
  rating?: number;
  /** ISO date we received it. */
  at: string;
}

export const REVIEWS: Review[] = [];
