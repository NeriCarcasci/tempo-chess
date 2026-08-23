import { Estimate } from "./v1/Honesty";
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
    <div className="rate-side">
      <h3>
        <span className={`rate-disc rate-disc-${side.color}`} aria-hidden="true" />
        {colorName(side.color)}
      </h3>

      {/* `Estimate` rather than a formatted string: it is the component that
          already refuses to show a point without its interval, and a second
          way of saying the same thing would drift from it. */}
      <dl className="rate-figure">
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

      <dl className="rate-figure">
        <dt>Gave away</dt>
        <dd>
          <Estimate value={side.gaveAway} format={(value) => value.toFixed(3)} />
          {side.gaveAway === null ? null : <small>per live move</small>}
        </dd>
      </dl>

      {side.outOfDomain && side.playedLike !== null ? (
        <>
          <span className="tag tag-sub">Outside the calibrated band</span>
          <p className="rate-caveat">
            This side played above the range Forma has calibrated, so read the band rather than the
            number inside it.
          </p>
        </>
      ) : null}

      {!side.ratingDeclared ? (
        <p className="rate-caveat">
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
    <section className="rate-demand">
      <h2>What the game asked</h2>
      <div className="rate-bars">
        {bars.map((bar) => (
          <div className="rate-bar" key={bar.label}>
            <span className="rate-bar-label">{bar.label}</span>
            <span className="rate-bar-track">
              <span
                className="rate-bar-fill"
                style={{ width: `${Math.round(bar.value * 100)}%` }}
              />
            </span>
            <span className="rate-bar-value">{bar.value.toFixed(2)}</span>
          </div>
        ))}
      </div>
      <p className="rate-caveat">
        {demand.positionsExamined} positions examined closely, {demand.onlyMoves} of them with a
        single move that held.
      </p>
    </section>
  );
}

export function GameRatingResult({ view }: { view: RatingView }) {
  const players =
    view.game.white || view.game.black ? (
      <p className="rate-players">
        <b>{view.game.white ?? "White"}</b> against <b>{view.game.black ?? "Black"}</b>
        {view.game.event ? <><br />{view.game.event}</> : null}
        {view.game.date ? <><br />{view.game.date}</> : null}
      </p>
    ) : null;

  if (view.status === "unavailable") {
    return (
      <div className="rate-result">
        <div className="rate-headline">
          <p className="rate-score">
            <span>no rating</span>
          </p>
          {players}
        </div>
        <div className="rate-refusal">
          <h2>Forma will not rate this game</h2>
          <p>{refusalWording(view.reason)}</p>
        </div>
        {view.white && view.black ? (
          <div className="rate-sides">
            <Side side={view.white} />
            <Side side={view.black} />
          </div>
        ) : null}
        {view.demand ? <Demand demand={view.demand} /> : null}
        <p className="rate-method">
          {view.method.key}/{view.method.version} · {view.method.hash.slice(0, 12)}
        </p>
      </div>
    );
  }

  return (
    <div className="rate-result">
      <div className="rate-headline">
        <p className="rate-score">
          {view.rating.toFixed(1)}
          <span> / 10</span>
        </p>
        <p className="rate-interval">
          {view.ratingLow.toFixed(1)} to {view.ratingHigh.toFixed(1)}
        </p>
        {players}
      </div>

      <div className="rate-sides">
        <Side side={view.white} />
        <Side side={view.black} />
      </div>

      {view.demand ? <Demand demand={view.demand} /> : null}

      {view.moments.length > 0 ? (
        <section className="rate-moments">
          <h2>What moved the number</h2>
          <div className="rate-moment-list">
            {view.moments.map((moment) => (
              <div className="rate-moment" key={`${moment.ply}-${moment.code}`}>
                <span className="rate-moment-move">
                  {moment.moveNumber}
                  {moment.actor === "white" ? "." : "..."}
                </span>
                <span className="rate-moment-text">{momentWording(moment.code)}</span>
                <span className="rate-moment-side">{colorName(moment.actor)}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="rate-coverage">
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
        <p className="rate-method">
          {view.method.key}/{view.method.version} · {view.method.hash.slice(0, 12)}
        </p>
      </section>
    </div>
  );
}
