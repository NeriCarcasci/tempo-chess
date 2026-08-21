import { Link, useSearchParams } from "react-router";
import type { ShouldRevalidateFunctionArgs } from "react-router";
import type { Route } from "./+types/openings";
import { requireSession } from "../lib/session";
import { RouteError } from "../components/RouteError";
import { TearSheet } from "../components/TearSheet";
import { TopNav } from "../components/TopNav";
import { EmptyState } from "../components/v1/Honesty";
import { OpeningExplorer } from "../components/v1/OpeningExplorer";
import { deriveTearSheet, type TearSheet as TearSheetModel } from "../lib/tearSheet";
import { openingSlug } from "../lib/openingContent";
import { getCached, setCached } from "../lib/loaderCache";
import {
  explorerEmptyCopy,
  explorerEmptyReason,
  getOpeningExplorer,
  walkable,
  type ExplorerEmptyReason,
} from "../lib/v1/openings";
import type { OpeningExplorerCoverage, OpeningGraphV1 } from "../lib/v1/types";

/**
 * `/openings` — the opening sheet, on the canonical system.
 *
 * This screen and `/explorer` were the same product idea built twice against
 * two different APIs. `/openings` read the prototype's `GET /opening-explorer`,
 * `POST /analyze` and `POST /opening-explorer/drills`, all of which are being
 * deleted; `/explorer` read `GET /v1/openings/explorer` and rendered a walk with
 * none of the sheet the tear-sheet layout gives. There is now one screen, and it
 * reads `/v1`.
 *
 * ## What changed with the source, and where the page says so
 *
 * **A mistake is measured differently.** The prototype graph called a move a
 * mistake when it lost 90 centipawns against a stored evaluation. The canonical
 * system calls it a mistake when a published analysis judged it outside a
 * versioned tolerance — more than 0.02 of expected score against the best line
 * the *same search* found (`server/src/engine/contract.ts`). Same word, a
 * different measurement, so `TearSheet` prints the rule under the figures
 * rather than carrying the old sentence across.
 *
 * **"Too few games" is gone.** It was a threshold guess with no number behind
 * it, and it fired for two unrelated situations at once. `/v1` returns real
 * coverage instead: `coverage.playerDecisions` against
 * `coverage.scoredDecisions`, whose difference is the caller's own opening moves
 * that nobody has judged. The sheet states that gap at the top and never says
 * "no mistakes" about a line where nothing was judged.
 *
 * ## Both sides at once
 *
 * The old screen opened on a door — pick White or Black, then see anything. The
 * sheet already labels its two sections and `/today` already pools both, so the
 * gate was a choice a reader was asked to make before there was anything to
 * base it on. Side is now a filter, in the query string, and it starts off.
 *
 * ## Route shape
 *
 * `/openings/:familySlug` is this same screen with that line's row open, and it
 * additionally fetches the family-focused graph so the walk that used to live at
 * `/explorer` appears under the sheet. One screen, one layout, one API; the
 * deeper route adds a section rather than a second page.
 */

export function meta() {
  return [
    { title: "Openings · Forma" },
    { name: "description", content: "Every line in your repertoire, and where the mistakes are." },
  ];
}

interface SheetData {
  sheet: TearSheetModel;
  /** Both colours pooled: a game has one subject colour, so nothing double counts. */
  coverage: OpeningExplorerCoverage;
  /**
   * Why there is nothing to read.
   *
   * `no_graph` carries the API's own reason for having no positions at all.
   * `no_lines` is the different case where positions exist but none of them
   * belongs to a named opening the player has a decision in — a handful of
   * games that ended before move two, most often. Collapsing the two would
   * tell a player with games that Forma has not received their games.
   */
  empty:
    | { kind: "no_graph"; reason: ExplorerEmptyReason }
    | { kind: "no_lines" }
    | null;
  /** The family named by the URL, resolved to the row it opens. */
  openFamily: string | null;
  /** The family-focused graph, present only on `/openings/:familySlug`. */
  walk: { graph: OpeningGraphV1; coverage: OpeningExplorerCoverage; playingAs: "white" | "black" } | null;
  /** The side filter as the query string set it, or null for both. */
  side: "white" | "black" | null;
}

