import { useLoaderData, useRouteError } from "react-router";
import { fetchGame, type GameData } from "../lib/game";
import { GameReview } from "../components/GameReview";
import { requireSession } from "../lib/session";
import type { Route } from "./+types/game";

export function meta() {
  return [{ title: "Game review · Forma" }];
}

export async function clientLoader({ params, request }: Route.ClientLoaderArgs) {
  await requireSession();
  const ply = Number(new URL(request.url).searchParams.get("ply"));
  return {
    game: await fetchGame(params.id ?? ""),
    initialPly: Number.isInteger(ply) && ply > 0 ? ply : null,
  };
}

export function HydrateFallbackNote() {
  return null;
}

export function ErrorBoundary() {
  const error = useRouteError();
  const message = error instanceof Error ? error.message : "Unknown error";
  return (
    <div className="grid min-h-dvh place-items-center px-6">
      <div className="max-w-md text-center">
        <h1 className="font-serif text-xl text-ink">Couldn't load that game</h1>
        <p className="mt-2 text-sm text-ink-muted">
          Lichess didn't return it. It may be private, ongoing, or the id is wrong.
        </p>
        <p className="metric mt-3 text-xs text-ink-faint">{message}</p>
        <a href="/" className="cap mt-6 inline-block transition-colors hover:text-ink">
          ← Back to report
        </a>
      </div>
    </div>
  );
}

export default function GamePage() {
  const { game, initialPly } = useLoaderData() as { game: GameData; initialPly: number | null };
  return <GameReview game={game} initialPly={initialPly} />;
}
