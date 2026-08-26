/**
 * Whether this person has been shown how Forma works.
 *
 * localStorage rather than the database, for the same reason the active account
 * lives there: it is a per-device view preference, not account state. There is
 * no `/v1` field for "has seen the introduction" and inventing one would mean a
 * migration, a route and a write on a path whose whole point is that it does not
 * block on the network.
 *
 * The cost is honest and small: somebody who signs in on a second device sees
 * the four cards once more. That is a better failure than the alternative, which
 * is a person who cleared their storage being permanently unable to read them
 * again, or a first paint that waits on a round trip to decide whether to draw a
 * modal.
 *
 * Keyed by profile id so two people sharing a browser do not inherit each
 * other's answer.
 */

const KEY = "tempo.primerSeen";

export function primerSeen(userId: string): boolean {
  try {
    return localStorage.getItem(`${KEY}.${userId}`) === "1";
  } catch {
    // Private mode, or storage disabled. Treating that as "already seen" is the
    // quiet failure: the introduction is worth showing once and never worth
    // showing on every single load, and a browser that cannot remember the
    // answer would do exactly that.
    return true;
  }
}

export function markPrimerSeen(userId: string): void {
  try {
    localStorage.setItem(`${KEY}.${userId}`, "1");
  } catch {
    /* nothing to do: the modal has already been read either way */
  }
}
