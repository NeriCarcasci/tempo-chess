import { useEffect, useRef, useState } from "react";
import { RookMark } from "./Logo";
import { OpeningScene, PatternScene } from "./Scenes";
import { LichessMark, ChessComMark } from "./PlatformMarks";

/**
 * The three cards under the reach band: where the games come from, the shape
 * they make, and the openings underneath that shape.
 *
 * Each card is a heading, one line, and a diagram built from the product's own
 * primitives. Nothing here is a screenshot of a screen that does not exist.
 * The last two come from Scenes.tsx, shared with the features page, so the same
 * idea is never illustrated two different ways.
 */

/**
 * Reveals a card once it enters the viewport. IntersectionObserver, not scroll.
 *
 * The failsafe matters more than it looks: these cards start at opacity 0, so
 * anything that stops the observer reporting — a tab that never composites, for
 * one — takes the entire section with it. Four seconds and it appears whether
 * the observer spoke or not. A reveal may cost an animation; it must never cost
 * the content.
 */
function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(true);
          io.disconnect();
        }
      },
      { threshold: 0.25 },
    );
    io.observe(node);
    const failsafe = window.setTimeout(() => setShown(true), 4000);
    return () => {
      io.disconnect();
      window.clearTimeout(failsafe);
    };
  }, []);
  return { ref, shown };
}

function Card({
  title,
  blurb,
  wide,
  badge,
  children,
}: {
  title: string;
  blurb: string;
  wide?: boolean;
  /** Rendered outside the scene so it can hang over the card's bottom edge. */
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { ref, shown } = useReveal<HTMLElement>();
  return (
    <article ref={ref} className={`sc-card ${wide ? "is-wide" : ""} ${shown ? "is-in" : ""}`}>
      <header>
        <h3>{title}</h3>
        <p>{blurb}</p>
      </header>
      <div className="sc-scene">{children}</div>
      {badge}
    </article>
  );
}

/* -- connect ------------------------------------------------------- */

/**
 * Where your games come from: the platforms across the top, Forma underneath,
 * everything flowing down into it.
 *
 * The mark is not part of the scene. It is rendered as the card's `badge` and
 * pinned to the card's bottom edge, half on and half off, so it sits over the
 * join between this card and the two below it — the arriving games and the two
 * things Forma then does with them are one object, not three tiles in a row.
 *
 * Nodes sit at fixed fractions of the scene and the wires are drawn in that
 * same fractional space, so an endpoint can never drift away from the tile it
 * belongs to. The opaque tiles cover the last few pixels of each wire, which is
 * what makes the joins look deliberate rather than stopping short. See
 * PlatformMarks.tsx for why only one of these two carries a real logo.
 */
const PLATFORMS = [
  { id: "lichess", label: "Lichess", host: "lichess.org", x: 18 },
  { id: "chesscom", label: "Chess.com", host: "chess.com", x: 82 },
] as const;

/** Where the tiles sit, and where the mark is, in the wire SVG's coordinates. */
const NODE_Y = 30;
const CORE_X = 50;
const CORE_Y = 104;

function ConnectScene() {
  return (
    <div className="sc-hub">
      {/* preserveAspectRatio="none" stretches these curves with the card, which
          is what keeps each wire's tail glued to its tile at every width. The
          stroke is exempted from the stretch by vector-effect. */}
      <svg className="sc-wires" viewBox="0 0 100 110" preserveAspectRatio="none" aria-hidden="true">
        {PLATFORMS.map((p) => (
          <path
            key={p.id}
            // Leaves the tile heading down, turns late, and arrives at the mark
            // vertically, so the two wires meet it as a pair rather than a V.
            d={`M${p.x} ${NODE_Y} C ${p.x} ${NODE_Y + 40}, ${CORE_X} ${CORE_Y - 46}, ${CORE_X} ${CORE_Y}`}
          />
        ))}
      </svg>

      {PLATFORMS.map((p) => (
        <div key={p.id} className="sc-node" style={{ left: `${p.x}%` }}>
          <span className="sc-node-mark">
            {p.id === "lichess" ? <LichessMark size={19} /> : <ChessComMark size={19} />}
          </span>
          <span className="sc-node-text">
            <b>{p.label}</b>
            <i>{p.host}</i>
          </span>
        </div>
      ))}
    </div>
  );
}

/** The mark itself, positioned against the card rather than the scene. */
function ConnectBadge() {
  return (
    <div className="sc-core" aria-hidden="true">
      <RookMark size={40} />
    </div>
  );
}

/* -- the section ------------------------------------------------------- */

export function Showcase() {
  return (
    <section className="sc">
      <h2 className="section-title">One username, and the pattern shows up</h2>
      <div className="sc-grid">
        <Card
          wide
          title="Connect"
          blurb="One username. Forma pulls your whole archive from Lichess or Chess.com, however far back it goes."
          badge={<ConnectBadge />}
        >
          <ConnectScene />
        </Card>
        <Card title="Patterns" blurb="Every game you have played, shaded by what we found in it.">
          <PatternScene />
        </Card>
        <Card title="Openings" blurb="Every family you play, with the record you actually have.">
          <OpeningScene />
        </Card>
      </div>
    </section>
  );
}
