/**
 * Decks: a measured pattern, in the shape you work through it.
 *
 * A deck is one concept in one role — "Taking what is offered · Execute",
 * "Forks · Recognise" — scoped to the phase it was counted in. It is the unit
 * the path is built from, and it exists because a statistic makes a good
 * *subject* for work even though it makes a terrible *grade*.
 *
 * ## The line this module holds
 *
 * **A statistic defines a deck. It never becomes a level.** Pattern difficulty
 * and role differ, so 96% at taking what is offered and 34% at converting a
 * winning position are not two ends of one ladder, and a bronze/silver/gold cut
 * across them would be a scale nobody published. PAGES.md forbids it and it
 * would be wrong even if it did not.
 *
 * So progression comes from **what the player has done**, never from how well
 * they play:
 *
 *   * `Review 2` and `Due again` come from the practice schedule, which is real
 *     stored state — an attempt advances it and a miss brings the position back
 *     sooner;
 *   * `Improving` and `Declined` come from the estimator's own published
 *     movement against this player's earlier games;
 *   * `New` means neither has anything to say yet, which is a fact rather than
 *     a zero.
 *
 * The evidence — handled, missed, set aside, the rate and its range — lives
 * inside the deck as evidence. It is what the deck is *about*, not a score on
 * it.
 *
 * ## The two grains, and why they are labelled apart
 *
 * The counts are this phase's: `/v1/phases/{phase}` publishes concept × role ×
 * phase as counts, and says in its own header that the estimator publishes no
 * posterior at that grain. The rate, its interval and the movement come from
 * the pooled cross-phase estimate in `/v1/dashboard`. They are different
 * denominators and the card says so rather than printing them as one figure.
 * When the estimator starts publishing per-phase posteriors this is the one
 * place that changes.
 */

import { MOVEMENT_COPY, movementOf, type Measure, type Movement } from "./dashboard";
import type { PhaseKey } from "./phases";
import { missesOf, rankedConcepts } from "./phases";
import type { PhaseConcept, PhaseDetail, PracticeItem } from "./types";

/**
 * The role, in one word.
 *
 * The wire sends `recognize | execute | respond | convert` and the server also
 * sends a long label ("Recognising the chance") which is right for a heading
 * and too long for the second half of a deck title. Deck titles read
 * "Forks · Recognise", so the role needs a single word in the product's own
 * spelling.
 */
const ROLE_WORD: Record<string, string> = {
  recognize: "Recognise",
  execute: "Execute",
  respond: "Respond",
  convert: "Convert",
};

export function roleWord(role: string | null): string | null {
  if (role === null) return null;
  return ROLE_WORD[role] ?? null;
}

/**
 * What a concept is called when there is room for a name and not a sentence.
 *
 * The catalogue's own labels are descriptions - "Attacking two things at
 * once", "A piece with nowhere to go", "Positions that decide the game" - and
 * they are right where a reader meets a measure once and needs it explained.
 * As the name of a stop on a path, repeated down a route, they read as
 * generated filler: a wall of similar-shaped sentences with no vocabulary in
 * them.
 *
 * So the path uses the name chess already has. That is DESIGN.md's rule
 * pointing the other way for once - **never invent a word for something chess
 * already names** - and a fork has been called a fork for four hundred years.
 * The description survives as the subtitle on the stop's own sheet, where
 * explaining is the job.
 *
 * Keyed by the catalogue's slug rather than its label, so a reworded
 * description does not silently drop a name. An unmapped concept keeps the
 * server's label, which is correct and merely long.
 */
const CONCEPT_NAME: Record<string, string> = {
  material_safety: "Hanging pieces",
  free_material: "Free material",
  only_move: "Only moves",
  critical_moment: "Critical moments",
  winning_conversion: "Conversion",
  worse_position_defence: "Defence",
  fork: "Forks",
  pin: "Pins",
  skewer: "Skewers",
  discovered_attack: "Discovered attacks",
  remove_defender: "Removing the defender",
  trapped_piece: "Trapped pieces",
};

export function conceptName(slug: string, fallback: string): string {
  return CONCEPT_NAME[slug] ?? fallback;
}

/** What the deck is called, in full: the pattern and the job. */
export function deckTitle(name: string, role: string | null): string {
  const word = roleWord(role);
  return word ? `${name} · ${word}` : name;
}

/**
 * Where the player stands in this deck.
 *
 * Never a grade. `from` names which real source produced the label, so a
 * screen can tell a schedule state apart from a measurement without parsing
 * the words.
 */
