import { useLayoutEffect, useState } from "react";
import { Link, useFetcher } from "react-router";
import type { Summary, GameLite, FormatStat, Result } from "../lib/lichess";
import {
  handledPercent,
  rankOpeningFamilies,
  reliabilityLabel,
  type OpeningExplorerData,
  type PlayerCoverage,
} from "../lib/openings";
import { pct, relTime, signed } from "../lib/format";
import { CountUp, RatingLine, DivergingOpenings } from "./charts";
import { Board } from "./Board";
import { InfoTip } from "./InfoTip";
import { TopNav } from "./TopNav";
import { Move } from "./Move";
import { openingFamily } from "../lib/openingFamily";
import { ActivityGrid } from "./ActivityGrid";
import { OpeningMap } from "./OpeningMap";

/**
 * True once per browser, on the first dashboard this person ever opens.
 *
 * Read in an effect rather than during render: the flag lives in localStorage,
 * and touching it while rendering would make the first paint depend on storage
 * that a private window can refuse outright.
 */
function useFirstVisit(): boolean {
  const [first, setFirst] = useState(false);
  // Layout effect, not a plain one: this decides whether an animation plays,
  // and a plain effect resolves after the first paint, so the grid would flash
  // in its settled state for a frame before falling.
  useLayoutEffect(() => {
    try {
      if (localStorage.getItem("tempo.seen-dashboard")) return;
      localStorage.setItem("tempo.seen-dashboard", "1");
      setFirst(true);
    } catch {
      // Storage denied: no intro rather than one on every single load.
    }
  }, []);
  return first;
}

const RESULT: Record<Result, { color: string; label: string }> = {
  win: { color: "var(--color-win)", label: "W" },
  loss: { color: "var(--color-loss)", label: "L" },
  draw: { color: "var(--color-draw)", label: "D" },
};

// One game's opening, said the way a player says it. Unlike the results chart
// this never falls back to "Other": on a single row the actual name beats a
// bucket label, even when the opening is too rare to chart.
const family = (name: string) => openingFamily(name) ?? name.split(":")[0].trim();

function ResultChip({ result }: { result: Result }) {
  const r = RESULT[result];
  return (
    <span
      className="metric grid h-6 w-6 place-items-center rounded-[5px] text-xs font-semibold"
      style={{ color: r.color, background: `color-mix(in oklch, ${r.color} 15%, transparent)` }}
    >
      {r.label}
    </span>
  );
}

/**
 * The nav carries navigation and one action, nothing else.
 *
 * It used to also state the platform, the handle, whether the figures were
 * live, and a permanently disabled "Up to date" button — four pieces of status
 * in the one strip that follows you onto every screen. The handle and platform
 * now sit in the masthead, which is where the page says who this is; the
 * offline caveat sits beside the ratings it qualifies; and the sync button only
 * appears when there is in fact something to sync, because a disabled control
 * is a claim dressed up as an affordance.
 */
function TopBar({
  username,
  coverage,
  best,
}: {
  username: string;
  coverage: PlayerCoverage | null;
  /** Highest current rating — the one identity fact worth a nav slot. */
  best: FormatStat | null;
}) {
  const sync = useFetcher<{ ok: boolean; message: string }>();
  const missing = coverage?.historyComplete
    ? 0
    : coverage
      ? Math.max(0, coverage.availableGames - coverage.importedGames)
      : 0;
  const busy = sync.state !== "idle" || coverage?.activeImport != null;
  return (
    <TopNav
      current="home"
      right={
        <>
          {best ? (
            <span className="hidden text-xs text-ink-faint sm:inline">
              <b className="metric font-medium text-ink-muted">{best.rating}</b>{" "}
              {best.label.toLowerCase()}
            </span>
          ) : null}
          {missing > 0 || busy ? (
            <sync.Form method="post">
              <input type="hidden" name="username" value={username} />
              <button className="nav-sync" disabled={busy}>
                {busy ? "Syncing…" : `Sync ${missing} games`}
              </button>
            </sync.Form>
          ) : null}
          {sync.data ? <span className="sr-only" aria-live="polite">{sync.data.message}</span> : null}
        </>
      }
    />
  );
}

