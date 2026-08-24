import { useState } from "react";
import { Estimate } from "./v1/Honesty";
import { ReplayBoard } from "./ReplayBoard";
import {
  colorName,
  momentWording,
  refusalWording,
  type DemandView,
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

function Side({ side }: { side: SideView }) {
  return (
    <div className="gr-side">
      <h3>
        <span className={`gr-disc gr-disc-${side.color}`} aria-hidden="true" />
        {colorName(side.color)}
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
            format={(value) => String(value)}
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

      {side.outOfDomain && side.playedLike !== null ? (
        <>
          <span className="tag tag-sub">Outside the calibrated band</span>
          <p className="gr-caveat">
            This side played above the range Forma has calibrated, so read the band rather than the
            number inside it.
          </p>
        </>
      ) : null}

      {!side.ratingDeclared ? (
        <p className="gr-caveat">
          No rating was declared for this player, so the opponent model was conditioned on how the
          game was actually played.
        </p>
      ) : null}
    </div>
  );
}

function Demand({ demand }: { demand: DemandView }) {
  const bars = [
    { label: "Tension", value: demand.tension },
    { label: "Narrowness", value: demand.narrowness },
    { label: "Duration", value: demand.duration },
  ];
  return (
    <section className="gr-demand">
      <h2>What the game asked</h2>
      <div className="gr-bars">
        {bars.map((bar) => (
          <div className="gr-bar" key={bar.label}>
            <span className="gr-bar-label">{bar.label}</span>
            <span className="gr-bar-track">
              <span
                className="gr-bar-fill"
                style={{ width: `${Math.round(bar.value * 100)}%` }}
              />
            </span>
            <span className="gr-bar-value">{bar.value.toFixed(2)}</span>
          </div>
        ))}
      </div>
      <p className="gr-caveat">
        {demand.positionsExamined} positions examined closely, {demand.onlyMoves} of them with a
        single move that held.
      </p>
    </section>
  );
}

export function GameRatingResult({ view, pgn }: { view: RatingView; pgn?: string }) {
  // Which position the board is showing. A named moment sets it, so reading
  // "gave the game away on move 22" and seeing move 22 is one click rather than
  // a hunt through somebody else's PGN.
  const [ply, setPly] = useState<number | null>(null);
  const players =
    view.game.white || view.game.black ? (
      <p className="gr-players">
        <b>{view.game.white ?? "White"}</b> against <b>{view.game.black ?? "Black"}</b>
        {view.game.event ? <><br />{view.game.event}</> : null}
        {view.game.date ? <><br />{view.game.date}</> : null}
      </p>
    ) : null;

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
        {view.white && view.black ? (
          <div className="gr-sides">
            <Side side={view.white} />
            <Side side={view.black} />
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
        <p className="gr-interval">
          {view.ratingLow.toFixed(1)} to {view.ratingHigh.toFixed(1)}
        </p>
        {players}
      </div>

      <div className="gr-sides">
        <Side side={view.white} />
        <Side side={view.black} />
      </div>

      {view.demand ? <Demand demand={view.demand} /> : null}

      {view.moments.length > 0 ? (
        <section className="gr-moments">
          <h2>What moved the number</h2>
          <div className="gr-moment-list">
            {view.moments.map((moment) => {
              const label = (
                <>
                  <span className="gr-moment-move">
                    {moment.moveNumber}
                    {moment.actor === "white" ? "." : "..."}
                  </span>
                  <span className="gr-moment-text">{momentWording(moment.code)}</span>
                  <span className="gr-moment-side">{colorName(moment.actor)}</span>
                </>
              );
              // Only clickable when the game is on screen to be moved. A button
              // that scrolls to nothing is worse than a line of text.
              return pgn ? (
                <button
                  type="button"
                  className="gr-moment is-clickable"
                  key={`${moment.ply}-${moment.code}`}
                  onClick={() => setPly(moment.ply)}
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
