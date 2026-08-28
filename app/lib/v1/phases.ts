/**
 * The phase pages' read: `GET /v1/phases/{phase}`.
 *
 * The endpoint reads through the same live-publication pointer as
 * `/v1/dashboard`, so everything here agrees with the phase card on the hub by
 * construction: same frozen snapshot, same date, and the concept counts sum to
 * the card's chances. What this module adds is ordering and words — nothing
 * that computes a new statistic about a player.
 */

import { v1 } from "./client";
import { ProblemError } from "./problem";
import type { PhaseConcept, PhaseDetail } from "./types";

export type PhaseKey = "opening" | "middlegame" | "endgame";

/**
 * The detail, or null when nothing has been published yet.
 *
 * A 404 covers "no subject" and "no publication" alike, exactly as the
 * dashboard's does, and both read as a page state rather than an error.
 */
export async function getPhaseDetail(phase: PhaseKey): Promise<PhaseDetail | null> {
  try {
    return (await v1<PhaseDetail>(`/v1/phases/${phase}`)).data;
  } catch (error) {
    if (error instanceof Response) throw error;
    if (error instanceof ProblemError && error.status === 404) return null;
    throw error;
  }
}

/** A concept row's misses, the number the stack is ordered by. */
export function missesOf(concept: PhaseConcept): number {
  return concept.observed - concept.taken;
}

/**
 * The concept split, most costly first.
 *
 * Ordered by misses rather than by share: shares over two chances and two
 * hundred are not a ranking, and the page's question is "where do I give the
 * most away in this phase", which a count answers and a rate does not. Rows
 * nothing was observed in sort last, because there is nothing to rank them by.
 */
export function rankedConcepts(concepts: readonly PhaseConcept[]): PhaseConcept[] {
  return [...concepts].sort((a, b) => {
    if (a.observed === 0 !== (b.observed === 0)) return a.observed === 0 ? 1 : -1;
    const misses = missesOf(b) - missesOf(a);
    if (misses !== 0) return misses;
    return b.observed - a.observed;
  });
}

/**
 * The heaviest run of consecutive move numbers, for the histogram's headline.
 *
 * The same window idea the opening shape uses: a run of up to `width` adjacent
 * moves holding the largest share of the phase's misses. Null when the phase
 * has no misses at all, which is a different sentence.
 */
export function missPeak(
  bins: readonly PhaseDetail["missesByMove"][number][],
  width = 5,
): { from: number; to: number; missed: number; share: number } | null {
  const total = bins.reduce((sum, bin) => sum + bin.missed, 0);
  if (total === 0) return null;
  const sorted = [...bins].sort((a, b) => a.moveNumber - b.moveNumber);
  let best: { from: number; to: number; missed: number } | null = null;
  for (let start = 0; start < sorted.length; start += 1) {
    const from = sorted[start]!.moveNumber;
    let missed = 0;
    for (let index = start; index < sorted.length; index += 1) {
      const bin = sorted[index]!;
      if (bin.moveNumber - from >= width) break;
      missed += bin.missed;
      if (best === null || missed > best.missed) {
        best = { from, to: bin.moveNumber, missed };
      }
    }
  }
  return best === null ? null : { ...best, share: best.missed / total };
}
