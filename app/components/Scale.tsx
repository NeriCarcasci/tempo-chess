import { useEffect, useRef, useState } from "react";
import { fetchReach, fetchReachFresh, type Reach, type ReachPlayer } from "../lib/reach";
import { LichessMark, ChessComMark } from "./PlatformMarks";
import { BetaForm } from "./BetaForm";

/**
 * How much chess Tempo has read: the figures, and the accounts they count.
 *
 * Both numbers come from `GET /stats/reach`, which counts rows (see
 * server/src/players/reach.ts — including the one documented exception, the
 * games baseline). Nothing here is a number a designer can bump.
 *
 * The band runs dark and full-bleed. Everything either side of it is warm paper
 * and white cards, so the one inversion on the page is the one section whose
 * job is to be looked at rather than read past.
 *
 * If the API cannot be reached the section does not render at all. There is no
 * placeholder and no dash: a band whose entire content is a claim about our
 * scale has nothing to say when it does not know the figure.
 */

/** The server caches for five minutes, so polling faster than this buys nothing. */
const POLL_MS = 5 * 60_000;
const COUNT_MS = 1400;
/** First load only. A cold API on a fresh deploy should not cost us the section. */
const RETRY_MS = [2_000, 6_000, 15_000];

/**
 * Below this the section stays hidden in production: a small true number is a
 * bad claim. Dev shows whatever is in the local database so the layout can be
 * designed against it.
 */
const MIN_GAMES = import.meta.env.DEV ? 1 : 200;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/* -- the drifting roster ------------------------------------------------- */

const WASH_ROWS = 4;

/**
 * Each row gets the whole roster, starting at a different account.
 *
 * Splitting the accounts *between* rows was the obvious version and it does not
 * fill: a couple of dozen handles divided four ways leaves rows narrower than a
 * wide monitor, so the wash sits in the middle as a tidy block instead of
 * running off both edges. Rotating the full list per row guarantees every row
 * overflows at any width, and no row repeats a handle within itself.
 */
function toRows(players: ReachPlayer[]): ReachPlayer[][] {
  if (players.length === 0) return [];
  const step = Math.max(1, Math.ceil(players.length / WASH_ROWS));
  return Array.from({ length: WASH_ROWS }, (_, r) => {
    const offset = (r * step) % players.length;
    return [...players.slice(offset), ...players.slice(0, offset)];
  });
}

/**
 * Deterministic per-handle opacity, from the handle itself. Random would give a
 * nicer scatter but would also change on every render, and a background that
 * reshuffles when React re-renders is worse than a slightly regular one.
 */
function washOpacity(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  // Ceiling deliberately low. The roster is a ground, not a second thing to
  // read: at the old range the brightest handles pulled the eye off the
  // figures, which is precisely backwards for a band whose whole point is the
  // two numbers.
  return 0.2 + (hash % 5) * 0.075;
}

/** Seconds per lap. Long, and prime-ish per row so the rows never re-sync. */
const ROW_SECONDS = [78, 97, 67, 109];

/**
 * The accounts themselves, drifting behind the figures.
 *
 * The row is rendered twice and the animation travels exactly -50%, which is
 * what makes the loop seamless: at the end of a lap the second copy is sitting
 * precisely where the first started, so there is no jump to hide. The duplicate
 * is aria-hidden along with everything else here — it is texture, and the
 * figures in front already say what it means.
 */
