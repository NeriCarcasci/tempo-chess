import { betaCdf } from "./beta.js";
import { SPECIFICITY_POLICY, type SpecificityPolicy } from "./contract.js";

/**
 * Where a finding happens, and whether it is honest to say so.
 *
 * "You miss the only move 5% of the time" is trivia. "In the Scotch, around
 * move 7, you have had fourteen of these and got four right" is something a
 * player can act on this evening. The difference is a location, and a location
 * is a second claim — one this module either earns from the evidence or
 * refuses.
 *
 * ## The thing that makes a naive version lie
 *
 * Roughly two thirds of everything the detectors record happens in the
 * middlegame, because that is where most moves are. A report that named the
 * modal phase would tell nearly every player that their problem is in the
 * middlegame, which is true of the *chances* and says nothing about the
 * *player*. So a category is never judged on its own share. It is judged
 * against how the same player's chances at the same concept are distributed:
 * the claim is not "most of your misses are here", it is "more of your misses
 * are here than your chances are".
 *
 * Three guards, all of which must pass, and each of which fails a different
 * bad claim:
 *
 *   - **A floor on the count and the subset size.** Three of four is not a
 *     concentration however striking it looks.
 *   - **A floor on relative risk.** The category's share among the failures,
 *     divided by its share among the chances, is how much likelier the player
 *     is to go wrong there than they are anywhere. A ratio of 1 means the
 *     failures fall exactly where the chances do, and that is what stops "your
 *     problem is the middlegame" from being printed at every player who plays
 *     middlegames.
 *   - **A binomial tail test against that baseline.** With the lift real, this
 *     asks whether a sample this size could have produced it by chance.
 *
 * ## Why the move bands are fixed
 *
 * A band chosen to fit the data always exists: pick any run of failures and
 * there is a window containing most of them. That is the forking-paths problem
 * in its purest form, and the tail test would be computed against a null the
 * search had already invalidated. Five fixed bands are tested, always the same
 * five, so the test means what it says. The cost is resolution — a cluster at
 * moves 11 to 13 is reported as "between move 11 and move 20" — and the
 * observed edges are carried alongside so a screen can be sharper than the
 * sentence without the sentence overstating.
 *
 * Everything here is pure. Whether a concentration exists is decidable from a
 * list of moments, so `estimates:unit` exhausts it without a database.
 */

export type Phase = "opening" | "middlegame" | "endgame";

/**
 * One recorded chance, flattened into what a location claim needs.
 *
 * A censored chance is carried rather than dropped so that the caller can
 * report how many there were. It is never part of a subset a claim is made
 * from: §17.5 and `tallyObservations` both treat an unobserved response as no
 * evidence, and a location computed over silence would be a location for
 * something the player never did.
 */
export interface Moment {
  readonly gameId: string;
  /** Zero-based ply of the chance, as `concept_opportunities.opportunity_ply`. */
  readonly ply: number;
  readonly phase: Phase | null;
  /** The opening family of the game this happened in, when the catalogue names one. */
  readonly openingFamily: string | null;
  readonly occurredAt: Date;
  readonly censored: boolean;
  /** Null exactly when censored. */
  readonly success: boolean | null;
  readonly playedMoveUci: string | null;
  readonly bestMoveUci: string | null;
  /**
   * The `analysis.evidence_items` row this chance was recorded as.
   *
   * Carried so that the moment a finding shows is the evidence row that finding
   * cites. Before this, `aggregate.ts` attached whichever evidence item of the
   * game sorted first, so a report could name move 23 and link to a row about
   * move 4 — and the audit trail that is supposed to make a claim checkable
   * pointed somewhere else.
   */
  readonly evidenceItemId: string | null;
  /** Ply of the move that left the opening book, in this game. */
  readonly departurePly: number | null;
  readonly openingName: string | null;
}

export type ConcentrationKind = "phase" | "move_band" | "opening_family";

export interface Concentration {
  readonly kind: ConcentrationKind;
  /** The bucket's stable identity, for an operator. */
  readonly key: string;
  /** Reader-facing: "the middlegame", "moves 11 to 20", "the Sicilian Defense". */
  readonly label: string;
  /** Moments of the subset that fall here. */
  readonly count: number;
  /** Moments of the subset that could be placed in any bucket of this kind. */
  readonly total: number;
  /** The same bucket's share among all of this concept's chances. */
  readonly baselineShare: number;
  /** P(at least `count` of `total` land here, if the subset were spread like the chances). */
  readonly tailProbability: number;
  /** Move numbers, for the band kind. `high` is null on the open-ended band. */
  readonly moveBand: { readonly low: number; readonly high: number | null } | null;
  /** The narrowest move numbers actually observed inside the bucket. */
  readonly observedMoveLow: number;
  readonly observedMoveHigh: number;
}

/** Move number, from a zero-based ply. Ply 0 and ply 1 are both move 1. */
export function moveNumberOf(ply: number): number {
  return Math.floor(ply / 2) + 1;
}