const SIDES = new Set(["white", "black"]);

/**
 * Both colours, then the sheet.
 *
 * Two requests rather than one unfiltered request, because the sheet's sections
 * are per colour and a pooled graph cannot say which side a line belongs to —
 * the same position occurs in a White repertoire and a Black one and the
 * verdicts are about different players' decisions. `walkable` is the whole
 * adapter between the v1 and legacy encodings: they differ only in a loss field
 * the sheet never reads.
 */
export async function clientLoader({ request }: Route.ClientLoaderArgs): Promise<SheetData> {
  const session = await requireSession();
  const url = new URL(request.url);
  const colour = url.searchParams.get("color");
  const side = colour && SIDES.has(colour) ? (colour as "white" | "black") : null;
  // Read off the path rather than `params`. This module serves both `/openings`
  // and `/openings/:familySlug`, and the generated types for the index route
  // know nothing about the parameter the deeper one carries.
  const familySlug = url.pathname.startsWith("/openings/")
    ? url.pathname.split("/").filter(Boolean).at(-1) ?? null
    : null;

  // Keyed by the profile, not a handle. The server resolves the subject from
  // the token, so a username in the key would collide two accounts that happen
  // to share one.
  const cacheKey = `openings:${session.userId}:${side ?? "both"}:${familySlug ?? ""}`;
  const cached = getCached<SheetData>(cacheKey, 60_000);
  if (cached) return cached;

  const [white, black] = await Promise.all([
    side === "black" ? null : getOpeningExplorer({ color: "white" }),
    side === "white" ? null : getOpeningExplorer({ color: "black" }),
  ]);

  const sheet = deriveTearSheet(
    white?.graph ? walkable(white.graph) : null,
    black?.graph ? walkable(black.graph) : null,
  );

  const coverage: OpeningExplorerCoverage = {
    games: (white?.coverage.games ?? 0) + (black?.coverage.games ?? 0),
    observations: (white?.coverage.observations ?? 0) + (black?.coverage.observations ?? 0),
    scoredDecisions:
      (white?.coverage.scoredDecisions ?? 0) + (black?.coverage.scoredDecisions ?? 0),
    playerDecisions:
      (white?.coverage.playerDecisions ?? 0) + (black?.coverage.playerDecisions ?? 0),
    unanalysedGames:
      (white?.coverage.unanalysedGames ?? 0) + (black?.coverage.unanalysedGames ?? 0),
  };

  // The slug is resolved against the sheet's own rows rather than against the
  // API's family list. They can differ: the sheet folds catalogue waypoints
  // like "Queen's Pawn Game" into the line that grew out of them, so a row
  // exists under a name no family summary carries.
  //
  // The section is kept along with the row, not re-derived. The walk is fetched
  // per colour, and guessing the colour from the filter would fetch the White
  // graph for a Black defence whenever no side filter is set — a page whose
  // heading named one line and whose board walked another.
  const found =
    familySlug === null
      ? null
      : sheet.sections
          .flatMap((section) => section.rows.map((row) => ({ row, color: section.color })))
          .find(({ row }) => openingSlug(row.family) === familySlug) ?? null;
  const openFamily = found?.row.family ?? null;

  // The walk, fetched only when a family names one. Asking for it on the index
  // would spend a request per visit on a section nobody has opened.
  const walk =
    found === null
      ? null
      : await getOpeningExplorer({ color: found.color, family: found.row.family })
          .then((data) =>
            data.graph
              ? { graph: data.graph, coverage: data.coverage, playingAs: found.color }
              : null,
          )
          // A missing walk is a missing section, not a failed page: the sheet
          // above it came from a different read and is still true.
          .catch(() => null);

  const data: SheetData = {
    sheet,
    coverage,
    empty:
      sheet.sections.length > 0
        ? null
        : white?.graph || black?.graph
          ? { kind: "no_lines" as const }
          : {
              kind: "no_graph" as const,
              reason: explorerEmptyReason({
                coverage: { games: coverage.games },
                // Asked against the pooled view. Passing the side filter
                // through would report "no games match these filters" to a
                // reader who set no filter and has no games.
                filters: { color: null, speed: null, provider: null, family: null },
              }),
            },
    openFamily,
    walk,
    side,
  };
  setCached(cacheKey, data);
  return data;
}

