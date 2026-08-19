import { useSearchParams } from "react-router";
import type { Route } from "./+types/explorer";
import { OpeningExplorer } from "../components/v1/OpeningExplorer";
import { EmptyState } from "../components/v1/Honesty";
import { RouteError } from "../components/RouteError";
import {
  explorerEmptyCopy,
  explorerEmptyReason,
  getOpeningExplorer,
  walkable,
} from "../lib/v1/openings";
import type { OpeningExplorer as ExplorerData } from "../lib/v1/types";
import { requireSession } from "../lib/session";

/**
 * The opening explorer.
 *
 * The first screen built on the canonical position graph rather than on the
 * legacy observation table, which changes what it is allowed to claim. Two
 * games that reach the same board by different move orders are one node here,
 * because a core position is board, side to move, castling rights and a legal
 * en-passant square and nothing else — so a transposition is found rather than
 * approximated.
 *
 * The legacy `/openings` screen is untouched and still serves the tear sheet,
 * the repertoire stars and the drill queue, none of which have a `/v1` surface
 * yet. This screen does not pretend to replace it; it does the one thing the
 * new API can do honestly, which is show you the positions your games actually
 * reached and how much is known about each.
 *
 * Filters live in the query string so a line is linkable, and they are passed
 * to the API rather than applied here — filtering a graph client-side would
 * leave the share percentages describing a sample the reader is not looking at.
 */

export function meta() {
  return [{ title: "Opening explorer · Forma" }];
}

interface LoaderData {
  explorer: ExplorerData;
  playingAs: "white" | "black";
}

const COLOURS = new Set(["white", "black"]);
const SPEEDS = new Set(["bullet", "blitz", "rapid", "classical", "correspondence"]);
const PROVIDERS = new Set(["lichess", "chesscom"]);

export async function clientLoader({ request }: Route.ClientLoaderArgs): Promise<LoaderData> {
  await requireSession();
  const url = new URL(request.url);

  // An unrecognised filter is dropped rather than forwarded. The API would
  // refuse it with a 400, and a hand-edited URL should narrow to something
  // sensible rather than break the page.
  const colour = url.searchParams.get("color");
  const speed = url.searchParams.get("speed");
  const provider = url.searchParams.get("provider");
  const family = url.searchParams.get("family");

  const playingAs = colour === "black" ? "black" : "white";

  const explorer = await getOpeningExplorer({
    color: colour && COLOURS.has(colour) ? (colour as "white" | "black") : null,
    speed: speed && SPEEDS.has(speed) ? speed : null,
    provider: provider && PROVIDERS.has(provider) ? (provider as "lichess" | "chesscom") : null,
    family: family || null,
  });

  return { explorer, playingAs };
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return <RouteError title="Could not open the explorer" error={error} />;
}

export default function ExplorerRoute({ loaderData }: Route.ComponentProps) {
  const { explorer, playingAs } = loaderData as LoaderData;
  const [params, setParams] = useSearchParams();

  const setFilter = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value === null) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  return (
    <main className="relative z-10 mx-auto grid max-w-[1100px] gap-8 px-6 py-12">
      <header className="grid gap-2">
        <p className="eyebrow">Openings</p>
        <h1 className="text-3xl">The positions your games reached</h1>
        <p className="max-w-[62ch] text-ink-muted">
          Every branch below is a move played in one of your own games. Positions reached by
          different move orders are the same position here, so a transposition is counted once.
        </p>
      </header>

      <div className="explorer-filters" role="group" aria-label="Filters">
        <SideChoice
          value={playingAs}
          onChange={(side) => setFilter("color", side)}
        />
        <SpeedChoice
          value={params.get("speed")}
          onChange={(speed) => setFilter("speed", speed)}
        />
      </div>

      {explorer.graph ? (
        <OpeningExplorer
          graph={walkable(explorer.graph)}
          coverage={explorer.coverage}
          playingAs={playingAs}
        />
      ) : (
        <NothingToWalk explorer={explorer} />
      )}
    </main>
  );
}

function NothingToWalk({ explorer }: { explorer: ExplorerData }) {
  const copy = explorerEmptyCopy(explorerEmptyReason(explorer), explorer.coverage.games);
  return <EmptyState title={copy.title} detail={copy.detail} />;
}

function SideChoice({
  value,
  onChange,
}: {
  value: "white" | "black";
  onChange: (side: "white" | "black") => void;
}) {
  return (
    <div className="explorer-chips">
      <span className="cap">Playing as</span>
      {(["white", "black"] as const).map((side) => (
        <button
          key={side}
          type="button"
          className={`explorer-chip${value === side ? " is-active" : ""}`}
          aria-pressed={value === side}
          onClick={() => onChange(side)}
        >
          {side === "white" ? "White" : "Black"}
        </button>
      ))}
    </div>
  );
}

function SpeedChoice({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (speed: string | null) => void;
}) {
  const speeds = ["bullet", "blitz", "rapid", "classical"] as const;
  return (
    <div className="explorer-chips">
      <span className="cap">Time control</span>
      <button
        type="button"
        className={`explorer-chip${!value ? " is-active" : ""}`}
        aria-pressed={!value}
        onClick={() => onChange(null)}
      >
        All
      </button>
      {speeds.map((speed) => (
        <button
          key={speed}
          type="button"
          className={`explorer-chip${value === speed ? " is-active" : ""}`}
          aria-pressed={value === speed}
          onClick={() => onChange(speed)}
        >
          {speed[0]!.toUpperCase() + speed.slice(1)}
        </button>
      ))}
    </div>
  );
}
