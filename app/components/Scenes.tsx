import { Move } from "./Move";
import { PieceGlyph } from "./PieceGlyph";

/**
 * The diagrams, drawn from the product's own primitives. Shared: the home page
 * showcase and the features page both pull from here, so the same idea is never
 * illustrated two different ways.
 *
 * No captions and no bullet lists. A diagram that needs a paragraph underneath
 * explaining what it is has not been drawn well enough, and four of them turns a
 * features page back into the wall of text it was. Each section is a title, one
 * line, and the picture.
 *
 * These are diagrams, not screenshots, and not invented data dressed as real:
 * every opening and move is real chess, and nothing in here is a figure about
 * us. The one place we quote our own numbers is the Scale band, which counts
 * rows.
 */

/* -- patterns across everything you have played ------------------------- */

/**
 * A whole archive as one picture: a square per game, shaded by what we found.
 *
 * Written out rather than generated, so the picture is identical on every render
 * and in every review, and so the clustering is deliberate. Clusters are the
 * whole point: a habit shows up as a run of dark squares, which is exactly the
 * thing you cannot see one game at a time.
 */
// prettier-ignore
const INTENSITY = [
  0, 1, 0, 2, 1, 0, 0, 3, 1, 0, 1, 0,
  1, 0, 2, 3, 4, 1, 0, 1, 0, 2, 0, 1,
  0, 2, 1, 4, 3, 2, 1, 0, 1, 0, 0, 2,
  1, 0, 0, 2, 1, 0, 3, 4, 2, 1, 0, 0,
  0, 1, 2, 1, 0, 1, 0, 2, 3, 1, 0, 1,
];

export function PatternScene() {
  return (
    <div className="fx" aria-hidden="true">
      <div className="fx-grid">
        {INTENSITY.map((level, i) => (
          <span key={i} className="fx-game" data-level={level} />
        ))}
      </div>
    </div>
  );
}

/* -- openings, by family ------------------------------------------------ */

/**
 * A family and the variations under it, stacked, worst line on top.
 *
 * Families rather than moves: nobody thinks "my 2...d6 lines are weak", they
 * think "my Dragon is weak". The tree is the level a player already reasons at,
 * so it is the level the map is drawn at.
 *
 * The order is the product's rule made visible — worst line first. The two you
 * are doing fine in sit behind it, inset and faded, so the eye lands on the one
 * that is costing you without the others being hidden. The connectors this
 * replaced were three dashed curves fanning out of a box, which is decoration
 * pretending to be information.
 */
const VARIATIONS = [
  { name: "Dragon", rate: 37, weak: true },
  { name: "Najdorf", rate: 58 },
  { name: "Classical", rate: 52 },
];

export function OpeningScene() {
  return (
    <div className="fx fx-openings">
      {/* Mastery, not a percentile. The model scores each opening 0-100 and
          flags it (see calculateMastery); it does not rank you against other
          players, so a "top N%" here would be advertising something the
          product does not compute. */}
      <div className="fx-family">
        <span className="fx-family-name">
          <b>Sicilian</b>
          <i>41 games</i>
        </span>
        <span className="fx-mastery">
          <i>mastery</i>
          <b>46</b>
        </span>
      </div>

      <div className="fx-stack">
        {VARIATIONS.map((v) => (
          <span key={v.name} className={`fx-var ${v.weak ? "is-weak" : ""}`}>
            <b>{v.name}</b>
            <span className="fx-rate" aria-hidden="true">
              <i style={{ width: `${v.rate}%` }} />
            </span>
            <em>{v.rate}%</em>
          </span>
        ))}
      </div>
    </div>
  );
}

/* -- the move, the better move, and why --------------------------------- */

/**
 * One finding, laid out the way the product states it: what you played and what
 * it cost, against what the engine wanted, then the reason in a sentence.
 *
 * The previous version was three rows of severity chips with no position and no
 * comparison, which said "we categorise things" rather than "we explain them" —
 * the opposite of the section it belonged to.
 */
