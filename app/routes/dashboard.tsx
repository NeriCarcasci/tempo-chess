import { useLoaderData, useRouteError } from "react-router";
import {
  fetchProfile,
  fetchGames,
  aggregate,
  type Summary,
  type Profile,
  type GameLite,
} from "../lib/lichess";
import { Dashboard } from "../components/Dashboard";
import { requireSession } from "../lib/session";
import { api, apiMaybe, apiFetch } from "../lib/api";
import { rankOpeningFamilies, type OpeningExplorerData, type PlayerCoverage } from "../lib/openings";
import { getCached, setCached, invalidateCache } from "../lib/loaderCache";

interface SummarySource {
  profile: Profile;
  games: GameLite[];
  analysed: boolean;
}

interface DashboardData {
  summary: Summary;
  opening: OpeningExplorerData | null;
  coverage: PlayerCoverage | null;
  username: string;
  /** False when live Lichess data was unavailable and ratings are DB-derived. */
  live: boolean;
}

export function meta() {
  return [
    { title: "Dashboard · Tempo" },
    {
      name: "description",
      content:
        "Your record, ratings, openings, weak lines, and mistakes at a glance.",
    },
  ];
}

/**
 * Live Lichess data is richer — official ratings, and per-game analysis for the
 * games a player had Lichess analyse — but it rate-limits bursts, and the hub
 * used to collapse into a different page whenever it did. So we always load our
 * own database first (it answers every time) and prefer Lichess over the top
 * when it cooperates. Worst case the figures are reconstructed from imported
 * games and the page says so; it never changes shape.
 */
function overlayLiveProfile(base: Profile, live: Profile): Profile {
  return {
    ...base,
    ...live,
    // Live perfs win per-speed, but keep any speed we know about that Lichess
    // omits (e.g. a format they've stopped playing).
    perfs: { ...base.perfs, ...live.perfs },
    count: live.count?.all ? live.count : base.count,
  };
}

/**
 * Which game feed to aggregate. Lichess's feed carries its own accuracy and
 * blunder counts, which our games only have once deep analysis has run, so
 * prefer it when we have it rather than throwing that detail away.
 */
function pickGames(dbGames: GameLite[], liveGames: GameLite[] | null): GameLite[] {
  return liveGames && liveGames.length ? liveGames : dbGames;
}

export async function clientLoader(): Promise<DashboardData> {
  const session = await requireSession();
  const user = session.username;

  const cacheKey = `dashboard:${user}`;
  const cached = getCached<DashboardData>(cacheKey, 60_000);
  if (cached) return cached;

  const [source, opening0, coverage] = await Promise.all([
    api<SummarySource>("/me/summary"),
    apiMaybe<OpeningExplorerData>(`/opening-explorer?username=${encodeURIComponent(user)}`),
    apiMaybe<PlayerCoverage>(`/players/${encodeURIComponent(user)}/coverage`),
  ]);

  let opening = opening0;
  const first = opening ? rankOpeningFamilies(opening.families).find((f) => f.failures > 0) : null;
  if (first?.weakestNodeKey && opening?.selected?.nodeKey !== first.weakestNodeKey) {
    const query = new URLSearchParams({
      username: user,
      family: first.family,
      node: first.weakestNodeKey,
    });
    const selected = await apiMaybe<OpeningExplorerData>(`/opening-explorer?${query}`);
    if (selected) opening = selected;
  }

  let profile = source.profile;
  let liveGames: GameLite[] | null = null;
  let live = false;
  try {
    const signal = AbortSignal.timeout(4000);
    const [liveProfile, games] = await Promise.all([
      fetchProfile(user, signal),
      fetchGames(user, 100, signal),
    ]);
    profile = overlayLiveProfile(source.profile, liveProfile);
    liveGames = games;
    live = true;
  } catch {
    live = false;
  }

  const data: DashboardData = {
    summary: aggregate(profile, pickGames(source.games, liveGames)),
    opening,
    coverage,
    username: user,
    live,
  };
  setCached(cacheKey, data);
  return data;
}

export async function clientAction() {
  const response = await apiFetch("/imports/lichess", { json: { games: "all" } });
  const data = await response.json().catch(() => null) as
    | { import?: { requestedGames: number }; error?: string }
    | null;
  // A new import changes coverage/opening data across the hub and explorer — drop
  // the whole client cache so post-action revalidation reflects the sync.
  invalidateCache();
  if (!response.ok) return { ok: false, message: data?.error ?? "Could not sync games." };
  return { ok: true, message: `Syncing ${data?.import?.requestedGames ?? 0} games from Lichess.` };
}

export function ErrorBoundary() {
  const error = useRouteError();
  const message = error instanceof Error ? error.message : "Unknown error";
  return (
    <div className="grid min-h-dvh place-items-center px-6">
      <div className="max-w-md text-center">
        <h1 className="text-lg font-semibold text-ink">Couldn't load your dashboard</h1>
        <p className="mt-2 text-sm text-ink-muted">
          Something went wrong fetching your games. Try reloading — if it keeps
          happening, the analysis API may be down.
        </p>
        <p className="metric mt-3 text-xs text-ink-faint">{message}</p>
      </div>
    </div>
  );
}

export default function DashboardRoute() {
  const { summary, opening, coverage, live } = useLoaderData() as DashboardData;
  return <Dashboard summary={summary} opening={opening} coverage={coverage} live={live} />;
}
