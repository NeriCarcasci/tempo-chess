/**
 * The base family behind an opening name.
 *
 * Two platforms, two naming styles. Lichess writes
 * "Caro-Kann Defense: Two Knights Attack"; Chess.com derives its name from the
 * ECO URL and writes "Caro Kann Defense Two Knights Attack" with no colon at
 * all. Splitting on ":" — which is what the dashboard did — leaves every
 * Chess.com variation as its own row, so a player with three games appeared to
 * have three unrelated openings rather than two Caro-Kanns.
 *
 * So we match the front of the name against families instead. Both platforms
 * put the family first, which is the one thing they agree on.
 */

/**
 * The families a player actually thinks in. Anything outside this list is
 * bucketed as "Other" rather than given a row of its own: a single game of the
 * Van 't Kruijs Opening is noise on a chart about where your results come from,
 * and it is still there under the fold if you want it.
 */
const FAMILIES = [
  "Sicilian Defense",
  "French Defense",
  "Caro-Kann Defense",
  "Scandinavian Defense",
  "Pirc Defense",
  "Modern Defense",
  "Alekhine Defense",
  "Nimzowitsch Defense",
  "Owen Defense",
  "Ruy Lopez",
  "Spanish Game",
  "Italian Game",
  "Giuoco Piano",
  "Two Knights Defense",
  "Evans Gambit",
  "Scotch Game",
  "Four Knights Game",
  "Petrov's Defense",
  "Russian Game",
  "Philidor Defense",
  "Vienna Game",
  "Bishop's Opening",
  "King's Gambit",
  "Center Game",
  "Danish Gambit",
  "Ponziani Opening",
  "Queen's Gambit Declined",
  "Queen's Gambit Accepted",
  "Queen's Gambit",
  "Slav Defense",
  "Semi-Slav Defense",
  "Tarrasch Defense",
  "Albin Countergambit",
  "Budapest Gambit",
  "King's Indian Defense",
  "Nimzo-Indian Defense",
  "Queen's Indian Defense",
  "Bogo-Indian Defense",
  "Old Indian Defense",
  "Grunfeld Defense",
  "Benoni Defense",
  "Benko Gambit",
  "Dutch Defense",
  "Catalan Opening",
  "London System",
  "Trompowsky Attack",
  "Torre Attack",
  "Colle System",
  "English Opening",
  "Reti Opening",
  "Bird Opening",
  "Nimzowitsch-Larsen Attack",
  "King's Pawn Game",
  "Queen's Pawn Game",
] as const;

/** Where anything unrecognised goes. */
export const OTHER_FAMILY = "Other";

/**
 * Lowercased, punctuation flattened to single spaces. Turns "Caro-Kann",
 * "Caro Kann" and "caro kann" into one key, and does the same for the
 * apostrophes that "Queen's" and "Petrov's" disagree about across sources.
 */
function normalise(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Longest first, so "Queen's Gambit Declined" wins over "Queen's Gambit". */
const MATCHERS = FAMILIES.map((display) => ({ display, key: normalise(display) })).sort(
  (a, b) => b.key.length - a.key.length,
);

/**
 * The family this opening belongs to, or null when it is not one we chart.
 *
 * Null is a real answer, not a failure: the caller buckets it into "Other".
 */
export function openingFamily(name: string | null | undefined): string | null {
  if (!name?.trim()) return null;

  // Lichess puts the family before a colon, so trust that when it is there.
  const head = name.split(":")[0]!.trim();
  const key = normalise(head);
  if (!key) return null;

  for (const { display, key: matcher } of MATCHERS) {
    if (key === matcher || key.startsWith(`${matcher} `)) return display;
  }
  return null;
}

/** The family, or "Other" — for callers that want a bucket rather than null. */
export function openingFamilyOrOther(name: string | null | undefined): string {
  return openingFamily(name) ?? OTHER_FAMILY;
}
