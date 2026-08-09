import { useCallback, useEffect, useMemo, useState } from "react";
import { Form, Link, useFetcher, useSearchParams } from "react-router";
import type { ShouldRevalidateFunctionArgs } from "react-router";
import type { Route } from "./+types/openings";
import { requireSession, peekSession } from "../lib/session";
import { api, apiFetch, apiMaybe } from "../lib/api";
import { fetchRepertoire, toggleRepertoireOpening } from "../lib/account";
import { lessonForFamily } from "../lib/lessons";
import { InfoTip } from "../components/InfoTip";
import { OpeningExplorer } from "../components/OpeningExplorer";
import { TopNav } from "../components/TopNav";
import { loadBoardTheme } from "../lib/boardThemes";
import { loadPieceSet } from "../lib/pieceSets";
import { openingSlug } from "../lib/openingContent";
import { getCached, setCached, invalidateCache } from "../lib/loaderCache";
import {
  type OpeningExplorerData,
  type OpeningFamily,
  type PlayerCoverage,
} from "../lib/openings";

interface ExplorerData {
  needsSide: false;
  explorer: OpeningExplorerData & { error?: string };
  coverage: PlayerCoverage | null;
  initialFamily: string | null;
  color: "white" | "black";
}

export function meta() {
  return [
    { title: "Opening Explorer · Tempo" },
    { name: "description", content: "Walk every branch of your own opening repertoire and see where it goes wrong." },
  ];
}

export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  const session = await requireSession();
  const url = new URL(request.url);
  const color = url.searchParams.get("color");
  const familySlug = url.pathname.startsWith("/openings/")
    ? url.pathname.split("/").filter(Boolean).at(-1)
    : null;

  // No side chosen yet — the page is just the White/Black start gate.
  if (color !== "white" && color !== "black" && !familySlug) {
    return { needsSide: true as const };
  }
  const side: "white" | "black" = color === "black" ? "black" : "white";

  const query = new URLSearchParams(url.search);
  query.set("username", session.username);
  query.set("color", side);
  const username = session.username;

  const cacheKey = `openings:${username}:${url.pathname}${url.search}`;
  const cached = getCached<ExplorerData>(cacheKey, 60_000);
  if (cached) return cached;

  // Coverage hits the live Lichess API for the total game count, which
  // rate-limits; it's non-critical, so degrade rather than break the explorer.
  const [explorer, coverage] = await Promise.all([
    api<OpeningExplorerData & { error?: string }>(`/opening-explorer?${query}`),
    apiMaybe<PlayerCoverage>(`/players/${encodeURIComponent(username)}/coverage`),
  ]);

  // Resolve a deep-linked family (either ?family= or the /openings/:slug route)
  // to a name the explorer can focus. The graph already carries every family.
  let initialFamily = query.get("family") ?? null;
  if (!initialFamily && familySlug) {
    const matched = explorer.families.find((family) => openingSlug(family.family) === familySlug);
    if (matched) initialFamily = matched.family;
  }

  const result: ExplorerData = { needsSide: false, explorer, coverage, initialFamily, color: side };
  setCached(cacheKey, result);
  return result;
}