export interface DeckStage {
  label: string;
  from: "practice" | "movement" | "none";
  /** The tone class, matching the movement vocabulary the product already draws. */
  tone: string;
}

export interface DeckEvidence {
  /** Key moments handled in this phase. */
  handled: number;
  /** Key moments missed in this phase. */
  missed: number;
  /** Ended before the player was on move. Never a failure. */
  setAside: number;
  /** The denominator of the two above: moments the player was on move for. */
  seen: number;
}

/** The practice schedule for this deck, when the queue says which deck it is. */
export interface DeckReview {
  /** Attempts so far on the position standing for this deck. */
  reviewNumber: number;
  /** Whether something in this deck is due now. */
  due: boolean;
  /** How many queued positions belong to this deck. */
  items: number;
  /** Of those, how many are due now. */
  dueItems: number;
  /** Of those, how many have never been attempted. */
  fresh: number;
}

export interface Deck {
  /** `${slug}_${role}` — the key the catalogue and the estimates share. */
  key: string;
  /** The concept alone, without its role. */
  slug: string;
  phase: PhaseKey;
  /** The catalogue's name for the pattern, never a slug. A description. */
  name: string;
  /** The chess name, for a label with no room for a sentence. */
  shortName: string;
  role: string | null;
  /** The server's long label, for a heading that has room for it. */
  roleLabel: string | null;
  title: string;
  category: string | null;
  definition: string | null;
  evidence: DeckEvidence;
  /**
   * The published rate and its range, at this exact concept, role and phase.
   * Null when the estimator published no figure for this cell.
   */
  rate: number | null;
  intervalLow: number | null;
  intervalHigh: number | null;
  /**
   * True when the rate had to fall back to the pooled cross-phase figure.
   *
   * It used to be always true: `/v1/phases/{phase}` published counts and no
   * posterior, so a phase-scoped count sat beside a cross-phase percentage and
   * the card had to say so. The endpoint publishes `estimates` at this exact
   * grain now, so the honest case is the common one and this flags only the
   * remainder — a cell the estimator has not reached.
   */
  ratePooled: boolean;
  movement: Movement;
  /** The two windows behind the movement, or null with only one window. */
  change: { from: number; to: number } | null;
  /** The position this pattern last went wrong in, when one was published. */
  example: PhaseConcept["example"];
  review: DeckReview | null;
  stage: DeckStage;
}

/**
 * The stage, from the two real sources and in that order.
 *
 * Practice first: it is what the player did, it is the most recent thing that
 * happened, and it is the only one of the two that moves between publications.
 * Movement second, because it is a measurement rather than an action. `New`
 * last, and it is honest — a deck nobody has practised and the estimator has
 * not yet compared has no progress to report.
 */
export function deckStage(movement: Movement, review: DeckReview | null): DeckStage {
  if (review && review.due) {
    return { label: "Due again", from: "practice", tone: "is-due" };
  }
  if (review && review.reviewNumber > 0) {
    return { label: `Review ${review.reviewNumber}`, from: "practice", tone: "is-review" };
  }
  if (movement !== "unclear") {
    return { label: MOVEMENT_COPY[movement].label, from: "movement", tone: MOVEMENT_COPY[movement].tone };
  }
  return { label: "New", from: "none", tone: "is-new" };
}

/**
 * Which queued positions belong to which deck.
 *
 * Returns an empty map today, and that is the honest answer rather than a
 * guess: `/v1/practice/queue` publishes `fen`, `prompt` and a rendered
 * `reason` sentence, and carries no concept, role or phase — so nothing in the
 * payload says which deck a drill came from. Parsing the reason prose to find
 * out would be inventing an attribution the API did not make, and it would
 * silently mis-file drills the moment that sentence is reworded.
 *
 * The seam is here so that the day the queue publishes `conceptSlug`, `role`
 * and `phase`, this function fills in and every deck gains `Review 2` and
 * `Due again` with no other change anywhere.
 */
