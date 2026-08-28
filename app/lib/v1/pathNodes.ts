/**
 * The stops on a phase's path.
 *
 * A path is not a curriculum. It is this player's own published evidence, laid
 * out in the order it is worth working through, so two accounts get two
 * different paths and a path changes when the next examination publishes.
 *
 * ## The four kinds of stop
 *
 *   * **review** - a real position from one of this player's own games, where
 *     a measured pattern went wrong. Published as `example` on the phase's
 *     concept row: a FEN, the move played and the move that held. Never a
 *     generated position.
 *   * **lesson** - authored teaching, and only where it genuinely exists.
 *     Thirteen lessons are written and all thirteen are openings, so lesson
 *     stops appear on the opening path and only for families this player
 *     actually plays.
 *   * **drill** - the practice queue, built from the player's own positions.
 *     There is one per path and it states the whole queue's size, because
 *     `/v1/practice/queue` publishes no phase or concept on an item. Three
 *     drill stops each claiming a phase's share would be an attribution the
 *     API never made.
 *   * **locked** - the path continues and Forma will not pretend to know with
 *     what. Deliberately unnamed: a locked stop promising a specific lesson is
 *     a roadmap the product has not committed to.
 *
 * ## Faces
 *
 * A stop's face says what kind of thing it is, and a review stop's face says
 * what kind of chess situation it was - taken from the concept's *published
 * category*, never invented here. Six identical board marks down one route
 * told a reader only that six things happened, which is the least interesting
 * fact available.
 *
 * ## Done is only ever real
 *
 * `done` is set from stored progress and from nothing else. Lessons have it
 * (`completedAt` on the lesson progress record). Review stops and the drill
 * queue do not: there is no published notion of having finished looking at a
 * position, and inventing one would be the "awarded for effort" badge the
 * product refuses. A stop with no completion data is simply never done.
 */

import { lessonForFamily } from "../lessons";
import { roleWord, type Deck } from "./decks";
import type { PhaseKey } from "./phases";
import type { OpeningExplorer, PhaseConcept } from "./types";

export type PathNodeKind = "review" | "drill" | "lesson" | "locked";

/** Which mark a stop wears. Chosen from published data, never invented. */
export type PathFace =
  | "position"
  | "tactic"
  | "defend"
  | "convert"
  | "lesson"
  | "drill"
  | "locked";

export interface PathNode {
  id: string;
  kind: PathNodeKind;
  face: PathFace;
  /** The stop's own name. Short: it is the only text a stop carries. */
  title: string;
  /** The longer description, for the sheet where explaining is the job. */
  subtitle: string | null;
  /** One counted line, for the panel and the stop's sheet. Never on the path. */
  detail: string;
  /** Where the stop's action goes, or null when it only states something. */
  to: string | null;
  /** What the action is called, when there is one. */
  action: string | null;
  board: { fen: string; flip: boolean; playedMoveUci: string | null; bestMoveUci: string | null } | null;
  deck: Deck | null;
  /** Finished, from stored progress only. */
  done: boolean;
  /** Part-way through, for a stop that stores steps. */
  progress: { done: number; total: number } | null;
  /**
   * Nought to three, or null where a star would be a lie.
   *
   * **Stars are only ever earned on a task with a fixed denominator.** A
   * lesson has one: everybody who takes it answers the same interactive moves,
   * so a score out of them is the same question asked of everyone. Phases and
   * patterns do not - the concepts that fire differ by phase, difficulty
   * differs by pattern, and PAGES.md is explicit that the number is not a fair
   * universal score. Stars on those would tell a beginner they are one star at
   * everything for exactly as long as they most need encouragement, which is
   * the failure the whole colour-is-movement rule exists to prevent.
   */
  stars: number | null;
}

