import { RookMark } from "../Logo";
import { ChessComMark, LichessMark } from "../PlatformMarks";
import type { Provider } from "./ProviderChoice";

/**
 * The accent half of the connect card: what you have wired into Forma so far.
 *
 * Not decoration. The figure starts as the mark alone, with nothing running
 * into it, and gains a feed each time an account is linked — so the picture is
 * the state of the thing being built rather than a poster beside the form that
 * builds it. That is what makes the card worth splitting in two: before, the
 * left half was the only half that changed.
 *
 * ## What the motion is for
 *
 * DESIGN.md lets an animation ship only once it can name its job, and these
 * two can. A node **arrives** because something was just added, and its wire
 * **reaches** the mark because that is the connection being made. The flowing
 * dashes then keep the landing page's meaning: games moving from a platform
 * into Forma. Every one of them is legible in its final state with the
 * animation never running, and all of it stops under `prefers-reduced-motion`.
 *
 * The reach is a `clip-path` wipe from the top down rather than a
 * `stroke-dashoffset` draw, because the stroke is already spending its dash
 * array on the flow. Two animations fighting over `stroke-dasharray` is a wire
 * that stutters at the handover; a wipe leaves the dashes alone and reveals
 * them travelling, which is the effect the draw was reaching for anyway.
 *
 * ## Why one feed does not flow
 *
 * A Chess.com account can be linked and cannot be read yet. Drawing games
 * pouring out of it would be the picture telling a lie the copy is careful not
 * to tell, so its wire connects and stays still, and its label says so. The
 * honesty rule holds in a diagram exactly as it does in a sentence.
 */

/** Where each feed sits across the panel, in the wire SVG's own coordinates. */
const FEEDS = {
  lichess: { label: "Lichess", host: "lichess.org", x: 22 },
  chesscom: { label: "Chess.com", host: "chess.com", x: 78 },
} as const;

const NODE_Y = 26;
const CORE_X = 50;
const CORE_Y = 100;

/** Only Lichess archives can actually be read today. See `sync/providers.ts`. */
const READABLE: Provider[] = ["lichess"];

export interface PanelFeed {
  provider: Provider;
  /** Keyed on the account, so re-rendering never replays a node's arrival. */
  key: string;
}

export function ConnectPanel({ feeds }: { feeds: readonly PanelFeed[] }) {
  const wired = feeds.filter((feed) => FEEDS[feed.provider]);

  return (
    <aside className="connect-aside" aria-hidden="true">
      <div className={`connect-figure${wired.length ? " has-feeds" : ""}`}>
        {/* preserveAspectRatio="none" stretches the curves with the panel, so an
            endpoint can never drift off the tile it belongs to at any height.
            The strokes opt out with vector-effect, so a wire is the same weight
            on a phone and on a monitor. */}
        <svg
          className="connect-wires"
          viewBox="0 0 100 112"
          preserveAspectRatio="none"
          focusable="false"
        >
          {wired.map((feed, index) => {
            const spec = FEEDS[feed.provider];
            const flows = READABLE.includes(feed.provider);
            return (
              <g
                key={feed.key}
                className="connect-wire"
                style={{ animationDelay: `${220 + index * 90}ms` }}
              >
                <path
                  className={flows ? "is-flowing" : "is-still"}
                  // Leaves the tile heading down, turns late, and arrives at the
                  // mark vertically, so two wires meet it as a pair rather than
                  // closing into a V.
                  d={`M${spec.x} ${NODE_Y} C ${spec.x} ${NODE_Y + 42}, ${CORE_X} ${CORE_Y - 48}, ${CORE_X} ${CORE_Y}`}
                />
              </g>
            );
          })}
        </svg>

        {wired.map((feed, index) => {
          const spec = FEEDS[feed.provider];
          const readable = READABLE.includes(feed.provider);
          return (
            <div
              key={feed.key}
              className="connect-node"
              style={{ left: `${spec.x}%`, animationDelay: `${index * 90}ms` }}
            >
              <span className="connect-node-mark">
                {feed.provider === "chesscom" ? (
                  <ChessComMark size={17} />
                ) : (
                  <LichessMark size={17} />
                )}
              </span>
              <span className="connect-node-text">
                <b>{spec.label}</b>
                <i>{readable ? spec.host : "not read yet"}</i>
              </span>
            </div>
          );
        })}

        {/* Alone in the middle until something feeds it, then it settles to the
            foot of the panel where the wires arrive. Transform only, so the
            move costs no layout and nothing under it shifts. */}
        <div className="connect-core">
          <RookMark size={38} />
        </div>
      </div>
    </aside>
  );
}
