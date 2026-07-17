import { useLoaderData, useRouteError } from "react-router";
import { fetchProfile, fetchGames, aggregate, type Summary } from "../lib/lichess";
import { Dashboard } from "../components/Dashboard";
import { rankOpeningFamilies, type OpeningExplorerData, type PlayerCoverage } from "../lib/openings";
import type { Route } from "./+types/home";

const DEMO_USER = "ncarcasc";
const API = import.meta.env.DEV ? "/api" : (import.meta.env.VITE_ENGINE_URL ?? "/api");

export function meta() {
  return [
    { title: "Tempo Chess · ncarcasc" },
    {
      name: "description",
      content:
        "Multi-game chess analysis: your record, ratings, openings, weak lines, and mistakes at a glance.",
    },
  ];
}

export async function clientLoader() {
  const [profile, games, openingResponse, coverageResponse] = await Promise.all([
    fetchProfile(DEMO_USER),
    fetchGames(DEMO_USER, 100),
    fetch(`${API}/opening-explorer?username=${encodeURIComponent(DEMO_USER)}`),
    fetch(`${API}/players/${encodeURIComponent(DEMO_USER)}/coverage`),
  ]);
  let opening = openingResponse.ok
    ? await openingResponse.json() as OpeningExplorerData
    : null;
  const coverage = coverageResponse.ok
    ? await coverageResponse.json() as PlayerCoverage
    : null;
  const first = opening ? rankOpeningFamilies(opening.families).find((family) => family.failures > 0) : null;
  if (first?.weakestNodeKey && opening?.selected?.nodeKey !== first.weakestNodeKey) {
    const query = new URLSearchParams({
      username: DEMO_USER,
      family: first.family,
      node: first.weakestNodeKey,
    });
    const selectedResponse = await fetch(`${API}/opening-explorer?${query}`);
    if (selectedResponse.ok) opening = await selectedResponse.json() as OpeningExplorerData;
  }
  return { summary: aggregate(profile, games), opening, coverage };
}

export async function clientAction({ request }: Route.ClientActionArgs) {
  const form = await request.formData();
  const response = await fetch(`${API}/imports/lichess`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: form.get("username"), games: "all" }),
  });
  const data = await response.json();
  if (!response.ok) return { ok: false, message: data.error ?? "Could not sync games." };
  return { ok: true, message: `Syncing ${data.import.requestedGames} games from Lichess.` };
}

export function ErrorBoundary() {
  const error = useRouteError();
  const message = error instanceof Error ? error.message : "Unknown error";
  return (
    <div className="grid min-h-dvh place-items-center px-6">
      <div className="max-w-md text-center">
        <h1 className="text-lg font-semibold text-ink">Couldn't load games</h1>
        <p className="mt-2 text-sm text-ink-muted">
          Lichess didn't return data for this account. It may be private, rate-limited,
          or offline.
        </p>
        <p className="metric mt-3 text-xs text-ink-faint">{message}</p>
      </div>
    </div>
  );
}

export default function Home() {
  const { summary, opening, coverage } = useLoaderData() as {
    summary: Summary;
    opening: OpeningExplorerData | null;
    coverage: PlayerCoverage | null;
  };
  return <Dashboard summary={summary} opening={opening} coverage={coverage} />;
}