export function reviewsByDeck(items: readonly PracticeItem[]): Map<string, DeckReview> {
  const out = new Map<string, DeckReview>();
  for (const item of items) {
    // A legacy assignment has no provenance and cannot be attributed to a
    // deck. It is skipped rather than guessed at: filing somebody's drill
    // under the wrong pattern is worse than not filing it at all.
    if (!item.conceptSlug || !item.role || !item.phase) continue;
    const key = deckKey(item.phase, item.conceptSlug, item.role);
    const seen = out.get(key);
    const due = item.dueAt === null || Date.parse(item.dueAt) <= Date.now();
    out.set(key, {
      // The highest review number of the positions in this deck. It is not a
      // level for the deck itself: a review number belongs to one position,
      // and a deck-level progression would need a model nobody has published.
      reviewNumber: Math.max(seen?.reviewNumber ?? 0, item.reviewNumber ?? 0),
      due: (seen?.due ?? false) || due,
      items: (seen?.items ?? 0) + 1,
      dueItems: (seen?.dueItems ?? 0) + (due ? 1 : 0),
      fresh: (seen?.fresh ?? 0) + (item.reviewNumber === 0 ? 1 : 0),
    });
  }
  return out;
}

/** Decks are keyed by phase too: the same pattern in two phases is two decks. */
export function deckKey(phase: string, slug: string, role: string): string {
  return `${phase}:${slug}_${role}`;
}

/**
 * Every deck in one phase, the ones costing most first.
 *
 * The order is `rankedConcepts`': by misses, not by rate. A rate ranking would
 * put whichever pattern happens to be hardest at the top of everybody's path
 * and call it their weakness. Decks with nothing observed are dropped — a deck
 * with no evidence has nothing to work through and nothing to say.
 */
export function decksForPhase(
  phase: PhaseKey,
  detail: PhaseDetail | null,
  measuresByKey: Map<string, Measure>,
  reviews: Map<string, DeckReview> = new Map(),
): Deck[] {
  if (detail === null) return [];

  return rankedConcepts(detail.concepts)
    .filter((concept) => concept.observed > 0)
    .map((concept): Deck => {
      const key = deckKey(phase, concept.slug, concept.role);
      const measure = measuresByKey.get(`${concept.slug}_${concept.role}`) ?? null;
      const review = reviews.get(key) ?? null;

      // The estimator's own rows for this exact cell, preferred over the
      // pooled measure in every case it publishes one.
      const scoped = pickEstimates(concept.estimates ?? []);
      const rate = scoped.headline?.estimate ?? measure?.rate ?? null;
      const pooled = scoped.headline?.estimate == null && measure?.rate != null;
      const change =
        scoped.recent && scoped.baseline &&
        scoped.recent.estimate !== null && scoped.baseline.estimate !== null
          ? { from: scoped.baseline.estimate, to: scoped.recent.estimate }
          : measure?.change
            ? { from: measure.change.from, to: measure.change.to }
            : null;
      const movement = scoped.recent
        ? movementOf(scoped.recent.improvementProbability)
        : measure?.change?.movement ?? "unclear";

      return {
        key,
        slug: concept.slug,
        phase,
        name: concept.label,
        shortName: conceptName(concept.slug, concept.label),
        role: concept.role,
        roleLabel: concept.roleLabel,
        title: deckTitle(concept.label, concept.role),
        category: concept.category,
        definition: concept.definition,
        evidence: {
          handled: concept.taken,
          missed: missesOf(concept),
          setAside: concept.setAside,
          seen: concept.observed,
        },
        rate,
        intervalLow: scoped.headline?.intervalLow ?? (pooled ? measure?.intervalLow ?? null : null),
        intervalHigh: scoped.headline?.intervalHigh ?? (pooled ? measure?.intervalHigh ?? null : null),
        ratePooled: pooled,
        movement,
        change,
        example: concept.example,
        review,
        stage: deckStage(movement, review),
      };
    });
}

type ConceptEstimate = NonNullable<PhaseConcept["estimates"]>[number];

/**
 * The rows this cell needs, out of everything the estimator published for it.
 *
 * `objective` over the lifetime is the standing figure a reader means by "how
 * often do I do this"; the `personal_current` pair is the same player against
 * their own earlier games, which is the one comparison the estimator says is
 * valid and the only thing allowed to colour a mark.
 */
function pickEstimates(rows: readonly ConceptEstimate[]) {
  const find = (frame: string, window: string) =>
    rows.find((row) => row.frame === frame && row.windowKind === window) ?? null;
  return {
    headline: find("objective", "lifetime") ?? find("personal_current", "lifetime"),
    recent: find("personal_current", "recent_form"),
    baseline: find("personal_current", "lifetime"),
  };
}

/** The measures, keyed the way a concept row keys itself. */
export function measureIndex(all: readonly Measure[]): Map<string, Measure> {
  return new Map(all.map((measure) => [measure.baseKey, measure]));
}
