import { useLoaderData, useRouteError } from "react-router";
import { fetchGame, type GameData } from "../lib/game";
import { GameReview } from "../components/GameReview";
import { requireSession } from "../lib/session";
import { fetchReviewByLichessId, type ReviewLookup } from "../lib/v1/review";
import type { Route } from "./+types/game";

export function meta() {
  return [{ title: "Game review · Forma" }];
}

export async function clientLoader({ params, request }: Route.ClientLoaderArgs) {
  await requireSession();
  const ply = Number(new URL(request.url).searchParams.get("ply"));
  const id = params.id ?? "";
  // Fetched together rather than in sequence: the moves come from Lichess and
  // the review from Forma, neither needs the other, and waiting for the second
  // to start the first would add a round trip to the board appearing.
  //
  // The review is allowed to be absent. The board is worth drawing for a game
  // Forma has never seen, so a lookup that finds nothing costs one panel.
  const [game, review] = await Promise.all([
    fetchGame(id),
    fetchReviewByLichessId(id),
  ]);
  return {
    game,
    review,
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
  const { game, initialPly, review } = useLoaderData() as {
    game: GameData;
    initialPly: number | null;
    review: ReviewLookup;
  };
  return <GameReview game={game} initialPly={initialPly} review={review} />;
}