export function ReasonScene() {
  return (
    <div className="fx">
      <div className="fx-compare">
        <span className="fx-side is-yours">
          <i>you played</i>
          <b>
            <Move san="h6" white={false} />
          </b>
          <em>−1.0</em>
        </span>
        <span className="fx-side is-best">
          <i>engine</i>
          <b>
            <Move san="Bd6" white={false} />
          </b>
          <em>+0.2</em>
        </span>
      </div>
      <p className="fx-why">
        <span className="fx-sev">blunder</span>
        h6 lets the knight into e6. The centre opens with your king still in it,
        and the pawn cannot be taken back.
      </p>
    </div>
  );
}

/* -- somewhere to put the work ------------------------------------------ */

/** A line part-played, with the next move withheld. That is the whole drill. */
const LINE = [
  { san: "e4", white: true },
  { san: "c5", white: false },
  { san: "Nf3", white: true },
  { san: "d6", white: false },
  { san: "d4", white: true },
];

/** The three lengths a line can be drilled at, as the trainer offers them. */
const DEPTHS = ["quick", "standard", "deep"];

export function TrainerScene() {
  return (
    <div className="fx">
      <div className="fx-line">
        {LINE.map((m) => (
          <span key={m.san} className="fx-step">
            <Move san={m.san} white={m.white} />
          </span>
        ))}
        <span className="fx-step is-asking" aria-hidden="true">
          <PieceGlyph letter="n" white={false} className="fx-ghost" />
          <i>?</i>
        </span>
      </div>
      {/* Depth and progress: both are things the trainer records per attempt
          (see opening_training_results — moves correct, moves total, reveals),
          not decoration invented to fill the card. */}
      <div className="fx-trainer-foot" aria-hidden="true">
        <div className="fx-depths">
          {DEPTHS.map((d) => (
            <span key={d} className={`fx-depth ${d === "standard" ? "is-on" : ""}`}>
              {d}
            </span>
          ))}
        </div>
        <span className="fx-progress">
          <b>5</b> of 12 <i>·</i> <b>1</b> reveal
        </span>
      </div>
    </div>
  );
}

/* -- stockfish on every move -------------------------------------------- */

/**
 * Every one of Black's plies in the game the hero board shows, priced by our
 * own Stockfish at depth 18. These are measured, not typed: run the position
 * through `analyzeFens(fens, 18)` and you get these numbers back. At 7...h6 the
 * engine's own best move is g5e6 — the capture the hero callout names.
 *
 * Black's plies, so every glyph in this list is a black piece.
 */
const PLIES: Array<{ move: string; evalCp: number; flagged?: boolean }> = [
  { move: "1...c6", evalCp: 41 },
  { move: "2...d5", evalCp: 35 },
  { move: "3...dxe4", evalCp: 22 },
  { move: "4...Nd7", evalCp: 41 },
  { move: "5...Ngf6", evalCp: 50 },
  { move: "6...e6", evalCp: 49 },
  { move: "7...h6", evalCp: 98, flagged: true },
];

export function EngineScene() {
  return (
    <div className="fx fx-plies">
      {PLIES.map((ply) => (
        <div key={ply.move} className={`fx-ply ${ply.flagged ? "is-flagged" : ""}`}>
          <b>
            <Move san={ply.move} white={false} />
          </b>
          <span className="fx-bar" aria-hidden="true">
            {/* The bar is the evaluation itself, capped at two pawns. */}
            <i style={{ width: `${Math.min(100, (ply.evalCp / 200) * 100)}%` }} />
          </span>
          <em>+{(ply.evalCp / 100).toFixed(1)}</em>
        </div>
      ))}
    </div>
  );
}

/* -- the archive, at hero size ------------------------------------------ */

