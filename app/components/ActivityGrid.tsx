import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PlayDay } from "../lib/lichess";
import { usePrefersReducedMotion } from "./charts";

/**
 * A year of play, one square per day, coloured by how the day went.
 *
 * The familiar contribution grid shades by volume, which for chess answers the
 * least interesting question — you already know whether you played. What you
 * cannot see anywhere else is the *shape* of your results over time: that you
 * are fine on weeknights and lose every Sunday, that a bad run lasted eleven
 * days, that the tilt after a loss is real and visible.
 *
 * So the axis is the result, not the count. Green days are days you won more
 * than you lost, red days the reverse, and a day you played once sits pale
 * because one game is not evidence. Volume survives as opacity, which keeps it
 * present without competing.
 */

const DAY_MS = 86_400_000;
/** Below this a day's win rate is noise, so the square stays neutral. */
const MIN_FOR_COLOUR = 2;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

type Cell = { key: string; day: PlayDay | null; date: Date; future: boolean };

function keyOf(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/**
 * The grid reads down each column as a week, so the last column has to be the
 * current week and every column has to start on the same weekday. We walk back
 * from the Saturday that closes this week; the trailing days of the final
 * column are in the future and render as gaps rather than as unplayed days.
 */
function buildCells(days: PlayDay[]): { cells: Cell[]; weeks: number } {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const today = new Date();
  today.setHours(12, 0, 0, 0); // midday, so DST shifts cannot roll the date
  const end = new Date(today.getTime() + (6 - today.getDay()) * DAY_MS);

  // Long enough to hold the history, short enough not to open on a wall of
  // empty squares: a three-month-old account should not be shown nine months
  // of nothing to prove the grid can render it.
  const oldest = days[0] ? new Date(`${days[0].date}T12:00:00`) : today;
  const span = Math.ceil((end.getTime() - oldest.getTime()) / (7 * DAY_MS)) + 1;
  const weeks = Math.max(10, Math.min(52, span));
  const start = new Date(end.getTime() - (weeks * 7 - 1) * DAY_MS);

  const cells = Array.from({ length: weeks * 7 }, (_, i) => {
    const date = new Date(start.getTime() + i * DAY_MS);
    const key = keyOf(date);
    return { key, date, day: byDate.get(key) ?? null, future: date > today };
  });
  return { cells, weeks };
}

/**
 * Three things the squares imply but do not say.
 *
 * All of them are about *when*, which is the question this view is uniquely
 * able to answer — an openings chart can tell you the Sicilian costs you
 * games, but nothing else you have tells you that Sunday does.
 */
function insights(days: PlayDay[]) {
  const rate = (d: PlayDay) => (d.win + d.loss ? d.win / (d.win + d.loss) : 0.5);
  const solid = days.filter((d) => d.games >= 3);

  // "You play most on Thursday" needs more than one Thursday behind it. Below
  // a couple of weeks of days that sentence is just restating the only day in
  // the data as though it were a habit.
  const byWeekday = new Map<number, { games: number; win: number; loss: number }>();
  for (const d of days.length >= 6 ? days : []) {
    const wd = new Date(`${d.date}T12:00:00`).getDay();
    const acc = byWeekday.get(wd) ?? { games: 0, win: 0, loss: 0 };
    acc.games += d.games;
    acc.win += d.win;
    acc.loss += d.loss;
    byWeekday.set(wd, acc);
  }
  const busiest = [...byWeekday.entries()].sort((a, b) => b[1].games - a[1].games)[0];

  // A day is only "your best" if you actually won it. With a thin history the
  // top of the list can be a day you lost 1–2, and presenting that as a high
  // point is worse than presenting nothing.
  const best = [...solid].sort((a, b) => rate(b) - rate(a)).find((d) => rate(d) > 0.5);

  // The longest run of consecutive played days, which is the one streak that
  // means something here — a gap is a day off, not a loss.
  let streak = 0;
  let run = 0;
  let prev: number | null = null;
  for (const d of days) {
    const t = new Date(`${d.date}T12:00:00`).getTime();
    run = prev != null && t - prev <= DAY_MS * 1.5 ? run + 1 : 1;
    streak = Math.max(streak, run);
    prev = t;
  }

  return { busiest, best, streak };
}

/** −1 (lost the day) through +1 (won it), or null when there is too little. */
function dayScore(day: PlayDay | null): number | null {
  if (!day || day.games < MIN_FOR_COLOUR) return null;
  const decisive = day.win + day.loss;
  if (!decisive) return 0;
  return (day.win - day.loss) / decisive;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function describe(cell: Cell): string {
  const when = cell.date.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  if (!cell.day) return `${when}: no games`;
  const { games, win, draw, loss } = cell.day;
  return `${when}: ${games} game${games === 1 ? "" : "s"}, ${win}W ${draw}D ${loss}L`;
}

export function ActivityGrid({
  days,
  intro,
  record,
}: {
  days: PlayDay[];
  intro: boolean;
  /**
   * The whole-history record, folded into the calendar head — the "how am I
   * doing" numbers live with the "when did it happen" picture, instead of
   * getting a masthead of their own.
   */
  record?: { all: number; win: number; draw: number; loss: number; winRate: number };
}) {
  const reduced = usePrefersReducedMotion();
  const { cells, weeks } = useMemo(() => buildCells(days), [days]);
  const facts = useMemo(() => insights(days), [days]);
  const [hover, setHover] = useState<Cell | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  // The intro is a one-off flourish, so it is a class that goes on and comes
  // off again rather than a permanent state — leaving it on would replay the
  // fall on every re-render of the list.
  //
  // It cannot seed useState from `intro`: the first-visit flag is read from
  // storage in an effect, so it is false on the first render and useState
  // would keep that false forever. The class is driven by the prop instead.
  const [falling, setFalling] = useState(false);
  useLayoutEffect(() => {
    if (!intro || reduced) return;
    setFalling(true);
    const t = setTimeout(() => setFalling(false), 3000);
    return () => clearTimeout(t);
  }, [intro, reduced]);

  const played = days.reduce((n, d) => n + d.games, 0);
  const active = cells.filter((c) => c.day).length;

  // Month names sit over the column where the month turns over, so the ruler
  // lines up with the squares instead of being evenly spaced fiction.
  const months: Array<{ col: number; label: string }> = [];
  for (let w = 0; w < weeks; w++) {
    const first = cells[w * 7];
    if (!first) continue;
    const prev = w > 0 ? cells[(w - 1) * 7] : null;
    if (!prev || prev.date.getMonth() !== first.date.getMonth()) {
      months.push({ col: w + 1, label: MONTHS[first.date.getMonth()] });
    }
  }

  return (
    <div className="activity">
      <div className="activity-head">
        <div>
          <h2 className="font-serif text-2xl text-ink">Every day you played</h2>
          <p className="mt-1.5 text-sm text-ink-muted">
            {played.toLocaleString("en-GB")} games across {active} day
            {active === 1 ? "" : "s"} — green where you won more than you lost.
          </p>
          {record ? (
            <p className="mt-1 text-sm text-ink-faint">
              All time: {Math.round(record.winRate * 100)}% win rate ·{" "}
              <b className="font-semibold" style={{ color: "var(--color-win)" }}>{record.win}</b>W{" "}
              <b className="font-semibold">{record.draw}</b>D{" "}
              <b className="font-semibold" style={{ color: "var(--color-loss)" }}>{record.loss}</b>L
            </p>
          ) : null}
        </div>
        <div className="activity-key" aria-hidden="true">
          <span>lost the day</span>
          <i data-score="-2" />
          <i data-score="-1" />
          <i data-score="0" />
          <i data-score="1" />
          <i data-score="2" />
          <span>won it</span>
        </div>
      </div>

      <div className="activity-scroll">
        <div
          ref={wrap}
          className={`activity-grid ${falling ? "is-falling" : ""}`}
          style={{ "--weeks": weeks } as React.CSSProperties}
          onMouseLeave={() => setHover(null)}
        >
          <div className="activity-months">
            {months.map((m) => (
              <span key={`${m.col}-${m.label}`} style={{ gridColumn: m.col }}>
                {m.label}
              </span>
            ))}
          </div>
          {/* Row 1 is the month ruler, so the week starts at row 2 (Sunday). */}
          <div className="activity-days" aria-hidden="true">
            <span style={{ gridRow: 3 }}>Mon</span>
            <span style={{ gridRow: 5 }}>Wed</span>
            <span style={{ gridRow: 7 }}>Fri</span>
          </div>

          {cells.map((cell, i) => {
            const score = dayScore(cell.day);
            // Cells are laid out column-by-column, so index/7 is the week and
            // index%7 the weekday. The rain leads with the column and only
            // trails down inside it; a per-cell random delay reads as static.
            const delay = Math.floor(i / 7) * 32 + (i % 7) * 24;
            return (
              <button
                key={cell.key}
                type="button"
                className="activity-cell"
                data-empty={!cell.day || undefined}
                data-future={cell.future || undefined}
                data-score={score == null ? undefined : Math.round(score * 2)}
                style={{
                  "--d": `${delay}ms`,
                  "--vol": cell.day ? Math.min(1, 0.45 + cell.day.games / 10) : 1,
                } as React.CSSProperties}
                onMouseEnter={() => setHover(cell)}
                onFocus={() => setHover(cell)}
                aria-label={describe(cell)}
              />
            );
          })}
        </div>
      </div>

      {/* One live region rather than a tooltip per cell, so the reading stays
          in the same place and screen readers get a single announcement. */}
      <p className="activity-read" aria-live="polite">
        {hover ? describe(hover) : "Hover a day to see how it went."}
      </p>

      {/* What the squares imply but cannot say. Each one is a sentence, not a
          stat tile: "Sunday · 38%" makes you do the work, "you play most on
          Sunday and score 38% there" is the finding itself. */}
      <dl className="activity-facts" hidden={!facts.busiest && !facts.best && facts.streak <= 1}>
        {facts.busiest ? (
          <div>
            <dt>You play most on</dt>
            <dd>
              {WEEKDAYS[facts.busiest[0]]}
              <span>
                {facts.busiest[1].games} games ·{" "}
                {facts.busiest[1].win + facts.busiest[1].loss
                  ? Math.round(
                      (facts.busiest[1].win / (facts.busiest[1].win + facts.busiest[1].loss)) * 100,
                    )
                  : 50}
                % of decisive ones won
              </span>
            </dd>
          </div>
        ) : null}
        {facts.best ? (
          <div>
            <dt>Your best day</dt>
            <dd>
              {new Date(`${facts.best.date}T12:00:00`).toLocaleDateString(undefined, {
                day: "numeric",
                month: "long",
              })}
              <span>
                {facts.best.win}W {facts.best.draw}D {facts.best.loss}L over {facts.best.games} games
              </span>
            </dd>
          </div>
        ) : null}
        {facts.streak > 1 ? (
          <div>
            <dt>Longest run of days</dt>
            <dd>
              {facts.streak} in a row
              <span>consecutive days with at least one game</span>
            </dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}
