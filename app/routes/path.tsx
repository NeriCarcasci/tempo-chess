import { useLoaderData } from "react-router";
import { PathCanvas, type CanvasRegion } from "../components/PathCanvas";
import { EmptyState } from "../components/v1/Honesty";
import { RouteError } from "../components/RouteError";
import { Link } from "react-router";
import { getCached, setCached } from "../lib/loaderCache";
import { requireSession } from "../lib/session";
import { fetchLessonProgress } from "../lib/account";
import { getDashboard, measures, phaseReadings, type PhaseReading } from "../lib/v1/dashboard";
import { decksForPhase, measureIndex, reviewsByDeck, type Deck } from "../lib/v1/decks";
import { buildPath, countKinds, lessonsForPlayer, type PathNode } from "../lib/v1/pathNodes";
import { getOpeningExplorer } from "../lib/v1/openings";
import { getPhaseDetail, type PhaseKey } from "../lib/v1/phases";
import { getPracticeQueue } from "../lib/v1/practice";
import type { PhaseDetail } from "../lib/v1/types";

/**
 * `/path` - what to work through, on a canvas rather than a page.
 *
 * The page this replaced was a document with a triangle pinned to the top of
 * it: three entrances, and then the same scrolled report underneath that the
 * entrances were supposed to be an alternative to. Pressing a phase moved the
 * scroll bar. That is a map drawn on a page, which is neither.
 *
 * So there is no document here. There is one space, the three phases stand in
 * it as three places with a line leaving each toward its own territory, and
 * pressing one flies the camera down that line. `PathCanvas` owns the
 * geometry and the travel; this route owns what is true.
 *
 * ## What the nodes are allowed to be
 *
 * Every stop is either a position out of this player's own games, a drill
 * built from those positions, or a lesson somebody actually wrote. There is
 * no node that exists to be clicked for a statistic: measurements are chrome
 * beside the canvas, on the phase's own ring, because a measurement placed
 * among the stops reads as a thing to complete and nothing measured here is
 * completable.
 *
 * The opening path has teaching in it because thirteen lessons are written
 * and all thirteen are openings. The middlegame and the endgame run on review
 * and drills, and each ends on a node that says so rather than trailing off
 * or promising material that does not exist.
 */

export function meta() {
  return [
    { title: "Your path · Forma" },
    { name: "robots", content: "noindex" },
  ];
}

const PHASE_ORDER: PhaseKey[] = ["opening", "middlegame", "endgame"];

const PHASE_NAME: Record<PhaseKey, string> = {
  opening: "Opening",
  middlegame: "Middlegame",
  endgame: "Endgame",
};

interface PathData {
  readings: PhaseReading[];
  decks: Record<PhaseKey, Deck[]>;
  nodes: Record<PhaseKey, PathNode[]>;
  /** The phase's published counts, for the panel beside the path. */
  cards: Record<PhaseKey, PhaseDetail["card"] | null>;
  published: string | null;
  games: number;
}

export async function clientLoader(): Promise<PathData> {
  const session = await requireSession();
  const cacheKey = `path:${session.userId}`;
  const cached = getCached<PathData>(cacheKey, 60_000);
  if (cached) return cached;

  // The explorer and the queue feed the lesson and drill stops. Both may fail
  // without taking the canvas down: a missing lesson is a shorter path, and a
  // missing queue is a drill stop that does not state a number.
  const [opening, middlegame, endgame, dashboard, white, black, queue, progress] = await Promise.all([
    getPhaseDetail("opening"),
    getPhaseDetail("middlegame"),
    getPhaseDetail("endgame"),
    getDashboard().then((result) => result?.data ?? null),
    getOpeningExplorer({ color: "white" }).catch(() => null),
    getOpeningExplorer({ color: "black" }).catch(() => null),
    getPracticeQueue().catch(() => null),
    // Lesson completion is the one stop state backed by stored progress.
    // It still lives on the prototype API, which is also where `/lessons`
    // reads it, so the two surfaces agree; when it moves to `/v1` this is
    // the only line that changes.
    fetchLessonProgress(session.username).catch(() => []),
  ]);

  const byKey = measureIndex(dashboard ? measures(dashboard) : []);
  const reviews = reviewsByDeck(queue?.items ?? []);
  const details: Record<PhaseKey, PhaseDetail | null> = { opening, middlegame, endgame };
  const lessons = lessonsForPlayer(
    [white, black],
    ["white", "black"],
    new Map(progress.map((entry) => [entry.slug, entry])),
  );
  const drills = queue ? { due: queue.items.length, overdue: queue.overdue } : null;

  const decks = {
    opening: decksForPhase("opening", opening, byKey, reviews),
    middlegame: decksForPhase("middlegame", middlegame, byKey, reviews),
    endgame: decksForPhase("endgame", endgame, byKey, reviews),
  };

  const data: PathData = {
    readings: dashboard ? phaseReadings(dashboard) : [],
    decks,
    cards: {
      opening: opening?.card ?? null,
      middlegame: middlegame?.card ?? null,
      endgame: endgame?.card ?? null,
    },
    nodes: {
      opening: buildPath("opening", decks.opening, lessons, drills),
      middlegame: buildPath("middlegame", decks.middlegame, lessons, drills),
      endgame: buildPath("endgame", decks.endgame, lessons, drills),
    },
    published: dashboard?.publishedAt ?? null,
    games: dashboard?.trajectory.includedGameCount ?? 0,
  };
  setCached(cacheKey, data);
  return data;
}

export function ErrorBoundary({ error }: { error: unknown }) {
  return <RouteError title="Could not load your path" error={error} />;
}

export default function PathRoute() {
  const data = useLoaderData() as PathData;
  const byPhase = new Map(data.readings.map((reading) => [reading.phase, reading]));
  const anything = PHASE_ORDER.some((phase) => data.nodes[phase].length > 0);

  const regions: CanvasRegion[] = PHASE_ORDER.map((phase) => {
    const nodes = data.nodes[phase];
    const reading = byPhase.get(phase) ?? null;
    const reviews = nodes.filter((node) => node.kind === "review").length;
    const card = data.cards[phase];
    return {
      phase,
      name: PHASE_NAME[phase],
      split: card
        ? {
            handled: card.taken,
            missed: card.observed - card.taken,
            setAside: card.setAside,
          }
        : null,
      gamesReaching: reading?.gamesReaching ?? null,
      // Never a completion figure. What stands under a phase is how much of
      // this player's own evidence is waiting there, which is a count of real
      // things, or the reason there is nothing.
      standing:
        reviews > 0
          ? `${reviews} to review`
          : reading?.gamesReaching === 0
            ? "Your games do not reach here"
            : "Nothing measured yet",
      nodes,
      reading,
      summary: nodes.length > 0 ? countKinds(nodes) : "Nothing published here yet",
    };
  });

  // No `TopNav` on this route, on purpose. A canvas somebody flies around is a
  // place, and a sticky bar with a logo and three tabs across the top of it is
  // browser chrome bolted to a map: it makes the space read as a page again,
  // which is the one thing this screen is not. The canvas carries a back arrow
  // and that is the whole of its navigation.
  return anything ? (
    <main className="path-main">
      <PathCanvas regions={regions} />
    </main>
  ) : (
    <main className="path-shell">
      <div className="path-empty">
        <EmptyState
          title="Nothing has been published about your games yet"
          detail="Your path is built from the examination. Today says where it stands."
          action={
            <Link to="/today" className="secondary-button mt-4 inline-flex">
              Go to Today
            </Link>
          }
        />
      </div>
    </main>
  );
}
