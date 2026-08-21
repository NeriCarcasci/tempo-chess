import { useEffect, useRef, useState } from "react";
import { fetchReach, fetchReachFresh, type Reach } from "../lib/reach";
import type { PublicFigure } from "../lib/v1/types";
import { BetaForm } from "./BetaForm";

/**
 * How much chess Forma has read.
 *
 * Both numbers come from `GET /v1/public/stats`, which counts rows (see
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
 *
 * ## Why the roster behind the figures is gone
 *
 * Four rows of drifting handles used to sit behind the numbers, taken from the
 * same join that produced the count. `/v1/public/stats` does not publish them:
 * they are real accounts screened from public arena results, and the contract
 * requires opt-in before a provider handle is shown anywhere. The response
 * names the omission in its own redaction block rather than dropping it
 * quietly. Nothing invented replaces it — the figures were always the headline,
 * and the wash was the evidence, not the claim.
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

/**
 * A count the API may decline to give exactly.
 *
 * `/v1/public/stats` suppresses a player count small enough to identify
 * somebody and answers "fewer than N" instead. That is a different sentence
 * from the number, so it is drawn as one: no roll-up, because there is no value
 * to roll up to, and never a zero, which is the reading a bare dash invites.
 */
function FigureStat({
  figure,
  active,
  label,
}: {
  figure: PublicFigure;
  active: boolean;
  label: string;
}) {
  if (figure.disclosure === "exact") {
    return <Stat value={figure.value} active={active} label={label} />;
  }
  return (
    <div className="scale-stat">
      <strong className="scale-figure">fewer than {figure.below.toLocaleString("en-GB")}</strong>
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
        <div className="scale-fore">
          {/* The figures are the headline. A sentence above them saying the same
              thing in words was the thing that did not fit. */}
          <h2 id="scale-title" className="scale-sr">
            How much chess Forma has read
          </h2>

          <div className="scale-figures">
            <Stat value={reach.games} active={visible} label="games analysed" />
            <FigureStat figure={reach.players} active={visible} label="players read" />
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