/**
 * The whole sheet ships with the loader, so opening a row is pure client state.
 * Only a different dataset — a new side, or a different family — needs a
 * refetch.
 */
export function shouldRevalidate({
  currentUrl,
  nextUrl,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  if (currentUrl.searchParams.get("color") !== nextUrl.searchParams.get("color")) return true;
  if (currentUrl.pathname !== nextUrl.pathname) return true;
  return defaultShouldRevalidate;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return <RouteError title="Could not load your openings" error={error} />;
}

export default function OpeningsRoute({ loaderData }: Route.ComponentProps) {
  const { sheet, coverage, empty, openFamily, walk, side } = loaderData as SheetData;

  return (
    <div className="relative z-10 min-h-dvh">
      <TopNav current="openings" />
      <main className="tsheet-page">
        <SideFilter side={side} family={openFamily} />
        {empty ? <NothingToRead empty={empty} games={coverage.games} /> : null}
        {sheet.sections.length ? (
          <TearSheet
            key={openFamily ?? "all"}
            sheet={sheet}
            coverage={coverage}
            openFamily={openFamily}
          />
        ) : null}
        {walk && openFamily ? (
          <section className="lsheet-walk" aria-labelledby="lsheet-walk-head">
            <h2 id="lsheet-walk-head">Walk the {openFamily}</h2>
            <p>
              Every branch below is a move played in one of your own games. Positions reached
              by different move orders are the same position here, so a transposition is
              counted once.
            </p>
            <OpeningExplorer
              graph={walk.graph}
              coverage={walk.coverage}
              playingAs={walk.playingAs}
            />
          </section>
        ) : null}
      </main>
    </div>
  );
}

/**
 * Side as a filter, not a gate.
 *
 * "Both" is the default and the first control, because it is the state the
 * sheet is designed for: two labelled sections, sorted worst first across the
 * whole repertoire.
 */
function SideFilter({ side, family }: { side: "white" | "black" | null; family: string | null }) {
  const [params, setParams] = useSearchParams();
  const choose = (next: "white" | "black" | null) => {
    const query = new URLSearchParams(params);
    if (next === null) query.delete("color");
    else query.set("color", next);
    setParams(query, { replace: true, preventScrollReset: true });
  };

  return (
    <nav className="lsheet-filter" aria-label="Openings">
      {family ? (
        <>
          <Link to="/openings" className="side-crumb-back">
            <span aria-hidden="true">‹</span> All lines
          </Link>
          <span className="side-crumb-sep" aria-hidden="true">/</span>
          <span className="side-crumb-current">{family}</span>
        </>
      ) : (
        <div className="explorer-chips">
          <span className="cap">Playing as</span>
          {([null, "white", "black"] as const).map((value) => (
            <button
              key={value ?? "both"}
              type="button"
              className={`explorer-chip${side === value ? " is-active" : ""}`}
              aria-pressed={side === value}
              onClick={() => choose(value)}
            >
              {value === null ? "Both" : value === "white" ? "White" : "Black"}
            </button>
          ))}
        </div>
      )}
    </nav>
  );
}

function NothingToRead({
  empty,
  games,
}: {
  empty: NonNullable<SheetData["empty"]>;
  games: number;
}) {
  if (empty.kind === "no_lines") {
    return (
      <EmptyState
        title="No opening lines to read yet"
        detail={`Forma has the positions from ${games} ${games === 1 ? "game" : "games"}, but none of them reaches an opening you have a decision in yet. A line needs to be named and played past the first move before it becomes a row.`}
      />
    );
  }
  const copy = explorerEmptyCopy(empty.reason, games);
  return <EmptyState title={copy.title} detail={copy.detail} />;
}