function Wash({ players }: { players: ReachPlayer[] }) {
  const rows = toRows(players);
  if (rows.length === 0) return null;
  return (
    <div className="scale-wash" aria-hidden="true">
      {rows.map((row, i) => (
        <div key={i} className="scale-wash-line">
          <div
            className="scale-wash-track"
            style={
              {
                "--dur": `${ROW_SECONDS[i % ROW_SECONDS.length]}s`,
                // Alternating direction reads as drift rather than as a
                // conveyor belt, which is the difference between motion that
                // sits behind content and motion that competes with it.
                "--dir": i % 2 === 0 ? "normal" : "reverse",
              } as React.CSSProperties
            }
          >
            {[0, 1].map((copy) =>
              row.map((player) => (
                <span
                  key={`${copy}:${player.username}`}
                  className="scale-chip"
                  style={{ opacity: washOpacity(player.username) }}
                >
                  {player.platform === "chesscom" ? (
                    <ChessComMark size={15} />
                  ) : (
                    <LichessMark size={15} />
                  )}
                  {player.username}
                </span>
              )),
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/* -- the figures --------------------------------------------------------- */

/**
 * Rolls from wherever it currently is to `value`, once `active`. On first
 * arrival that is from zero; on a later poll it is from the previous figure, so
 * an update reads as the number ticking up rather than as a flicker.
 */
function useCountUp(value: number, active: boolean): number {
  const [shown, setShown] = useState(0);
  const from = useRef(0);
  const frame = useRef(0);

  useEffect(() => {
    if (!active) return;
    if (prefersReducedMotion()) {
      from.current = value;
      setShown(value);
      return;
    }
    const origin = from.current;
    const delta = value - origin;
    if (delta === 0) return;
    const start = performance.now();

    const step = (now: number) => {
      const t = Math.min(1, (now - start) / COUNT_MS);
      // easeOutExpo — fast off the line, long settle.
      const eased = t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
      setShown(Math.round(origin + delta * eased));
      if (t < 1) frame.current = requestAnimationFrame(step);
      else from.current = value;
    };
    frame.current = requestAnimationFrame(step);

    /**
     * Land on the real figure whether the frames arrived or not.
     *
     * This matters more than the reveal's failsafe does. A reveal that never
     * fires hides the number; a roll-up that never fires *displays a different
     * number* — it would sit at 0 and read as "0 games analysed", which is not a
     * missing animation, it is a false statement about the product. rAF does not
     * run in a tab that is not compositing, so this is a real state.
     */
    const settle = window.setTimeout(() => {
      from.current = value;
      setShown(value);
    }, COUNT_MS + 250);

    return () => {
      cancelAnimationFrame(frame.current);
      window.clearTimeout(settle);
    };
  }, [value, active]);

  return shown;
}

function Stat({
  value,
  active,
  label,
}: {
  value: number;
  active: boolean;
  label: string;
}) {
  const shown = useCountUp(value, active);
  return (
    <div className="scale-stat">
      <strong className="scale-figure">{shown.toLocaleString("en-GB")}</strong>
      <span className="scale-label">{label}</span>
    </div>
  );
}

/* -- the section --------------------------------------------------------- */

export function Scale() {
  const [reach, setReach] = useState<Reach | null>(null);
  const [visible, setVisible] = useState(false);
  const [formOpen, setFormOpen] = useState(false);

  const nodeRef = useRef<HTMLElement>(null);
  const hasFigure = reach !== null;

  /**
   * Reveal, in an effect keyed on the figure arriving rather than in a callback
   * ref. Setting state straight from a ref loses the update: the section mounts
   * late, and the node is attached and re-attached during hydration, so the
   * update lands on an instance that is immediately replaced and the band stays
   * at opacity 0 forever.
   *
   * It measures the box before reaching for an observer, because the section
   * appears after the fetch resolves and may already be on screen by then — and
   * an IntersectionObserver registered on an element that is *already*
   * intersecting never fires a change.
   */
  useEffect(() => {
    const node = nodeRef.current;
    if (!hasFigure || !node) return;
    const box = node.getBoundingClientRect();
    const onScreen = box.top < window.innerHeight && box.bottom > 0;
    if (onScreen || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { threshold: 0.25 },
    );
    io.observe(node);
    // A decorative reveal must never be able to leave content permanently
    // hidden, and an observer in a non-compositing tab never reports.
    const failsafe = window.setTimeout(() => setVisible(true), 4000);
    return () => {
      io.disconnect();
      window.clearTimeout(failsafe);
    };
  }, [hasFigure]);

  useEffect(() => {
    let cancelled = false;
    const timers: number[] = [];
    const apply = (value: Reach | null) => {
      if (!cancelled && value) setReach(value);
      return value;
    };

    fetchReach()
      .then((first) => {
        if (apply(first)) return;
        RETRY_MS.forEach((delay) => {
          timers.push(
            window.setTimeout(() => {
              if (!cancelled) fetchReachFresh().then(apply).catch(() => {});
            }, delay),
          );
        });
      })
      .catch(() => {});

    // Only poll while the tab is actually being looked at. A backgrounded
    // landing page has no business making requests for hours.
    const tick = () => {
      if (document.visibilityState === "visible") {
        fetchReachFresh().then(apply).catch(() => {});
      }
    };
    const poll = window.setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      cancelled = true;
      window.clearInterval(poll);
      timers.forEach((t) => window.clearTimeout(t));
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);

  // No figure, or one too small to be worth quoting: no section.
  if (!reach || reach.games < MIN_GAMES) return null;

  return (
    <section className="scale" ref={nodeRef} aria-labelledby="scale-title">
      <div className={`scale-band ${visible ? "is-in" : ""}`}>
        <Wash players={reach.players_list ?? []} />

        <div className="scale-fore">
          {/* The figures are the headline. A sentence above them saying the same
              thing in words was the thing that did not fit. */}
          <h2 id="scale-title" className="scale-sr">
            How much chess Tempo has read
          </h2>

          <div className="scale-figures">
            <Stat value={reach.games} active={visible} label="games analysed" />
            <Stat value={reach.players} active={visible} label="players read" />
          </div>

          {/* The figures and the roster behind them already say this is real.
              This line is the only chance to say what any of it is for. */}
          <p className="scale-lede">
            Point it at your games and it finds what you keep repeating.
          </p>

          <button
            type="button"
            className="primary-button btn-lg scale-cta"
            onClick={() => setFormOpen(true)}
          >
            Join beta testing
          </button>
        </div>
      </div>

      <BetaForm open={formOpen} onClose={() => setFormOpen(false)} />
    </section>
  );
}