/** Whose move it was. Ply 0 is White's. */
export function sideOf(ply: number): "white" | "black" {
  return ply % 2 === 0 ? "white" : "black";
}

/**
 * The bands a move number is tested against.
 *
 * Ten-move blocks because that is how players already talk about a game, and
 * an open last band because a report that stopped at move 40 would have
 * nothing to say about the endgames that are exactly where conversion lives.
 */
export const MOVE_BANDS: readonly { readonly low: number; readonly high: number | null }[] =
  Object.freeze([
    { low: 1, high: 10 },
    { low: 11, high: 20 },
    { low: 21, high: 30 },
    { low: 31, high: 40 },
    { low: 41, high: null },
  ]);

function bandOf(moveNumber: number): { low: number; high: number | null } | null {
  for (const band of MOVE_BANDS) {
    if (moveNumber >= band.low && (band.high === null || moveNumber <= band.high)) return band;
  }
  return null;
}

function bandKey(band: { low: number; high: number | null }): string {
  return band.high === null ? `${band.low}+` : `${band.low}-${band.high}`;
}

function bandLabel(band: { low: number; high: number | null }): string {
  return band.high === null
    ? `move ${band.low} onwards`
    : `moves ${band.low} to ${band.high}`;
}

const PHASE_LABELS: Readonly<Record<Phase, string>> = Object.freeze({
  opening: "the opening",
  middlegame: "the middlegame",
  endgame: "the endgame",
});

/** What a phase is called in a sentence. */
export function phaseLabel(phase: Phase): string {
  return PHASE_LABELS[phase];
}

/**
 * Whether an opening family may be named in prose.
 *
 * `render.ts` holds back any text carrying a number the structured input does
 * not support, and it cannot tell a move count from the "4" in "Ruy Lopez,
 * Berlin Defense, 4.O-O". Rather than loosen that check so that digits inside
 * a quoted string are waved through — which would also wave through digits in
 * a game id or a provider URL — a family with a digit in it simply does not
 * become a location. The catalogue's family names are the text before the
 * first colon, so in practice this never fires; when it does, the finding
 * loses one clause and keeps every fact.
 */
function familyIsQuotable(family: string): boolean {
  return family.trim().length > 0 && !/\d/.test(family);
}

/**
 * `P(X >= k)` for `k` successes in `n` trials at rate `p`.
 *
 * The regularized incomplete beta is the binomial tail exactly —
 * `P(X >= k | n, p) = I_p(k, n - k + 1)` — so this reuses the same
 * continued-fraction implementation the credible intervals are built on rather
 * than adding a second numeric path that could disagree with it.
 */
export function binomialUpperTail(k: number, n: number, p: number): number {
  if (k <= 0) return 1;
  if (k > n) return 0;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  return betaCdf(p, k, n - k + 1);
}

interface Bucket {
  key: string;
  label: string;
  count: number;
  band: { low: number; high: number | null } | null;
  moveLow: number;
  moveHigh: number;
}

type Placer = (moment: Moment) => { key: string; label: string; band: { low: number; high: number | null } | null } | null;

const PLACERS: readonly { kind: ConcentrationKind; place: Placer }[] = [
  {
    kind: "phase",
    place: (moment) =>
      moment.phase === null
        ? null
        : { key: moment.phase, label: PHASE_LABELS[moment.phase], band: null },
  },
  {
    kind: "move_band",
    place: (moment) => {
      const band = bandOf(moveNumberOf(moment.ply));
      return band === null ? null : { key: bandKey(band), label: bandLabel(band), band };
    },
  },
  {
    kind: "opening_family",
    place: (moment) =>
      moment.openingFamily !== null && familyIsQuotable(moment.openingFamily)
        ? { key: moment.openingFamily, label: `the ${moment.openingFamily}`, band: null }
        : null,
  },
];

function tally(moments: readonly Moment[], place: Placer): { buckets: Map<string, Bucket>; placed: number } {
  const buckets = new Map<string, Bucket>();
  let placed = 0;
  for (const moment of moments) {
    const slot = place(moment);
    if (slot === null) continue;
    placed += 1;
    const move = moveNumberOf(moment.ply);
    const existing = buckets.get(slot.key);
    if (existing) {
      existing.count += 1;
      existing.moveLow = Math.min(existing.moveLow, move);
      existing.moveHigh = Math.max(existing.moveHigh, move);
    } else {
      buckets.set(slot.key, {
        key: slot.key,
        label: slot.label,
        count: 1,
        band: slot.band,
        moveLow: move,
        moveHigh: move,
      });
    }
  }
  return { buckets, placed };
}

/**
 * The one location a finding may name, or null.
 *
 * `subject` is the evidence the finding is actually about — the failures behind
 * a miss, the successes behind a strength — and `reference` is every uncensored
 * chance at the same concept. The two are deliberately different populations:
 * asking whether the subject is distributed like the reference is the only
 * version of this question whose answer is about the player.
 *
 * At most one location is returned even when several qualify, because three
 * qualifying locations are three views of one cluster — failures at move 7 in
 * the Scotch are also failures in the opening — and printing all three would
 * read as three findings. The most surprising one wins, with the kind order as
 * a deterministic tie-break so two runs over one snapshot never disagree.
 */