/**
 * Roughly where a handful of games turns into a habit worth naming. Not a
 * threshold in the stats — the confidence intervals do that work — but the
 * point below which the dashboard has more to say about getting data than
 * about the data it has.
 */
const USEFUL_GAMES = 20;

/**
 * A calendar needs at least one mark on it. The bar is this low on purpose: a
 * new account is exactly who needs the page to look like it is theirs and
 * filling up, and the grid narrows its own window so a young history reads as
 * a young calendar rather than as an empty one.
 */
const ACTIVE_DAYS_FOR_GRID = 1;

/**
 * The opening this player should open next, or null when the evidence is too
 * thin to name one. Lives outside the component so the page can tell whether
 * the review slot has anything in it before it decides what to put there.
 */
function priorityOpening(data: OpeningExplorerData | null) {
  if (!data?.selected) return null;
  const opening =
    data.families.find((item) => item.family === data.selected?.family) ??
    rankOpeningFamilies(data.families)[0];
  if (!opening || opening.games < 3) return null;
  return opening;
}

/** Plies shown before the decision point. Enough to recognise the opening. */
const LINE_SHOWN = 8;

/**
 * The line to fix — the product's centrepiece.
 *
 * Duolingo opens on the path; Tempo opens on the line, because that is what
 * the product actually sells: the sequence of moves you keep walking down and
 * the exact step where it goes wrong. The moves are drawn as tiles ending at
 * a marker for your decision, with the position on the board beside them — so
 * the finding is something you can see, not a paragraph you have to trust.
 *
 * It renders nothing below three games; GettingStarted takes the slot instead,
 * because a centrepiece that admits it has no evidence is worse than none.
 */
function LineToFix({ data }: { data: OpeningExplorerData }) {
  const selected = data.selected;
  const opening = priorityOpening(data);
  const failure = data.failures[0];
  if (!selected || !opening) return null;
  const costlyRate = opening.opportunities ? opening.failures / opening.opportunities : 0;
  const struggling = opening.failures >= 3 && costlyRate >= 0.15;
  const href = `/openings?username=${encodeURIComponent(data.username)}&family=${encodeURIComponent(opening.family)}&node=${encodeURIComponent(selected.nodeKey)}`;
  // Only shown when it adds something the family name does not already say.
  const variation = selected.variation ?? selected.name;
  const showVariation = variation && !variation.startsWith(opening.family);

  // The walk to the decision. Long lines keep their tail — the recent moves
  // are the recognisable ones — and the parity of the full line survives the
  // cut so white moves stay white.
  const sans = selected.lineSan.trim().split(/\s+/).filter(Boolean);
  const cut = Math.max(0, sans.length - LINE_SHOWN);
  const shown = sans.slice(cut);

  return (
    <section className="dash-action">
      <div className="line-lead">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="font-serif text-2xl text-ink">Your line to fix</h2>
            <InfoTip label="opening recommendation">
              Based on engine-checked moves in your games. Repeated problems across
              different games rank above one-off mistakes.
            </InfoTip>
          </div>

          <h3 className="mt-6 font-serif text-4xl leading-[1.02] tracking-tight text-ink sm:text-5xl">
            {opening.family}
          </h3>
          {showVariation ? <p className="mt-2 text-sm text-ink-faint">{variation}</p> : null}

          <div className="line-walk" aria-label={`Line: ${selected.lineSan}`}>
            {cut > 0 ? <span className="line-cut">…</span> : null}
            {shown.map((san, i) => (
              <span key={`${san}-${i}`} className="line-step">
                <Move san={san} white={(cut + i) % 2 === 0} />
              </span>
            ))}
            <span className="line-here">your move</span>
          </div>

          <p className="mt-6 max-w-xl text-lg leading-relaxed text-ink-muted">
            {opening.failures} of {opening.opportunities} engine-checked moves here cost you
            something across {opening.games} games
            {struggling ? " — and the same decision keeps coming back." : ` — you handled ${handledPercent(opening)}% of them well.`}
          </p>
          <p className="mt-2.5 text-sm text-ink-faint">
            {reliabilityLabel(opening.games)}
            {failure ? ` · clearest example: ${failure.moveSan} against ${failure.opponent ?? "an opponent"}` : ""}
          </p>

          <Link to={href} className="primary-button mt-7">Walk this line</Link>
        </div>

        {/* The position itself, so the tiles end somewhere real. */}
        <div className="line-board">
          <Board fen={selected.fen} size={248} />
        </div>
      </div>
    </section>
  );
}

