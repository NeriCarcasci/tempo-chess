import { Link } from "react-router";
import { TopNav } from "../components/TopNav";
import { requireSession } from "../lib/session";

/**
 * Middlegame and Endgame, before they have a surface.
 *
 * These are placeholders and they say so. The pipeline already classifies
 * every ply as opening, middlegame or endgame (`server/src/analysis/phase.ts`)
 * and stores `phase`, `motif` and `severity` on every mistake, but nothing
 * exposes an aggregate over that yet: `/training/mistakes` reads opening
 * observations only, so it cannot feed either page.
 *
 * The distinction matters. "No mistakes found" would be a claim about the
 * player's chess, and it would be false. What is true is that the work is
 * analysed and the page is not built, so that is what the page says.
 */

interface PhaseCopy {
  current: "middlegame" | "endgame";
  title: string;
  /** What the page will hold, concretely enough to be checkable later. */
  lede: string;
  contents: string[];
}

const COPY: Record<"middlegame" | "endgame", PhaseCopy> = {
  middlegame: {
    current: "middlegame",
    title: "Middlegame",
    lede:
      "Every mistake you make once the opening is over, grouped by the idea you missed rather than by the game it happened in.",
    contents: [
      "Your mistakes grouped by motif: forks, hanging pieces, back rank, overloaded defenders.",
      "How deep the winning idea was each time, so you can see where your vision stops.",
      "The same positions as drills, worst first.",
    ],
  },
  endgame: {
    current: "endgame",
    title: "Endgame",
    lede:
      "The endgames you actually reach, and what you do with them once the pieces come off.",
    contents: [
      "Your endgames grouped by material: rook and pawn, opposite bishops, king and pawn.",
      "Which ones you convert, and which ones you draw or lose from a won position.",
      "The positions you went wrong in, as drills.",
    ],
  },
};

export async function clientLoader() {
  await requireSession();
  return null;
}

export function PhasePage({ phase }: { phase: "middlegame" | "endgame" }) {
  const copy = COPY[phase];
  return (
    <div className="relative z-10 min-h-dvh">
      <TopNav current={copy.current} />
      <main className="phase-shell">
        <header className="phase-head">
          <h1>{copy.title}</h1>
          <p>{copy.lede}</p>
        </header>

        <section className="phase-pending">
          <h2>Not built yet</h2>
          <p>
            Your games are already analysed for this. Every move you have played is
            classified by phase, and every mistake is stored with the idea you missed.
            What is missing is this page, not the data.
          </p>
          <ul>
            {copy.contents.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <Link to="/openings" className="secondary-button">
            Go to openings
          </Link>
        </section>
      </main>
    </div>
  );
}
