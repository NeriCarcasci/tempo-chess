import { Link } from "react-router";
import { PublicPage } from "../components/PublicShell";
import { PieceGlyph } from "../components/PieceGlyph";
import {
  ArchiveHero,
  EngineScene,
  ExplorerScene,
  QueueScene,
  ReasonScene,
  TrainerScene,
} from "../components/Scenes";

export function meta() {
  return [
    { title: "Features · Tempo" },
    {
      name: "description",
      content:
        "Connect a Lichess or Chess.com account and Tempo prices every move you have played, maps your openings, explains each mistake, and turns the expensive ones into drills.",
    },
  ];
}

interface Section {
  id: string;
  /** An ascending piece instead of a number. */
  piece: string;
  title: string;
  lede: string;
  scene: React.ReactNode;
}

/**
 * What you can actually do, in the order you would do it: connect, look,
 * understand, practise. Each one is a surface that exists — the explorer, the
 * game review, the drill queue, the repertoire trainer — not a capability
 * invented for a marketing page.
 */
const SECTIONS: Section[] = [
  {
    id: "connect",
    piece: "p",
    scene: <EngineScene />,
    title: "Point it at your username",
    lede: "Your Lichess or Chess.com archive comes back priced move by move, however far back it goes. Nothing to upload.",
  },
  {
    id: "explorer",
    piece: "n",
    scene: <ExplorerScene />,
    title: "Walk the tree your own games made",
    lede: "Every position you have reached, your record at each move from it, and what the engine makes of the same choice.",
  },
  {
    id: "review",
    piece: "b",
    scene: <ReasonScene />,
    title: "Find out why, not just what",
    lede: "Each finding names the idea you missed and what allowing it cost, next to the move the engine wanted.",
  },
  {
    id: "drills",
    piece: "r",
    scene: <QueueScene />,
    title: "Drill the mistakes you actually made",
    lede: "Your own positions come back as puzzles, ordered by how often the mistake repeats and what it costs.",
  },
  {
    id: "repertoire",
    piece: "q",
    scene: <TrainerScene />,
    title: "Rehearse the lines you chose",
    lede: "Mark the moves you mean to play and drill them at three depths. Or play the position out against a bot capped near your rating.",
  },
];

export default function Features() {
  return (
    <PublicPage>
      {/* The archive itself opens the page. It is the one picture that says
          what the product is before a word of it is read. */}
      <header className="page-head feature-hero">
        <h1>Everything you have played, in one pass</h1>
        <p>
          Connect an account and Tempo reads the lot: what you play, where it
          goes wrong, and what to practise about it.
        </p>
        <ArchiveHero />
      </header>

      {/* Sections alternate which side the diagram falls on. Identical rows
          read as a form to fill in; alternating them reads as a page. */}
      {SECTIONS.map((section, i) => (
        <section
          key={section.id}
          id={section.id}
          className={`feature ${i % 2 === 1 ? "is-flipped" : ""}`}
        >
          <div className="feature-inner">
            <div className="feature-copy">
              <PieceGlyph letter={section.piece} white={false} className="feature-piece" />
              <h2>{section.title}</h2>
              <p className="feature-lede">{section.lede}</p>
            </div>
            <div className="feature-visual">{section.scene}</div>
          </div>
        </section>
      ))}

      <section className="closer">
        <h2>It is already sitting in your game history.</h2>
        <Link to="/signup" className="primary-button btn-lg">Start free</Link>
        <p>Your last 50 games, no card needed.</p>
      </section>
    </PublicPage>
  );
}
