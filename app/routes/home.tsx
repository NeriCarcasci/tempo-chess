import type { Route } from "./+types/home";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Tempo Chess — know where your vision ends" },
    {
      name: "description",
      content:
        "Automatic multi-game analysis for chess.com and Lichess. Turn every blunder into a puzzle, find your weak lines, and get openings matched to how you actually play.",
    },
  ];
}

export default function Home() {
  return (
    <main className="min-h-dvh bg-neutral-950 text-neutral-100">
      <div className="mx-auto max-w-3xl px-6 py-24">
        <p className="mb-4 text-sm font-medium uppercase tracking-widest text-emerald-400">
          Tempo Chess
        </p>
        <h1 className="text-4xl font-semibold leading-tight sm:text-5xl">
          Know where your vision ends.
        </h1>
        <p className="mt-6 max-w-2xl text-lg text-neutral-400">
          Connect your chess.com and Lichess accounts. Every game is analyzed,
          every mistake recorded and explained, and each blunder becomes a
          puzzle you can solve again — so you actually stop repeating them.
        </p>

        <div className="mt-10 grid gap-4 sm:grid-cols-3">
          {[
            {
              t: "Every mistake, captured",
              d: "Accurate blunder & missed-idea detection across all your games.",
            },
            {
              t: "A reason for every move",
              d: "Plain-English explanations — the tactic you missed, the idea you skipped.",
            },
            {
              t: "Openings for how you play",
              d: "Style-matched repertoire suggestions and weak-line drilling.",
            },
          ].map((f) => (
            <div
              key={f.t}
              className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5"
            >
              <h2 className="text-sm font-semibold text-neutral-100">{f.t}</h2>
              <p className="mt-2 text-sm text-neutral-400">{f.d}</p>
            </div>
          ))}
        </div>

        <p className="mt-12 text-sm text-neutral-600">
          Skeleton in progress · Phase 0
        </p>
      </div>
    </main>
  );
}