export interface LessonPick {
  slug: string;
  title: string;
  family: string;
  color: "white" | "black";
  games: number;
  done: boolean;
  progress: { done: number; total: number } | null;
  stars: number | null;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** The category a concept was published under, as a face. */
function faceFor(category: string | null): PathFace {
  switch (category) {
    case "tactical":
      return "tactic";
    case "defensive":
      return "defend";
    case "conversion":
      return "convert";
    default:
      return "position";
  }
}

/** Every family this player reaches that a lesson was actually written for. */
export function lessonsForPlayer(
  explorers: readonly (OpeningExplorer | null)[],
  colors: readonly ("white" | "black")[],
  progress: ReadonlyMap<
    string,
    { completedSteps: number; totalSteps: number; completedAt: string | null; bestScore?: number }
  >,
  limit = 4,
): LessonPick[] {
  const found: LessonPick[] = [];
  explorers.forEach((explorer, index) => {
    const color = colors[index]!;
    for (const family of explorer?.families ?? []) {
      const lesson = lessonForFamily(family.family, color);
      if (!lesson) continue;
      const stored = progress.get(lesson.slug) ?? null;
      found.push({
        slug: lesson.slug,
        title: lesson.title,
        family: family.family,
        color,
        games: family.games,
        done: stored !== null && (stored.completedAt !== null || stored.completedSteps >= stored.totalSteps),
        progress: stored ? { done: stored.completedSteps, total: stored.totalSteps } : null,
        stars: starsFor(stored, lesson.interactiveCount),
      });
    }
  });
  return found.sort((a, b) => b.games - a.games).slice(0, limit);
}

/**
 * Stars from a lesson's own record, or null when it has none.
 *
 * `bestScore` is the interactive moves answered correctly and
 * `interactiveCount` is how many there were, so the denominator is the lesson
 * itself rather than a comparison with anybody. A lesson nobody has finished
 * has no stars at all - an empty row of outlines would be a score of zero on a
 * task never attempted.
 */
function starsFor(
  stored: { completedSteps: number; totalSteps: number; completedAt: string | null; bestScore?: number } | null,
  outOf: number,
): number | null {
  if (stored === null || stored.completedAt === null || outOf <= 0) return null;
  const share = (stored.bestScore ?? 0) / outOf;
  if (share >= 0.999) return 3;
  if (share >= 0.8) return 2;
  if (share >= 0.5) return 1;
  return 0;
}

function reviewNode(
  deck: Deck,
  example: NonNullable<PhaseConcept["example"]>,
  /** Whether this concept appears on this path under more than one role. */
  split: boolean,
): PathNode {
  // The role only earns a place on the label when it is telling the two stops
  // apart. `critical_moment` is scored once for noticing a position and once
  // for playing it, and without the role those are one name twice. Where a
  // concept appears alone the role is noise, and on `winning_conversion` it is
  // worse than noise: "Conversion - Convert" says the same word twice.
  const role = roleWord(deck.role);
  const counted = `${deck.evidence.missed.toLocaleString()} missed of ${deck.evidence.seen.toLocaleString()}`;
  return {
    id: `review:${deck.key}`,
    kind: "review",
    face: faceFor(deck.category),
    // The chess name on the path, the catalogue's description on the sheet.
    // A route labelled with sentences reads as filler; see `conceptName`.
    title: split && role ? `${deck.shortName} · ${role}` : deck.shortName,
    subtitle: deck.name,
    detail: role ? `${role} · ${counted}` : counted,
    to: null,
    action: null,
    board: {
      fen: example.fen,
      flip: example.side === "black",
      playedMoveUci: example.playedMoveUci,
      bestMoveUci: example.bestMoveUci,
    },
    deck,
    done: false,
    progress: null,
    stars: null,
  };
}

/**
 * The path for one phase.
 *
 * Review stops lead, because the first honest thing to do with a measured
 * mistake is look at the position it happened in. Teaching follows the first
 * review where teaching exists, and the drills follow that, so the shape is
 * always: see it, learn it, practise it, then the next one.
 */
export function buildPath(
  phase: PhaseKey,
  decks: readonly Deck[],
  lessons: readonly LessonPick[],
  queue: { due: number; overdue: number } | null,
  limit = 6,
): PathNode[] {
  const nodes: PathNode[] = [];
  const reviewable = decks.filter((deck) => deck.example !== null).slice(0, limit);
  const perConcept = new Map<string, number>();
  for (const deck of reviewable) {
    perConcept.set(deck.slug, (perConcept.get(deck.slug) ?? 0) + 1);
  }

  reviewable.forEach((deck, index) => {
    nodes.push(reviewNode(deck, deck.example!, (perConcept.get(deck.slug) ?? 0) > 1));

    if (index === 0) {
      for (const lesson of phase === "opening" ? lessons : []) {
        nodes.push({
          id: `lesson:${lesson.slug}`,
          kind: "lesson",
          face: "lesson",
          title: lesson.title,
          subtitle: `A written lesson on the ${lesson.family}.`,
          detail: `You play the ${lesson.family} as ${lesson.color}`,
          to: `/lessons/${lesson.slug}`,
          action: lesson.done ? "Read it again" : lesson.progress ? "Continue" : "Start lesson",
          board: null,
          deck: null,
          done: lesson.done,
          progress: lesson.progress,
          stars: lesson.stars,
        });
      }

      nodes.push({
        id: `drill:${phase}`,
        kind: "drill",
        face: "drill",
        title: "Drill your own positions",
        subtitle: "Every position in the queue came out of one of your games.",
        detail:
          queue && queue.due > 0
            ? `${queue.due} ready across every phase${queue.overdue > 0 ? `, ${queue.overdue} overdue` : ""}`
            : "Built from the positions on this path",
        to: "/practice",
        action: "Open the queue",
        board: null,
        deck: null,
        done: false,
        progress: null,
        stars: null,
      });
      // NOTE: this generic stop is on its way out. Practice assignments now
      // carry `conceptSlug`, `role` and `phase`, so a drill belongs inside the
      // deck it drills rather than in one catch-all link to another page.
    }
  });

  if (nodes.length > 0) {
    for (let index = 0; index < 2; index += 1) {
      nodes.push({
        id: `locked:${phase}:${index}`,
        kind: "locked",
        face: "locked",
        title: "More coming soon",
        subtitle: null,
        detail:
          phase === "opening"
            ? "Forma is still writing material for this part of the game."
            : `Forma has no written ${phase} material yet. The path so far is your own evidence.`,
        to: null,
        action: null,
        board: null,
        deck: null,
        done: false,
        progress: null,
        stars: null,
      });
    }
  }

  return nodes;
}

/** How many of each kind, for the territory's own heading. */
export function countKinds(nodes: readonly PathNode[]): string {
  const reviews = nodes.filter((node) => node.kind === "review").length;
  const lessons = nodes.filter((node) => node.kind === "lesson").length;
  const parts = [`${reviews} ${plural(reviews, "position", "positions")} to review`];
  if (lessons > 0) parts.push(`${lessons} ${plural(lessons, "lesson", "lessons")}`);
  return parts.join(" · ");
}