/**
 * Straight from the board: the game they just finished, at the moment the
 * middlegame took shape. Most visits happen minutes after a game ends — this
 * is the door they came in through.
 */
function LastGame({ s }: { s: Summary }) {
  const b = s.board;
  if (!b) return null;
  return (
    <section className="rise">
      <h2 className="font-serif text-2xl text-ink">Your last game</h2>
      <p className="mt-1.5 text-sm text-ink-muted">
        {b.result === "win" ? "A win" : b.result === "draw" ? "A draw" : "A loss"} against{" "}
        {b.opponent}
        {b.opening ? ` in the ${family(b.opening)}` : ""}.
      </p>
      <div className="mt-5">
        <Board fen={b.fen} flip={b.color === "black"} size={224} />
      </div>
      <Link to={`/game/${b.id}`} className="quiet-button mt-5">
        Open the review
      </Link>
    </section>
  );
}

/**
 * Openings they have barely walked, offered as territory rather than as a
 * fault. This reads from the same explorer data as everything else: a family
 * with one or two games is a door they opened once — honest, and different in
 * kind from the line above, which is about a door they keep walking into.
 */
function NewLines({ data }: { data: OpeningExplorerData }) {
  // The server's families are raw platform names, so two Caro-Kann variations
  // arrive as two entries. Fold them through the same family mapper as the
  // rest of the page first — "barely walked" has to be true of the family,
  // not of one spelling of it.
  const current = data.selected ? family(data.selected.family) : null;
  const byFamily = new Map<string, number>();
  for (const f of data.families) {
    const key = family(f.family);
    byFamily.set(key, (byFamily.get(key) ?? 0) + f.games);
  }
  const barely = [...byFamily.entries()]
    .filter(([name, games]) => name !== current && games > 0 && games <= 2)
    .sort((a, b) => a[1] - b[1])
    .slice(0, 3)
    .map(([name, games]) => ({ family: name, games }));
  if (!barely.length) return null;
  return (
    <section className="rise">
      <h2 className="font-serif text-2xl text-ink">Lines you have barely walked</h2>
      <p className="mt-1.5 text-sm text-ink-muted">
        Openings that appear once or twice in your games — worth a deliberate try
        before they surprise you again.
      </p>
      <ul className="mt-6 space-y-4">
        {barely.map((f) => (
          <li key={f.family} className="flex items-baseline justify-between gap-4">
            <span className="min-w-0 truncate text-ink">{f.family}</span>
            <span className="shrink-0 text-xs text-ink-faint">
              {f.games} game{f.games === 1 ? "" : "s"}
            </span>
          </li>
        ))}
      </ul>
      <Link to="/openings" className="quiet-button mt-6">
        Explore your map
      </Link>
    </section>
  );
}

/**
 * What a brand-new account sees where the review would be.
 *
 * A fresh import has a handful of games, which is enough to draw a chart and
 * not nearly enough to mean anything — so this says how far off useful is, and
 * gives the one control that closes the gap. The number is the point: "3 of 20"
 * is a reason to press the button, "not enough data" is not.
 */
