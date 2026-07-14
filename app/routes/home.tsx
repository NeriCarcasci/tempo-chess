import { useLoaderData, useRouteError } from "react-router";
import { fetchProfile, fetchGames, aggregate, type Summary } from "../lib/lichess";
import { Dashboard } from "../components/Dashboard";

const DEMO_USER = "ncarcasc";

export function meta() {
  return [
    { title: "Tempo Chess — ncarcasc" },
    {
      name: "description",
      content:
        "Multi-game chess analysis: your record, ratings, openings, weak lines, and mistakes at a glance.",
    },
  ];
}

export async function clientLoader() {
  const [profile, games] = await Promise.all([
    fetchProfile(DEMO_USER),
    fetchGames(DEMO_USER, 100),
  ]);
  return { summary: aggregate(profile, games) };
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
  const { summary } = useLoaderData() as { summary: Summary };
  return <Dashboard summary={summary} />;
}
