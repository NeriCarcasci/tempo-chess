/**
 * Who is allowed into the product, expressed as data.
 *
 * Forma is in closed beta: authenticating proves who someone is, and says
 * nothing about whether they may use anything. The two questions were the same
 * question until 0039, which is why this module exists — the gate has to be
 * describable in one place, or it becomes forty `if` statements that disagree.
 *
 * Nothing here touches the database. `service.ts` does that; this is the shape
 * both the API and its tests agree on.
 */

/** The three answers `app.access_requests.state` may hold. */
export const ACCESS_STATES = ["pending", "approved", "declined"] as const;
export type AccessState = (typeof ACCESS_STATES)[number];

/** The two an operator may write. `pending` is where a row starts, not a verdict. */
export const ACCESS_DECISIONS = ["approved", "declined"] as const;
export type AccessDecision = (typeof ACCESS_DECISIONS)[number];

export function isAccessDecision(value: string): value is AccessDecision {
  return (ACCESS_DECISIONS as readonly string[]).includes(value);
}

/**
 * The longest note we will store.
 *
 * Long enough for the paragraph that actually helps a decision — where they
 * play, what they are trying to fix — and short enough that the column is not a
 * place to paste an archive into. A rejected note is a validation failure with
 * the limit named, never a silent truncation: someone who wrote four hundred
 * words and had them cut in half would never know which half we read.
 */
export const MAX_NOTE_LENGTH = 1000;

/** The same, for the sentence an operator attaches to their own decision. */
export const MAX_DECISION_NOTE_LENGTH = 500;

export interface AccessRequest {
  userId: string;
  state: AccessState;
  note: string | null;
  requestedAt: string;
  noteUpdatedAt: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
}

/**
 * Whether this state may reach the product.
 *
 * A single function rather than `state === "approved"` scattered about, because
 * the interesting case is the one a fourth state would introduce: adding
 * `suspended` later should be a change here and nowhere else. Written as an
 * allowlist for the same reason — a new state is denied until somebody decides
 * it should not be, which is the safe direction for an access check.
 */
export function grantsProductAccess(state: AccessState): boolean {
  return state === "approved";
}

/**
 * What the person is told, per state.
 *
 * Kept beside the states rather than in the route, so the API and the screen
 * cannot describe the same situation differently. Plain sentences, no
 * em-dashes: DESIGN.md's copy rules apply to anything a person reads, and a
 * problem document is read by a person more often than the name suggests.
 */
export function accessDetail(state: AccessState): string {
  switch (state) {
    case "pending":
      // Deliberately does not say "shortly". A promise about timing that we
      // then miss is worse than no promise, and this queue is read by a person.
      return "Forma is in closed beta. Your request is with us and you will hear when it has been looked at.";
    case "declined":
      return "Your request for access was not accepted.";
    case "approved":
      // Unreachable through the gate, and present so the switch is total: a
      // missing branch here would be a `undefined` in a problem document.
      return "Your account has access.";
  }
}