function GettingStarted({
  games,
  coverage,
  username,
}: {
  games: number;
  coverage: PlayerCoverage | null;
  username: string;
}) {
  const sync = useFetcher<{ ok: boolean; message: string }>();
  const waiting = coverage
    ? Math.max(0, coverage.availableGames - coverage.importedGames)
    : 0;
  const busy = sync.state !== "idle" || coverage?.activeImport != null;
  const progress = Math.min(1, games / USEFUL_GAMES);

  return (
    <section className="dash-action">
      <h2 className="font-serif text-4xl leading-[1.05] tracking-tight text-ink sm:text-5xl">
        {games === 0
          ? "Nothing to read yet"
          : `${games} game${games === 1 ? "" : "s"} in`}
      </h2>
      <p className="mt-5 max-w-2xl text-lg leading-relaxed text-ink-muted">
        Tempo finds the mistakes you repeat, so it needs to see you repeat them.
        Around {USEFUL_GAMES} games is where an opening stops being a coincidence
        and starts being a habit.
      </p>

      <div className="mt-8 max-w-md">
        <div className="h-1.5 overflow-hidden rounded-pill bg-surface-2">
          <div
            className="h-full rounded-pill transition-[width] duration-700 ease-out"
            style={{ width: `${Math.max(progress * 100, games ? 4 : 0)}%`, background: "var(--color-accent)" }}
          />
        </div>
        <p className="mt-2.5 text-sm text-ink-faint">
          {games} of {USEFUL_GAMES} games read
          {waiting ? ` · ${waiting} more waiting on ${coverage?.activeImport ? "the import" : "your archive"}` : ""}
        </p>
      </div>

      {waiting > 0 ? (
        <sync.Form method="post" className="mt-7">
          <input type="hidden" name="username" value={username} />
          <button className="primary-button" disabled={busy}>
            {busy ? "Reading your archive…" : `Import ${waiting} more games`}
          </button>
        </sync.Form>
      ) : (
        <p className="mt-7 text-sm text-ink-faint">
          {coverage
            ? "That is everything your account has played. Come back after a few more and the patterns will have something to stand on."
            : "Play a few more and Tempo will have something to work with."}
        </p>
      )}
    </section>
  );
}

function FormatInline({ f }: { f: FormatStat }) {
  return (
    <div>
      <div className="flex items-baseline gap-1.5">
        <span className="metric text-2xl text-ink">{f.rating}</span>
        {f.prog !== 0 && (
          <span
            className="metric text-xs"
            style={{ color: f.prog > 0 ? "var(--color-win)" : "var(--color-loss)" }}
          >
            {f.prog > 0 ? "▲" : "▼"}
            {Math.abs(f.prog)}
          </span>
        )}
      </div>
      {/* "785?" meant provisional to nobody but us. It says so now. */}
      <div className="mt-1 text-xs text-ink-muted">
        {f.label.toLowerCase()}
        {f.prov ? <span className="text-ink-faint"> · provisional</span> : null}
      </div>
    </div>
  );
}

/** A line needs a shape. Below this it is two points and a straight edge. */
const TREND_MIN = 5;

function RatingPanel({ s, live }: { s: Summary; live: boolean }) {
  // Guard the values, not just the count: an archive can carry games with no
  // rating on them, and a chart of NaN renders as an empty box with "NaN" over
  // it rather than as nothing at all.
  const trend = s.trend.ratings.filter((n) => Number.isFinite(n));
  const hasTrend = trend.length >= TREND_MIN;
  const change = hasTrend ? trend[trend.length - 1] - trend[0] : 0;

  return (
    <div className="min-w-0">
      <div className="mb-5 flex items-baseline justify-between gap-4">
        <h2 className="font-serif text-2xl text-ink">Rating</h2>
        {hasTrend ? (
          <div className="text-right">
            <span className="metric text-2xl text-ink">{trend[trend.length - 1]}</span>{" "}
            <span
              className="metric text-xs"
              style={{ color: change >= 0 ? "var(--color-win)" : "var(--color-loss)" }}
            >
              {signed(change)} · {s.trend.label}
            </span>
          </div>
        ) : null}
      </div>
      {hasTrend ? (
        <RatingLine data={trend} height={150} />
      ) : (
        // A two-point "trend" drawn as a chart is a straight line that implies
        // a story nobody has yet. The ratings themselves still say something.
        <p className="max-w-md text-sm leading-relaxed text-ink-muted">
          A rating line needs a few more games before its shape means anything.
          Here is where you stand today.
        </p>
      )}
      <div className="mt-6 flex flex-wrap gap-x-10 gap-y-4">
        {s.formats.map((f) => (
          <FormatInline key={f.key} f={f} />
        ))}
      </div>
      {/* The caveat belongs next to the numbers it applies to, not in the nav. */}
      {!live ? (
        <p className="mt-5 text-xs text-ink-faint">
          Your chess site did not respond, so these are reconstructed from the
          games Tempo has already imported.
        </p>
      ) : null}
    </div>
  );
}