export async function clientAction({ request }: Route.ClientActionArgs) {
  const form = await request.formData();
  const intent = form.get("intent");
  // Any opening mutation (sync import or new drill) can change cached hub/explorer
  // data — clear the client loader cache so the next navigation reflects it.
  invalidateCache();
  if (intent === "sync") {
    const response = await apiFetch("/imports/lichess", {
      json: { username: form.get("username"), games: "all" },
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) return { ok: false, intent, message: data?.error ?? "Could not sync games." };
    return { ok: true, intent, message: `Syncing ${data.import.requestedGames} games from Lichess.` };
  }

  const response = await apiFetch("/opening-explorer/drills", {
    json: {
      username: form.get("username"),
      positionKey: form.get("positionKey"),
    },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) return { ok: false, intent: "drill", message: data?.error ?? "Could not create practice." };
  return { ok: true, intent: "drill", message: "Position added to your practice queue." };
}

/**
 * The whole opening graph ships with the loader, so walking branches is pure
 * client state. Only a genuinely different dataset (a new player or a changed
 * filter) or a mutation needs a refetch.
 */
export function shouldRevalidate({
  currentUrl,
  nextUrl,
  formMethod,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  if (formMethod && formMethod.toUpperCase() !== "GET") return true;
  const keys = ["username", "platform", "speed", "color", "since"];
  if (keys.some((key) => currentUrl.searchParams.get(key) !== nextUrl.searchParams.get(key))) {
    return true;
  }
  if (currentUrl.pathname === nextUrl.pathname) return defaultShouldRevalidate;
  // Navigating between /openings and /openings/:slug never needs new data.
  return false;
}

function CoverageBar({ coverage, username }: { coverage: PlayerCoverage | null; username: string }) {
  const sync = useFetcher<typeof clientAction>();
  if (!coverage) return null;
  const busy = sync.state !== "idle" || coverage.activeImport != null;
  const complete = coverage.historyComplete;
  const percent = coverage.availableGames
    ? Math.min(100, Math.round((coverage.importedGames / coverage.availableGames) * 100))
    : 0;

  return (
    <section className="coverage-bar" aria-label="Game history coverage">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <strong>{coverage.importedGames} of {coverage.availableGames} Lichess games imported</strong>
          <InfoTip label="game coverage">
            Opening patterns sharpen as more of your history is added. Non-standard variants are skipped.
          </InfoTip>
        </div>
        <div className="coverage-track" aria-hidden="true">
          <span style={{ width: `${percent}%` }} />
        </div>
        <p>
          {complete
            ? coverage.skippedGames > 0
              ? `${coverage.analyzedGames} games have engine analysis. ${coverage.skippedGames} non-standard ${coverage.skippedGames === 1 ? "game was" : "games were"} skipped.`
              : `${coverage.analyzedGames} games have engine analysis.`
            : `${coverage.availableGames - coverage.importedGames} ${coverage.availableGames - coverage.importedGames === 1 ? "game is" : "games are"} still missing from this map.`}
        </p>
      </div>
      {!complete ? (
        <sync.Form method="post">
          <input type="hidden" name="intent" value="sync" />
          <input type="hidden" name="username" value={username} />
          <button className="secondary-button" disabled={busy}>
            {busy ? "Syncing games…" : "Import all games"}
          </button>
        </sync.Form>
      ) : null}
      {sync.data ? <p className="sr-only" aria-live="polite">{sync.data.message}</p> : null}
    </section>
  );
}

function Filters({ username, params }: { username: string; params: URLSearchParams }) {
  const today = new Date();
  const since = (days: number) => {
    const date = new Date(today);
    date.setDate(date.getDate() - days);
    return date.toISOString().slice(0, 10);
  };
  const filters = [
    { name: "platform", label: "Site", options: [["all", "All sites"], ["lichess", "Lichess"], ["chesscom", "Chess.com"]] },
    { name: "speed", label: "Time control", options: [["all", "All speeds"], ["bullet", "Bullet"], ["blitz", "Blitz"], ["rapid", "Rapid"], ["classical", "Classical"]] },
    { name: "since", label: "Games played", options: [["", "All time"], [since(90), "Last 90 days"], [since(180), "Last 6 months"], [since(365), "Last year"]] },
  ];

  return (
    <details className="opening-filters">
      <summary>Narrow the games</summary>
      <Form method="get" className="opening-filter-grid">
        <input type="hidden" name="username" value={username} />
        <input type="hidden" name="color" value={params.get("color") ?? "white"} />
        {filters.map(({ name, label, options }) => (
          <label key={name}>
            <span>{label}</span>
            <select name={name} defaultValue={params.get(name) ?? options[0]![0]}>
              {options.map(([value, copy]) => <option key={value} value={value}>{copy}</option>)}
            </select>
          </label>
        ))}
        <button className="secondary-button">Apply</button>
      </Form>
    </details>
  );
}

function KingTile({ color, label, blurb }: { color: "white" | "black"; label: string; blurb: string }) {
  const theme = loadBoardTheme();
  const pieces = loadPieceSet();
  const white = color === "white";
  return (
    <Link to={`/openings?color=${color}`} className="side-tile">
      <span className="side-tile-king" style={{ background: theme.dark }} aria-hidden="true">
        {pieces.svg ? (
          <svg
            viewBox="0 0 45 45"
            style={{
              ["--pc-fill" as string]: white ? pieces.whiteFill : pieces.blackFill,
              ["--pc-line" as string]: white ? pieces.whiteStroke : pieces.blackStroke,
            }}
          >
            <g
              fill="var(--pc-fill)"
              stroke="var(--pc-line)"
              strokeWidth={1.5}
              strokeLinejoin="round"
              strokeLinecap="round"
              dangerouslySetInnerHTML={{ __html: pieces.svg.k }}
            />
          </svg>
        ) : (
          <span className="side-king-glyph" style={{ color: white ? pieces.whiteFill : pieces.blackFill }}>
            {white ? "♔" : "♚"}
          </span>
        )}
      </span>
      <span className="side-tile-label">
        <strong>{label}</strong>
        <small>{blurb}</small>
      </span>
    </Link>
  );
}

/** The start gate: choosing a side is the only thing on the page. */
function SideGate() {
  return (
    <div className="relative z-10 min-h-dvh">
      <TopNav current="openings" />
      <main className="side-gate">
        <div className="side-gate-inner">
          <p className="eyebrow">Opening explorer</p>
          <h1>Which side do you want to study?</h1>
          <p className="side-gate-sub">
            Pick a side and Tempo shows the openings you actually play from there. You can switch any time.
          </p>
          <div className="side-tiles">
            <KingTile color="white" label="As White" blurb="Your 1.e4 / 1.d4 repertoire" />
            <KingTile color="black" label="As Black" blurb="Your defences to 1.e4 / 1.d4" />
          </div>
        </div>
      </main>
    </div>
  );
}

function SideBreadcrumb({ playingAs, params }: { playingAs: "white" | "black"; params: URLSearchParams }) {
  const other = playingAs === "white" ? "black" : "white";
  const otherHref = (() => {
    const next = new URLSearchParams(params);
    next.set("color", other);
    return `/openings?${next}`;
  })();
  return (
    <nav className="side-breadcrumb" aria-label="Breadcrumb">
      <Link to="/openings" className="side-crumb-back">
        <span aria-hidden="true">‹</span> Choose side
      </Link>
      <span className="side-crumb-sep" aria-hidden="true">/</span>
      <span className="side-crumb-current">Studying as <b>{playingAs}</b></span>
      <Link to={otherHref} preventScrollReset className="side-crumb-switch">
        Switch to {other} <span aria-hidden="true">⇆</span>
      </Link>
    </nav>
  );
}

const INITIAL_OPENINGS = 7;

function FamilyChips({
  families,
  active,
  onSelect,
  repertoire,
  onToggleRepertoire,
}: {
  families: OpeningFamily[];
  active: string | null;
  onSelect: (family: string | null) => void;
  repertoire: Set<string>;
  onToggleRepertoire: (family: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const byGames = useMemo(
    () => [...families].sort((left, right) => right.games - left.games || left.family.localeCompare(right.family)),
    [families],
  );
  const shown = expanded ? byGames : byGames.slice(0, INITIAL_OPENINGS);
  const remaining = byGames.length - shown.length;

  return (
    <section className="explorer-openings" aria-label="Your openings">
      <div className="explorer-openings-head">
        <p className="cap">Jump into an opening</p>
        <InfoTip label="your openings">
          The openings you reach most from this side. Star the ones you want to own — they
          show up on your account page to track how well you know them.
        </InfoTip>
      </div>
      <div className="explorer-opening-grid">
        <button
          type="button"
          className={`opening-chip is-repertoire ${active === null ? "is-active" : ""}`}
          onClick={() => onSelect(null)}
          aria-pressed={active === null}
        >
          <strong>Whole repertoire</strong>
          <small>from move 1</small>
        </button>
        {shown.map((family) => {
          const starred = repertoire.has(family.family);
          return (
            <div
              key={family.family}
              className={`opening-chip ${active === family.family ? "is-active" : ""} ${starred ? "is-starred" : ""}`}
            >
              <button
                type="button"
                className="opening-chip-select"
                onClick={() => onSelect(family.family)}
                aria-pressed={active === family.family}
              >
                <strong>{family.family}</strong>
                <small>{family.games} game{family.games === 1 ? "" : "s"}</small>
              </button>
              <button
                type="button"
                className={`opening-chip-star ${starred ? "is-on" : ""}`}
                onClick={() => onToggleRepertoire(family.family)}
                aria-pressed={starred}
                aria-label={starred ? `Remove ${family.family} from your repertoire` : `Add ${family.family} to your repertoire`}
                title={starred ? "In your repertoire" : "Add to your repertoire"}
              >
                {starred ? "★" : "☆"}
              </button>
            </div>
          );
        })}
      </div>
      {byGames.length > INITIAL_OPENINGS ? (
        <button type="button" className="explorer-showmore" onClick={() => setExpanded((e) => !e)}>
          {expanded ? "Show fewer" : `Show ${remaining} more opening${remaining === 1 ? "" : "s"}`}
        </button>
      ) : null}
    </section>
  );
}

type ExplorerLoaderData = Extract<Awaited<ReturnType<typeof clientLoader>>, { needsSide: false }>;

export default function OpeningReview({ loaderData }: Route.ComponentProps) {
  if (loaderData.needsSide) return <SideGate />;
  return <ExplorerView loaderData={loaderData} />;
}

function ExplorerView({ loaderData }: { loaderData: ExplorerLoaderData }) {
  const { explorer: data, coverage, initialFamily, color: playingAs } = loaderData;
  const [params] = useSearchParams();
  const [focus, setFocus] = useState<{ family: string | null; nonce: number }>(() => ({
    family: initialFamily ?? null,
    nonce: 0,
  }));

  const selectFamily = useCallback((family: string | null) => {
    setFocus((prev) => ({ family, nonce: prev.nonce + 1 }));
  }, []);

  // The user's chosen repertoire (families) for this side — starred from the chips.
  const [repertoire, setRepertoire] = useState<Set<string>>(new Set());
  useEffect(() => {
    const session = peekSession();
    if (!session) return;
    let live = true;
    fetchRepertoire(session.username)
      .then((data) => {
        if (!live) return;
        setRepertoire(new Set(data.openings.filter((o) => o.color === playingAs).map((o) => o.family)));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [playingAs]);

  const toggleRepertoire = useCallback(
    (family: string) => {
      const session = peekSession();
      if (!session) return;
      const enabled = !repertoire.has(family);
      const apply = (on: boolean) =>
        setRepertoire((prev) => {
          const next = new Set(prev);
          if (on) next.add(family);
          else next.delete(family);
          return next;
        });
      apply(enabled); // optimistic
      toggleRepertoireOpening(session.username, playingAs, family, enabled).catch(() => apply(!enabled)); // rollback on failure
    },
    [playingAs, repertoire],
  );

  const weakestKey = useMemo(() => {
    if (!focus.family) return null;
    return data.families.find((family) => family.family === focus.family)?.weakestNodeKey ?? null;
  }, [focus.family, data.families]);

  const filterQuery = useMemo(() => {
    const query = new URLSearchParams();
    for (const key of ["platform", "speed", "color", "since"]) {
      const value = params.get(key);
      if (value) query.set(key, value);
    }
    return query.toString();
  }, [params]);

  const trainHref = `/train?color=${playingAs}${focus.family ? `&family=${encodeURIComponent(focus.family)}` : ""}`;

  return (
    <div className="relative z-10 min-h-dvh">
      <TopNav current="openings" />

      <main id="opening-explorer-main" className="opening-review-shell">
        <SideBreadcrumb playingAs={playingAs} params={params} />
        <header className="opening-review-header">
          <div>
            <p className="eyebrow">Opening explorer</p>
            <h1>{focus.family ?? `Your ${playingAs} openings`}</h1>
            <p>
              {focus.family
                ? `Walk every ${focus.family} line you have actually played, follow how the games split, and open the exact moment a move went wrong.`
                : "Start at move one and follow the paths you play most. Every branch is built from your own games, no reload between clicks."}
            </p>
          </div>
          <div className="explorer-header-actions">
            <Link to={trainHref} className="primary-button self-start">
              Train {focus.family ? "this line" : "your repertoire"}
            </Link>
            {focus.family && lessonForFamily(focus.family, playingAs) ? (
              <Link
                to={`/lessons/${lessonForFamily(focus.family, playingAs)!.slug}`}
                className="secondary-button self-start inline-flex items-center"
              >
                Lesson
              </Link>
            ) : null}
          </div>
        </header>

        <CoverageBar coverage={coverage} username={data.username} />
        <Filters username={data.username} params={params} />

        {data.graph ? (
          <>
            <FamilyChips
              families={data.families}
              active={focus.family}
              onSelect={selectFamily}
              repertoire={repertoire}
              onToggleRepertoire={toggleRepertoire}
            />
            <OpeningExplorer
              graph={data.graph}
              username={data.username}
              filterQuery={filterQuery}
              focusFamily={focus.family}
              focusWeakestKey={weakestKey}
              focusNonce={focus.nonce}
              playingAs={playingAs}
            />
          </>
        ) : (
          <section className="empty-opening-review">
            <h2>No opening map yet</h2>
            <p>Import and analyse games first so Tempo can build your position tree.</p>
          </section>
        )}
      </main>
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const message = error instanceof Error ? error.message : "Could not load your opening explorer.";
  return (
    <main className="grid min-h-dvh place-items-center p-6">
      <div className="panel max-w-lg p-8 text-center">
        <h1 className="text-2xl font-black">Opening explorer unavailable</h1>
        <p className="mt-3 text-sm leading-relaxed text-ink-muted">{message}</p>
        <Link to="/" className="primary-button mt-6 inline-flex">Return to overview</Link>
      </div>
    </main>
  );
}
