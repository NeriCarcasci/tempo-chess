import { Link } from "react-router";
import { PublicPage } from "../components/PublicShell";
import { HeroBoard } from "../components/HeroBoard";
import { RookMark } from "../components/Logo";

export function meta() {
  return [
    { title: "Tempo · Your mistakes have a shape" },
    {
      name: "description",
      content:
        "Tempo reads every game you have played, finds the mistakes you repeat, and turns them into drills.",
    },
  ];
}

const STEPS = [
  {
    title: "Connect",
    body: "Your Lichess or Chess.com username. Tempo pulls the whole archive, not the last ten games.",
  },
  {
    title: "Analyse",
    body: "Stockfish walks every move and records what each decision actually cost you.",
  },
  {
    title: "Drill",
    body: "The positions you got wrong come back as puzzles, hardest first.",
  },
];

const NOT = [
  ["No streaks or badges.", "Practising to protect a streak is not practising."],
  ["No forty-metric dashboard.", "Every number on screen informs one decision."],
  ["No flattering summary.", "If your rating is down, that is the first thing you see."],
];

export default function Home() {
  return (
    <PublicPage>
      <section className="hero">
        <div className="hero-copy">
          <h1>
            Your mistakes
            <br />
            have a <em>shape</em>.
          </h1>
          <p>
            Tempo reads every game you have played, finds the errors you repeat,
            and turns them into drills.
          </p>
          <div className="hero-actions">
            <Link to="/signup" className="primary-button btn-lg">Analyse my games</Link>
            <Link to="/features" className="secondary-button btn-lg">How it works</Link>
          </div>
        </div>
        <HeroBoard />
      </section>

      <section className="statement">
        <p>
          Reviewing one game tells you what went wrong <i>once</i>. Tempo reads
          your whole history at once, so the mistake you have made forty times
          stops looking like bad luck.
        </p>
      </section>

      <section className="flow">
        <h2 className="section-title">Three steps to the first drill</h2>
        <ol className="flow-track">
          {STEPS.map((step, i) => (
            <li key={step.title}>
              <span className="flow-dot metric">{i + 1}</span>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="bento">
        <p className="eyebrow">What a whole history gives you</p>
        <div className="bento-grid">
          <article className="bento-cell bento-lead">
            <h3>An opening map drawn from your own games</h3>
            <p>
              Not what grandmasters play. What you play, with your score at every
              branch, and a marker on the move where your preparation runs out.
            </p>
            <Link to="/features#repertoire" className="text-link">
              See the repertoire map <span aria-hidden="true">&rarr;</span>
            </Link>
          </article>

          <article className="bento-cell bento-accent">
            <RookMark size={104} className="bento-glyph" />
            <h3>Mistakes explained in words</h3>
            <p>The tactic you missed, not a centipawn number and silence.</p>
          </article>

          <article className="bento-cell">
            <h3>Drills built from your own errors</h3>
            <p>Same position, same side, one more chance to find it.</p>
          </article>

          <article className="bento-cell">
            <h3>Thirteen guided opening lessons</h3>
            <p>Move by move, with the reason behind each one.</p>
          </article>
        </div>
      </section>

      <section className="refuse">
        <h2 className="section-title">What Tempo will not do</h2>
        <dl className="refuse-list">
          {NOT.map(([claim, why]) => (
            <div key={claim}>
              <dt>{claim}</dt>
              <dd>{why}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="closer">
        <h2>The analysis is already sitting in your game history.</h2>
        <Link to="/signup" className="primary-button btn-lg">Start free</Link>
        <p>Your last 50 games, no card needed.</p>
      </section>
    </PublicPage>
  );
}
