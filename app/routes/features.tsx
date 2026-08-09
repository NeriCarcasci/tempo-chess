import { Link } from "react-router";
import { PublicPage } from "../components/PublicShell";

export function meta() {
  return [
    { title: "Features · Tempo" },
    {
      name: "description",
      content:
        "Whole-history engine analysis, a repertoire map built from your own games, mistakes explained in words, and drills made from your errors.",
    },
  ];
}

interface Section {
  id: string;
  title: string;
  lede: string;
  points: Array<[string, string]>;
}

const SECTIONS: Section[] = [
  {
    id: "analysis",
    title: "Every game read as one body of evidence",
    lede: "Single-game review answers what went wrong in this game. That is a different question from what keeps going wrong.",
    points: [
      ["Stockfish on every move", "Each decision gets an evaluation before and after, so the cost of a move is measured rather than guessed."],
      ["Mistakes stored, not counted", "The position, your move, the engine's move, and the damage. That is what makes it re-servable as practice."],
      ["Small samples stay honest", "Win rates carry confidence intervals and get shrunk toward your baseline, so five games cannot masquerade as a weakness."],
    ],
  },
  {
    id: "repertoire",
    title: "An opening map drawn from your games",
    lede: "Opening books tell you what strong players do. Your map tells you where your own preparation stops working.",
    points: [
      ["Your own position tree", "Every position you have reached, linked by the moves you actually played, with your record at each branch."],
      ["The worst line opens first", "Tempo ranks your openings by what they cost you. You do not have to know where to look."],
      ["Lines you chose on purpose", "Mark the moves you intend to play, and departures from your own repertoire become findings."],
    ],
  },
  {
    id: "mistakes",
    title: "Explained in words, then put back on the board",
    lede: "A centipawn number tells you that you were wrong. It does not tell you what you failed to see.",
    points: [
      ["The idea you missed", "Each mistake carries a plain-language reason: the tactic that was there, the threat you allowed."],
      ["Where your vision ends", "Tempo records how deep the winning idea was. Missing two-move ideas is a different problem from missing five-move ones."],
      ["Ranked by damage", "The drill queue is ordered by frequency times severity, so you practise the expensive habit first."],
    ],
  },
  {
    id: "training",
    title: "Somewhere to put the work",
    lede: "Diagnosis without practice is a nicer way to lose.",
    points: [
      ["Thirteen guided lessons", "Openings taught move by move with the reason behind each one, every line validated on a real board."],
      ["Line trainer", "Drill a line from your own repertoire at quick, standard, or deep length, with reveals when you are stuck."],
      ["Play it out", "Reached a position you do not understand? Play it against an engine capped near your rating."],
    ],
  },
];

export default function Features() {
  return (
    <PublicPage>
      <header className="page-head">
        <h1>What Tempo actually does</h1>
        <p>
          Four surfaces, one idea: measure everything you have played, find the
          failures that repeat, and give you somewhere to fix them.
        </p>
      </header>

      {SECTIONS.map((section) => (
        <section key={section.id} id={section.id} className="feature-section">
          <div className="feature-row">
            <div>
              <h2>{section.title}</h2>
              <p>{section.lede}</p>
            </div>
            <div className="feature-points">
              {section.points.map(([title, body]) => (
                <div key={title}>
                  <strong>{title}</strong>
                  <p>{body}</p>
                </div>
              ))}
            </div>
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