function Openings({ s }: { s: Summary }) {
  return (
    <section className="rise">
      <div className="flex items-baseline justify-between gap-6">
        <div className="flex items-center gap-2">
          <h2 className="font-serif text-2xl text-ink">Results by opening</h2>
          <InfoTip label="results by opening">
            This chart shows game results only. It does not measure whether your opening moves were good. Use Opening Review for engine-checked decisions.
          </InfoTip>
        </div>
        <span className="shrink-0 text-sm text-ink-faint">last 100 games</span>
      </div>
      <div className="mt-8 grid gap-x-16 gap-y-12 lg:grid-cols-[minmax(0,1fr)_17rem]">
        <DivergingOpenings openings={s.openings} />
        {/* The side note only earns its column when it has something in it; an
            empty heading over an explanatory paragraph is just chrome. */}
        {s.toughOpenings.length ? (
          <div>
            <h3 className="text-sm font-semibold text-ink">Where you score lowest</h3>
            <p className="mt-2 text-sm leading-relaxed text-ink-muted">
              Low results are a place to look, not proof of a weakness.
            </p>
            <ol className="mt-6 space-y-5">
              {s.toughOpenings.slice(0, 3).map((o, i) => (
                <li key={o.name} className="flex gap-3">
                  <span className="font-serif text-lg italic text-ink-faint">{i + 1}</span>
                  <div className="min-w-0">
                    <div className="truncate text-sm text-ink" title={o.name}>
                      {o.name}
                    </div>
                    <div className="mt-1 text-xs text-ink-muted">
                      <b className="font-semibold" style={{ color: "var(--color-loss)" }}>
                        {pct(o.adjWinRate)}
                      </b>{" "}
                      adjusted over {o.games} games
                    </div>
                    <div className="mt-0.5 text-xs text-ink-faint">
                      raw {pct(o.winRate)}
                      {o.conf === "low" ? " · small sample" : ""}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function RecentGames({ games }: { games: GameLite[] }) {
  return (
    <div>
      <h2 className="mb-5 font-serif text-2xl text-ink">Recent games</h2>
      {/* Rows separate by their own hover surface and rhythm rather than by a
          rule between every pair — nine hairlines in a list of ten reads as
          ruling, not grouping. */}
      <div>
        {games.map((g) => (
          <Link
            key={g.id}
            to={`/game/${g.id}`}
            className="-mx-3 flex items-center gap-3.5 rounded-control px-3 py-3 text-sm transition-colors hover:bg-surface-2"
          >
            <ResultChip result={g.result} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-ink">
                {g.opponent}
                {g.opponentRating ? (
                  <span className="text-ink-faint"> ({g.opponentRating})</span>
                ) : null}
              </div>
              <div className="mt-0.5 truncate text-xs text-ink-faint">
                as {g.color}
                {g.opening ? ` · ${family(g.opening)}` : ""}
              </div>
            </div>
            {g.accuracy !== undefined ? (
              <div className="metric hidden w-12 text-right text-xs text-ink-muted sm:block">
                {g.accuracy.toFixed(0)}%
              </div>
            ) : (
              <div className="hidden w-12 sm:block" />
            )}
            <div className="metric w-14 text-right text-xs">
              {g.ratingDiff !== undefined ? (
                <span style={{ color: g.ratingDiff >= 0 ? "var(--color-win)" : "var(--color-loss)" }}>
                  {signed(g.ratingDiff)}
                </span>
              ) : null}
            </div>
            <div className="w-14 text-right text-xs text-ink-faint">{relTime(g.createdAt)}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}

function EngineRead({ s }: { s: Summary }) {
  const a = s.analyzed;
  // Nothing analysed means no numbers, and a heading over that absence is a
  // label on an empty shelf. Focus below already offers the way forward.
  if (a.count === 0) return null;
  return (
    <div>
      <h2 className="font-serif text-2xl text-ink">Engine read</h2>
      <p className="mt-1 text-sm text-ink-faint">
        across {a.count} analysed game{a.count === 1 ? "" : "s"}
      </p>
      <div className="mt-5 flex gap-10">
        {a.avgAccuracy !== undefined && (
          <div>
            <div className="metric text-3xl text-ink">
              <CountUp value={a.avgAccuracy} decimals={1} suffix="%" />
            </div>
            <div className="mt-1 text-xs text-ink-muted">accuracy</div>
          </div>
        )}
        <div>
          <div className="metric text-3xl" style={{ color: "var(--color-loss)" }}>
            <CountUp value={a.blundersPerGame} decimals={1} />
          </div>
          <div className="mt-1 text-xs text-ink-muted">blunders a game</div>
        </div>
      </div>
    </div>
  );
}

export function Dashboard({
  summary,
  opening,
  coverage,
  live = true,
  platform = "lichess",
}: {
  summary: Summary;
  opening: OpeningExplorerData | null;
  coverage: PlayerCoverage | null;
  /** False when the platform was unreachable and ratings came from imported games. */
  live?: boolean;
  /** Which site the linked account is on. Defaults kept so callers can opt in. */
  platform?: "lichess" | "chesscom";
}) {
  const firstVisit = useFirstVisit();
  const lastGame = summary.board ? <LastGame s={summary} /> : null;
  const newLines = opening ? <NewLines data={opening} /> : null;

  // The centrepiece, in order of what the data can support: the walkable map
  // when the graph shipped, the single line card when only the finding did,
  // nothing when neither — GettingStarted covers the thin-archive case.
  const tear = priorityOpening(opening) && opening ? opening.selected : null;
  const lead = opening?.graph ? (
    <section className="rise dash-lead">
      <OpeningMap
        graph={opening.graph}
        tearKey={tear?.nodeKey ?? null}
        tearHref={
          tear
            ? `/openings?username=${encodeURIComponent(opening.username)}&family=${encodeURIComponent(tear.family)}&node=${encodeURIComponent(tear.nodeKey)}`
            : null
        }
      />
    </section>
  ) : tear && opening ? (
    <LineToFix data={opening} />
  ) : null;

  return (
    <div className="relative z-10 min-h-dvh">
      <a className="skip-link" href="#player-overview-main">Skip to player overview</a>
      <TopBar username={summary.username} coverage={coverage} best={summary.bestFormat ?? null} />
      <main id="player-overview-main" className="dashboard-main mx-auto max-w-[1160px] px-6 pb-28 sm:px-10">
        {/* The page opens on the work, not on who you are — the nav already
            says that. One slot, two states: a thin archive gets the path to a
            thicker one, a real one gets the line to go and fix. */}
        {summary.record.all < USEFUL_GAMES ? (
          <GettingStarted
            games={summary.record.all}
            coverage={coverage}
            username={summary.username}
          />
        ) : (
          // A deep archive with no review ready yet gets neither panel. The
          // beginner prompt is for thin histories only — telling someone with
          // a thousand games that they need more is just wrong.
          lead
        )}

        {/* The door they came in through, and the door they have not opened. */}
        {lastGame || newLines ? (
          <div className="dash-pair">
            {lastGame}
            {newLines}
          </div>
        ) : null}

        {summary.days.length >= ACTIVE_DAYS_FOR_GRID ? (
          <section className="rise">
            <ActivityGrid
              days={summary.days}
              intro={firstVisit}
              record={{ ...summary.record, winRate: summary.winRate }}
            />
          </section>
        ) : null}

        <Openings s={summary} />

        <section className="rise grid gap-x-16 gap-y-12 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <RecentGames games={summary.recent} />
          <div className="flex flex-col gap-10">
            <RatingPanel s={summary} live={live} />
            <EngineRead s={summary} />
          </div>
        </section>
      </main>
    </div>
  );
}
