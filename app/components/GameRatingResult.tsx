import { useId, useState } from "react";
import { Estimate } from "./v1/Honesty";
import { ReplayBoard } from "./ReplayBoard";
import {
  colorName,
  momentWording,
  refusalWording,
  type Color,
  type DemandView,
  type GameHeaders,
  type MomentView,
  type OpeningView,
  type RatingView,
  type SideView,
} from "../lib/gameRating";

/**
 * A rating, rendered whole.
 *
 * One component for the number and its decomposition, because they are one
 * thing. The metric was built on the rule that the headline never travels
 * alone, and a separate `<Score>` component would be the first step toward a
 * screen that shows 7.4 and nothing else. Keeping them in one panel makes that
 * the harder thing to build rather than the easier one.
 *
 * Every figure here is measured. Where one is missing the panel says which and
 * why, rather than rendering a zero or an em dash that a reader would take for
 * a measurement of nothing.
 */

// The top rung of the ladder the human policy is conditioned on. Above it there
// is no stronger opponent to model, so the number stops being a level and
// becomes a floor — rendered "2400+" rather than dressed up as a measurement.
const LADDER_CEILING = 2400;

function strengthLabel(value: number): string {
  return value >= LADDER_CEILING ? `${LADDER_CEILING}+` : String(value);
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

const STAR_PATH =
  "M12 2.4l2.95 5.98 6.6.96-4.78 4.66 1.13 6.57L12 17.5l-5.9 3.07 1.13-6.57L2.45 9.34l6.6-.96z";

/**
 * The score as five stars.
 *
 * A second reading of the same number, not a second number: a ten-point scale
 * is precise but slow to take in, and a glance at four-and-a-bit stars lands
 * before the digits do. Halved rather than rescaled so the two always agree —
 * anything else would be two ratings on one page.
 */
function Stars({ rating }: { rating: number }) {
  const prefix = useId();
  const outOfFive = rating / 2;
  return (
    <div
      className="gr-stars"
      role="img"
      aria-label={`${outOfFive.toFixed(1)} out of 5 stars`}
    >
      {[0, 1, 2, 3, 4].map((index) => {
        const fill = Math.max(0, Math.min(1, outOfFive - index));
        const id = `${prefix}-star-${index}`;
        return (
          <svg key={index} className="gr-star" viewBox="0 0 24 24" aria-hidden="true">
            <defs>
              <linearGradient id={id} x1="0" x2="1" y1="0" y2="0">
                <stop offset={`${fill * 100}%`} stopColor="currentColor" />
                <stop offset={`${fill * 100}%`} stopColor="transparent" />
              </linearGradient>
            </defs>
            <path
              d={STAR_PATH}
              fill={`url(#${id})`}
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinejoin="round"
            />
          </svg>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// What the game was
// ---------------------------------------------------------------------------

function resultWording(result: string | null): string | null {
  if (!result) return null;
  if (result === "1-0") return "White won";
  if (result === "0-1") return "Black won";
  if (result === "1/2-1/2") return "Drawn";
  return null;
}

/**
 * The game's own identity, before anything is measured about it.
 *
 * A coach names the opening and says when the players stopped reciting, and
 * only then talks about quality. None of this feeds the rating — it is here
 * because a number attached to an anonymous game is a number nobody can place.
 */
function GameFacts({ opening, game }: { opening: OpeningView | null; game: GameHeaders }) {
  const line = opening?.name ?? null;
  const facts: string[] = [];
  if (game.moveCount) facts.push(`${game.moveCount} moves`);
  const outcome = resultWording(game.result);
  if (outcome) facts.push(outcome);
  if (game.timeControl && game.timeControl !== "-") facts.push(game.timeControl);
  if (game.termination && game.termination.toLowerCase() !== "normal") {
    facts.push(game.termination.toLowerCase());
  }

  if (!line && facts.length === 0) return null;

  return (
    <section className="gr-facts">
      {line ? (
        <p className="gr-opening">
          {opening?.eco ? <span className="gr-eco">{opening.eco}</span> : null}
          <span className="gr-opening-name">{line}</span>
        </p>
      ) : null}
      <p className="gr-facts-line">
        {opening?.leftBookAt ? (
          <>
            <span className="gr-fact-strong">
              Left theory at {opening.leftBookAt.moveNumber}
              {opening.leftBookAt.side === "white" ? "." : "…"}
              {opening.leftBookAt.san}
            </span>
            {facts.length > 0 ? <span className="gr-dot">·</span> : null}
          </>
        ) : null}
        {facts.map((fact, index) => (
          <span key={fact}>
            {fact}
            {index < facts.length - 1 ? <span className="gr-dot">·</span> : null}
          </span>
        ))}
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The two players
// ---------------------------------------------------------------------------

function Side({ side, name, elo }: { side: SideView; name: string | null; elo: number | null }) {
  return (
    <div className="gr-side">
      <h3>
        <span className={`gr-king gr-king-${side.color}`} aria-hidden="true">
          {side.color === "white" ? "♔" : "♚"}
        </span>
        <span className="gr-side-name">{name ?? colorName(side.color)}</span>
        {elo ? <span className="gr-side-elo">{elo}</span> : null}
      </h3>

      {/* `Estimate` rather than a formatted string: it is the component that
          already refuses to show a point without its interval, and a second
          way of saying the same thing would drift from it. */}
      <dl className="gr-figure">
        <dt>Played like</dt>
        <dd>
          <Estimate
            value={side.playedLike}
            low={side.playedLikeLow}
            high={side.playedLikeHigh}
            format={strengthLabel}
          />
        </dd>
      </dl>

      <dl className="gr-figure">
        <dt>Gave away</dt>
        <dd>
          <Estimate value={side.gaveAway} format={(value) => value.toFixed(3)} />
          {side.gaveAway === null ? null : <small>per live move</small>}
        </dd>
      </dl>
    </div>
  );
}

// ---------------------------------------------------------------------------
// What the game demanded
// ---------------------------------------------------------------------------

/**
 * The three demand terms, in a reader's words.
 *
 * "Tension" and "narrowness" are the names the scorer uses and they are precise
 * inside it, but on a public page they are jargon that means nothing without
 * the source. Each one keeps its number, gains a plain name, a sentence saying
 * what it measures, and the count it was computed from — because a bar reading
 * 1.00 with no scale beside it is decoration, not evidence.
 */
const LEVELS: Record<string, readonly [string, string, string, string, string]> = {
  sharpness: ["quiet", "occasionally sharp", "sharp", "very sharp", "as sharp as games get"],
  precision: ["forgiving", "mostly forgiving", "exacting", "punishing", "relentless"],
  pressure: [
    "decided early",
    "decided by the middlegame",
    "live for most of it",
    "live almost throughout",
    "live from first move to last",
  ],
};

function levelWord(kind: keyof typeof LEVELS, value: number): string {
  const words = LEVELS[kind]!;
  if (value < 0.2) return words[0];
  if (value < 0.45) return words[1];
  if (value < 0.7) return words[2];
  if (value < 0.9) return words[3];
  return words[4];
}

function Demand({ demand }: { demand: DemandView }) {
  const bars = [
    {
      kind: "sharpness" as const,
      label: "Sharpness",
      blurb: "how much a single move could swing",
      value: demand.tension,
      evidence: `${demand.meanTopCriticality.toFixed(2)} of a point at stake across the sharpest positions`,
    },
    {
      kind: "precision" as const,
      label: "Precision demanded",
      blurb: "how often exactly one move held",
      value: demand.narrowness,
      evidence: `${demand.onlyMoves} of ${demand.positionsExamined} examined positions had one move that held`,
    },
    {
      kind: "pressure" as const,
      label: "Time under pressure",
      blurb: "how long the game stayed undecided",
      value: demand.duration,
      evidence: `${demand.liveDecisions} of ${demand.totalDecisions} moves were played while the game was still live`,
    },
  ];

  return (
    <section className="gr-demand">
      <h2>How hard this game was to play</h2>
      <p className="gr-section-lede">
        The rating is graded against this. A clean win in a quiet game is not the same achievement
        as a clean win in a brawl, and these are the three things that separate them.
      </p>
      <div className="gr-bars">
        {bars.map((bar) => (
          <div className="gr-bar" key={bar.label}>
            <div className="gr-bar-head">
              <span className="gr-bar-label">{bar.label}</span>
              <span className="gr-bar-blurb">{bar.blurb}</span>
            </div>
            <div className="gr-bar-meter">
              <span className="gr-bar-track">
                <span className="gr-bar-fill" style={{ width: `${Math.round(bar.value * 100)}%` }} />
              </span>
              <span className="gr-bar-level">{levelWord(bar.kind, bar.value)}</span>
            </div>
            <p className="gr-bar-evidence">{bar.evidence}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Turning points
// ---------------------------------------------------------------------------

function moveLabel(moment: MomentView): string {
  const dots = moment.actor === "white" ? "." : "…";
  return `${moment.moveNumber}${dots}${moment.playedSan ?? ""}`;
}

function TurningPoints({
  moments,
  pgn,
  onPick,
}: {
  moments: MomentView[];
  pgn?: string;
  onPick: (ply: number) => void;
}) {
  return (
    <section className="gr-moments">
      <h2>Turning points</h2>
      <p className="gr-section-lede">
        The moves that moved the rating most, in the order they were played.
        {pgn ? " Pick one to put it on the board." : null}
      </p>
      <div className="gr-moment-list">
        {moments.map((moment) => {
          const label = (
            <>
              <span className="gr-moment-move">{moveLabel(moment)}</span>
              <span className="gr-moment-text">{momentWording(moment.code)}</span>
              <span className={`gr-moment-side gr-moment-side-${moment.actor}`}>
                {colorName(moment.actor)}
              </span>
            </>
          );
          // Only clickable when the game is on screen to be moved. A button
          // that scrolls to nothing is worse than a line of text.
          return pgn ? (
            <button
              type="button"
              className="gr-moment is-clickable"
              key={`${moment.ply}-${moment.code}`}
              onClick={() => onPick(moment.ply)}
            >
              {label}
            </button>
          ) : (
            <div className="gr-moment" key={`${moment.ply}-${moment.code}`}>
              {label}
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------

function playersLine(game: GameHeaders) {
  if (!game.white && !game.black) return null;
  return (
    <p className="gr-players">
      <b>{game.white ?? "White"}</b> against <b>{game.black ?? "Black"}</b>
      {game.event ? (
        <>
          <br />
          {game.event}
        </>
      ) : null}
      {game.date ? (
        <>
          <br />
          {game.date}
        </>
      ) : null}
    </p>
  );
}

export function GameRatingResult({ view, pgn }: { view: RatingView; pgn?: string }) {
  // Which position the board is showing. A named moment sets it, so reading
  // "gave the game away on move 22" and seeing move 22 is one click rather than
  // a hunt through somebody else's PGN.
  const [ply, setPly] = useState<number | null>(null);
  const players = playersLine(view.game);

  if (view.status === "unavailable") {
    return (
      <div className="gr-result">
        <div className="gr-headline">
          <p className="gr-score">
            <span>no rating</span>
          </p>
          {players}
        </div>
        <div className="gr-refusal">
          <h2>Forma will not rate this game</h2>
          <p>{refusalWording(view.reason)}</p>
        </div>
        <GameFacts opening={view.opening} game={view.game} />
        {view.white && view.black ? (
          <div className="gr-sides">
            <Side side={view.white} name={view.game.white} elo={view.game.whiteElo} />
            <Side side={view.black} name={view.game.black} elo={view.game.blackElo} />
          </div>
        ) : null}
        {view.demand ? <Demand demand={view.demand} /> : null}
        <p className="gr-method">
          {view.method.key}/{view.method.version} · {view.method.hash.slice(0, 12)}
        </p>
      </div>
    );
  }

  return (
    <div className="gr-result">
      <div className="gr-headline">
        <p className="gr-score">
          {view.rating.toFixed(1)}
          <span> / 10</span>
        </p>
        <Stars rating={view.rating} />
        <p className="gr-interval">
          {view.ratingLow.toFixed(1)} to {view.ratingHigh.toFixed(1)}
        </p>
        {players}
      </div>

      <GameFacts opening={view.opening} game={view.game} />

      <div className="gr-sides">
        <Side side={view.white} name={view.game.white} elo={view.game.whiteElo} />
        <Side side={view.black} name={view.game.black} elo={view.game.blackElo} />
      </div>

      {view.demand ? <Demand demand={view.demand} /> : null}

      {view.moments.length > 0 ? (
        <TurningPoints moments={view.moments} pgn={pgn} onPick={setPly} />
      ) : null}

      {pgn ? (
        <section className="gr-moments">
          <h2>The game</h2>
          <div className="gr-replay-wrap">
            <ReplayBoard pgn={pgn} autoPlay={false} jumpToPly={ply} />
          </div>
        </section>
      ) : null}

      <section className="gr-coverage">
        <h2>What this number is</h2>
        <p>
          {view.coverage.decisions} decisions were priced. Of those,{" "}
          {view.coverage.practicalDecisions} were also read against the player who had to answer
          them, which is what separates a sacrifice from a blunder.
        </p>
        <p>
          The rating is how well the game was played, by both sides, given what it asked of them. It
          is not a measure of how entertaining it was, and it does not know who won.
        </p>
        <p className="gr-method">
          {view.method.key}/{view.method.version} · {view.method.hash.slice(0, 12)}
        </p>
      </section>
    </div>
  );
}