export function findConcentration(
  subject: readonly Moment[],
  reference: readonly Moment[],
  policy: SpecificityPolicy = SPECIFICITY_POLICY,
): Concentration | null {
  if (subject.length < policy.minSubjectSize) return null;

  const found: Concentration[] = [];
  for (const { kind, place } of PLACERS) {
    const subjectSide = tally(subject, place);
    // Most of the subset has to be placeable, or the buckets describe a
    // minority and the share is computed over the wrong denominator. A concept
    // whose phase the classifier could not label is not a concept with no
    // location; it is one we cannot speak about.
    if (subjectSide.placed < policy.minSubjectSize) continue;
    const referenceSide = tally(reference, place);
    if (referenceSide.placed === 0) continue;

    for (const bucket of subjectSide.buckets.values()) {
      if (bucket.count < policy.minBucketCount) continue;
      const share = bucket.count / subjectSide.placed;
      if (share < policy.minShare) continue;
      const baselineShare = (referenceSide.buckets.get(bucket.key)?.count ?? 0) / referenceSide.placed;
      // Everything happens here anyway. Naming it would be a fact about chess,
      // not about this player, and the sentence would be worse than silence.
      if (baselineShare >= policy.maxBaselineShare) continue;
      // Relative risk: how much likelier this bucket is to hold a failure than
      // it is to hold a chance. A bucket that holds the failures in exactly the
      // proportion it holds the chances has a ratio of 1 and says nothing about
      // the player.
      if (baselineShare <= 0 || share / baselineShare < policy.minLiftRatio) continue;
      const tailProbability = binomialUpperTail(bucket.count, subjectSide.placed, baselineShare);
      if (tailProbability > policy.maxTailProbability) continue;
      found.push({
        kind,
        key: bucket.key,
        label: bucket.label,
        count: bucket.count,
        total: subjectSide.placed,
        baselineShare,
        tailProbability,
        moveBand: bucket.band,
        observedMoveLow: bucket.moveLow,
        observedMoveHigh: bucket.moveHigh,
      });
    }
  }

  if (found.length === 0) return null;
  const kindOrder: Record<ConcentrationKind, number> = {
    opening_family: 0,
    move_band: 1,
    phase: 2,
  };
  found.sort(
    (a, b) =>
      a.tailProbability - b.tailProbability ||
      kindOrder[a.kind] - kindOrder[b.kind] ||
      a.key.localeCompare(b.key),
  );
  return found[0]!;
}

/**
 * Whether the subject was large enough for the question to have been asked.
 *
 * A report that says "these are spread out rather than bunched" has made a
 * claim, and it is only true if we looked. Below the floor nothing was tested
 * and the honest report says nothing either way.
 */
export function concentrationWasExamined(
  subject: readonly Moment[],
  policy: SpecificityPolicy = SPECIFICITY_POLICY,
): boolean {
  return subject.length >= policy.minSubjectSize;
}

/**
 * One real moment to show, chosen without a coin.
 *
 * Restricted to the concentration when there is one, because an example from
 * somewhere else would quietly contradict the sentence above it. Most recent
 * first: a habit the player had in March and dropped in April is a worse thing
 * to show them than the one they had last week, and the ordering is total —
 * game id then ply — so a rerun over the same snapshot picks the same moment.
 */
export function pickExample(
  subject: readonly Moment[],
  concentration: Concentration | null,
): Moment | null {
  const pool =
    concentration === null
      ? subject
      : subject.filter((moment) => inConcentration(moment, concentration));
  const candidates = pool.length > 0 ? pool : subject;
  if (candidates.length === 0) return null;
  return [...candidates].sort(
    (a, b) =>
      b.occurredAt.getTime() - a.occurredAt.getTime() ||
      a.gameId.localeCompare(b.gameId) ||
      a.ply - b.ply,
  )[0]!;
}

function inConcentration(moment: Moment, concentration: Concentration): boolean {
  switch (concentration.kind) {
    case "phase":
      return moment.phase === concentration.key;
    case "opening_family":
      return moment.openingFamily === concentration.key;
    case "move_band": {
      const band = concentration.moveBand;
      if (band === null) return false;
      const move = moveNumberOf(moment.ply);
      return move >= band.low && (band.high === null || move <= band.high);
    }
  }
}

/** The uncensored moments a claim about failure rests on. */
export function failuresOf(moments: readonly Moment[]): Moment[] {
  return moments.filter((moment) => !moment.censored && moment.success === false);
}

/** The uncensored moments a claim about success rests on. */
export function successesOf(moments: readonly Moment[]): Moment[] {
  return moments.filter((moment) => !moment.censored && moment.success === true);
}

/** Everything that is evidence at all. Censored chances are not. */
export function observedOf(moments: readonly Moment[]): Moment[] {
  return moments.filter((moment) => !moment.censored);
}