/**
 * The same idea as the showcase card, sized to open a page: a cell per game
 * across the whole width, shaded by what the pass found in it.
 *
 * Generated rather than hand-written, because a few hundred cells is too many
 * to author — but generated *deterministically*, from a fixed seed, so it is
 * the same picture on every render and in every review. The swell term is what
 * makes it look like a history instead of static: bad patches arrive in runs,
 * which is exactly the thing the page underneath is about.
 */
const HERO_CELLS = 330;

function heroIntensity(): number[] {
  let x = 0x9e3779b9;
  const next = () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 0xffffffff;
  };
  return Array.from({ length: HERO_CELLS }, (_, i) => {
    // Two slow waves, so clusters form and then break up again.
    const swell = (Math.sin(i / 23) + Math.sin(i / 7.5)) / 2;
    const r = next() + swell * 0.42;
    if (r > 1.2) return 4;
    if (r > 0.95) return 3;
    if (r > 0.68) return 2;
    if (r > 0.36) return 1;
    return 0;
  });
}

const HERO = heroIntensity();

export function ArchiveHero() {
  return (
    <div className="fx-hero" aria-hidden="true">
      {HERO.map((level, i) => (
        <span key={i} className="fx-game" data-level={level} />
      ))}
    </div>
  );
}

/* -- the tree your own games made --------------------------------------- */

/**
 * What the opening explorer puts in front of you at a position: the moves you
 * have actually played from here, your record in each, and what the engine
 * makes of it.
 *
 * Two numbers per row on purpose. The explorer's whole argument is that those
 * two can disagree — a move you score well with that the engine dislikes is
 * worth knowing about, and so is the reverse.
 */
const CANDIDATES = [
  { san: "Nc3", games: 12, rate: 58, evalCp: 30 },
  { san: "Bc4", games: 9, rate: 31, evalCp: -40, weak: true },
  { san: "d4", games: 5, rate: 50, evalCp: 20 },
];

/** The line you walked to get here. */
const WALKED = [
  { san: "e4", white: true },
  { san: "c5", white: false },
  { san: "Nf3", white: true },
];

export function ExplorerScene() {
  return (
    <div className="fx fx-explorer">
      <div className="fx-walked">
        {WALKED.map((m) => (
          <span key={m.san} className="fx-step">
            <Move san={m.san} white={m.white} />
          </span>
        ))}
      </div>

      <ul className="fx-candidates">
        {CANDIDATES.map((c) => (
          <li key={c.san} className={c.weak ? "is-weak" : ""}>
            <b>
              <Move san={c.san} white />
            </b>
            <span className="fx-rate" aria-hidden="true">
              <i style={{ width: `${c.rate}%` }} />
            </span>
            <em>{c.rate}%</em>
            <span className="fx-eval">
              {c.evalCp >= 0 ? "+" : "\u2212"}
              {Math.abs(c.evalCp / 100).toFixed(1)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* -- the queue of your own mistakes ------------------------------------- */

/**
 * The drill queue, ordered the way the product orders it: frequency times
 * severity, so the habit that costs most turns up first rather than the single
 * worst moment.
 */
const QUEUE = [
  { san: "h6", severity: "blunder", seen: 7, cost: "1.0", next: true },
  { san: "Bd6", severity: "mistake", seen: 4, cost: "0.6" },
  { san: "Ne5", severity: "inaccuracy", seen: 3, cost: "0.3" },
];

export function QueueScene() {
  return (
    <div className="fx fx-queue">
      <ul>
        {QUEUE.map((q) => (
          <li key={q.san} className={q.next ? "is-next" : ""}>
            <b>
              <Move san={q.san} white={false} />
            </b>
            <span className={`fx-sev is-${q.severity}`}>{q.severity}</span>
            <span className="fx-seen">seen {q.seen}×</span>
            <em>−{q.cost}</em>
          </li>
        ))}
      </ul>
    </div>
  );
}
