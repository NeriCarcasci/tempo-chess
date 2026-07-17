import { Link, useFetcher } from "react-router";
import type { Summary, GameLite, FormatStat, Result } from "../lib/lichess";
import {
  handledPercent,
  rankOpeningFamilies,
  reliabilityLabel,
  type OpeningExplorerData,
  type PlayerCoverage,
} from "../lib/openings";
import { pct, playTime, monthYear, relTime, signed } from "../lib/format";
import { CountUp, RatingLine, ProportionBar, DivergingOpenings } from "./charts";
import { Chessboard } from "./Chessboard";
import { InfoTip } from "./InfoTip";

const RESULT: Record<Result, { color: string; label: string }> = {
  win: { color: "var(--color-win)", label: "W" },
  loss: { color: "var(--color-loss)", label: "L" },
  draw: { color: "var(--color-draw)", label: "D" },
};

const family = (name: string) => name.split(":")[0].trim();

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

function TopBar({ username, coverage }: { username: string; coverage: PlayerCoverage | null }) {
  const sync = useFetcher<{ ok: boolean; message: string }>();
  const missing = coverage?.historyComplete
    ? 0
    : coverage
      ? Math.max(0, coverage.availableGames - coverage.importedGames)
      : 0;
  const busy = sync.state !== "idle" || coverage?.activeImport != null;
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-bg/80 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-[1160px] items-center justify-between px-6 sm:px-10">
        <div className="flex items-center gap-2.5">
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="10" cy="10" r="8.5" fill="none" stroke="var(--color-accent)" strokeWidth="1.5" />
            <line x1="10" y1="10" x2="10" y2="4.5" stroke="var(--color-accent)" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="10" y1="10" x2="13.5" y2="11.5" stroke="var(--color-accent)" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <span className="font-serif text-lg font-extrabold uppercase tracking-[-0.05em] text-ink">
            Tempo <span className="text-accent">Chess</span>
          </span>
        </div>
        <div className="flex items-center gap-3">
          <Link
            to="/openings"
            className="rounded-control border border-accent/40 bg-accent/8 px-3 py-1.5 text-xs font-bold uppercase tracking-[0.08em] text-accent transition-colors hover:bg-accent hover:text-accent-ink"
          >
            Opening review
          </Link>
          <div className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            <span className="cap">
              Lichess · <span className="text-ink-muted">{username}</span>
            </span>
          </div>
          <sync.Form method="post">
            <input type="hidden" name="username" value={username} />
            <button
              className="rounded-control border border-line px-3 py-1.5 text-xs font-medium text-ink-muted transition-colors hover:border-line-strong hover:text-ink active:translate-y-px disabled:opacity-50"
              disabled={busy || missing === 0}
              title={missing ? `${missing} Lichess games have not been imported` : "All Lichess games imported"}
            >
              {busy ? "Syncing…" : missing ? `Sync ${missing} games` : "Up to date"}
            </button>
          </sync.Form>
          {sync.data ? <span className="sr-only" aria-live="polite">{sync.data.message}</span> : null}
        </div>
      </div>
    </header>
  );
}

function Masthead({ s }: { s: Summary }) {
  const best = s.bestFormat;
  const verdict =
    `${Math.round(s.winRate * 100)}% across ${s.record.all} games.` +
    (best ? ` Your highest current rating is ${best.label} at ${best.rating}.` : "");

  return (
    <header className="rise grid gap-10 border-b border-line py-12 lg:grid-cols-[1fr_16rem]">
      <div className="max-w-2xl">
        <div className="cap mb-4">Player report</div>
        <h1 className="font-serif text-5xl leading-[0.95] tracking-tight text-ink sm:text-6xl">
          {s.username}
        </h1>
        <p className="mt-5 max-w-xl text-xl font-semibold leading-snug text-ink-muted">
          {verdict}
        </p>
        <div className="cap mt-5">
          {s.location ? `${s.location} · ` : ""}member since {monthYear(s.memberSince)} ·{" "}
          {playTime(s.playTimeSec)} at the board
        </div>
      </div>

      <aside className="flex flex-col justify-end gap-5 lg:border-l lg:border-line lg:pl-8">
        <div>
          <div className="cap mb-1">Win rate</div>
          <div className="metric text-4xl text-ink">
            <CountUp value={Math.round(s.winRate * 100)} suffix="%" />
          </div>
          <div className="mt-1 text-xs text-ink-faint">
            95% CI {Math.round(s.winRateCI.lo * 100)}-{Math.round(s.winRateCI.hi * 100)}%
          </div>
        </div>
        <div>
          <div className="cap mb-2">Record · {s.record.all} games</div>
          <ProportionBar win={s.record.win} draw={s.record.draw} loss={s.record.loss} height={10} />
          <div className="metric mt-2 flex justify-between text-xs">
            <span style={{ color: "var(--color-win)" }}>{s.record.win} W</span>
            <span style={{ color: "var(--color-draw)" }}>{s.record.draw} D</span>
            <span style={{ color: "var(--color-loss)" }}>{s.record.loss} L</span>
          </div>
        </div>
      </aside>
    </header>
  );
}

function OpeningPriority({ data }: { data: OpeningExplorerData }) {
  const selected = data.selected;
  const opening = data.families.find((item) => item.family === selected?.family) ?? rankOpeningFamilies(data.families)[0];
  const failure = data.failures[0];
  if (!selected || !opening) return null;
  const costlyRate = opening.opportunities ? opening.failures / opening.opportunities : 0;
  const reviewLabel = opening.games < 3
    ? "Not enough games"
    : opening.failures >= 3 && costlyRate >= 0.15
      ? "Needs work"
      : "Holding up";
  const href = `/openings?username=${encodeURIComponent(data.username)}&family=${encodeURIComponent(opening.family)}&node=${encodeURIComponent(selected.nodeKey)}`;
  return (
    <section className="rise border-b border-line py-12">
      <div className="mb-5 flex items-center gap-2">
        <h2 className="font-serif text-2xl text-ink">Your next opening review</h2>
        <InfoTip label="opening recommendation">
          This is based on engine-checked moves in your games. Repeated problems across different games rank above one-off mistakes.
        </InfoTip>
      </div>
      <div className="grid border border-line bg-surface lg:grid-cols-[1fr_auto]">
        <div className="p-6 sm:p-8">
          <div className="flex flex-wrap items-center gap-2">
            <span className="review-label">{reviewLabel}</span>
            <span className="plain-context">{reliabilityLabel(opening.games)}</span>
          </div>
          <h3 className="mt-5 text-3xl font-extrabold tracking-[-0.05em] sm:text-4xl">{opening.family}</h3>
          <p className="mt-2 text-sm text-ink-muted">{selected.variation ?? selected.name}</p>
          <p className="mt-5 max-w-2xl leading-relaxed text-ink-muted">
            {opening.games < 3
              ? `You have only ${opening.games} game${opening.games === 1 ? "" : "s"} here. Review the position, but do not call it a pattern yet.`
              : `${opening.failures} of ${opening.opportunities} checked opening moves were costly across ${opening.games} games. You handled ${handledPercent(opening)}% well.`}
          </p>
          {failure ? <p className="mt-3 text-sm text-ink-faint">Clearest example: {failure.moveSan} against {failure.opponent ?? "an opponent"}.</p> : null}
        </div>
        <div className="flex min-w-56 items-center border-t border-line p-6 lg:border-l lg:border-t-0">
          <Link to={href} className="primary-button w-full">Review the position</Link>
        </div>
      </div>
    </section>
  );
}

function FormatInline({ f }: { f: FormatStat }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="cap">{f.label}</span>
      <span className="metric text-sm text-ink">
        {f.rating}
        {f.prov ? <span className="text-ink-faint">?</span> : null}
      </span>
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
  );
}

function BoardAndTrend({ s }: { s: Summary }) {
  const b = s.board;
  const trend = s.trend.ratings;
  const change = trend.length >= 2 ? trend[trend.length - 1] - trend[0] : 0;

  return (
    <section className="rise grid gap-10 border-b border-line py-12 lg:grid-cols-[18rem_1fr]">
      <div>
        <div className="cap mb-3">From your last game</div>
        {b ? (
          <>
            <Chessboard fen={b.fen} flip={b.color === "black"} size={288} />
            <p className="mt-3 max-w-[288px] text-sm leading-relaxed text-ink-muted">
              vs {b.opponent} · move {b.moveNumber} · a {b.result}.{" "}
              <span className="text-ink-faint">
                Analysis will pin the move your plan broke down.
              </span>
            </p>
          </>
        ) : (
          <div className="grid h-72 w-72 place-items-center rounded-panel border border-line text-sm text-ink-faint">
            No recent game to show
          </div>
        )}
      </div>

      <div className="flex min-w-0 flex-col">
        <div className="mb-4 flex items-baseline justify-between gap-4">
          <h2 className="font-serif text-2xl text-ink">Rating</h2>
          <div className="text-right">
            <span className="metric text-2xl text-ink">{trend[trend.length - 1]}</span>{" "}
            <span
              className="metric text-xs"
              style={{ color: change >= 0 ? "var(--color-win)" : "var(--color-loss)" }}
            >
              {signed(change)} · {s.trend.label}
            </span>
          </div>
        </div>
        <RatingLine data={trend} height={168} />
        <div className="mt-5 flex flex-wrap gap-x-8 gap-y-3 border-t border-line pt-4">
          {s.formats.map((f) => (
            <FormatInline key={f.key} f={f} />
          ))}
        </div>
      </div>
    </section>
  );
}

function Openings({ s }: { s: Summary }) {
  return (
    <section className="rise border-b border-line py-12">
      <div className="mb-8 flex items-baseline justify-between">
        <div className="flex items-center gap-2">
          <h2 className="font-serif text-2xl text-ink">Results by opening</h2>
          <InfoTip label="results by opening">
            This chart shows game results only. It does not measure whether your opening moves were good. Use Opening Review for engine-checked decisions.
          </InfoTip>
        </div>
        <span className="cap">last 100 games</span>
      </div>
      <div className="grid gap-12 lg:grid-cols-[1fr_18rem]">
        <DivergingOpenings openings={s.openings} />
        <div className="lg:border-l lg:border-line lg:pl-10">
          <div className="cap mb-3">Lowest results</div>
          <p className="mb-5 text-sm leading-relaxed text-ink-muted">
            These openings had the lowest results in this window. Results alone do not prove an opening weakness.
          </p>
          <ol className="space-y-4">
            {s.toughOpenings.slice(0, 3).map((o, i) => (
              <li key={o.name} className="flex gap-3">
                <span className="font-serif text-lg italic text-ink-faint">{i + 1}</span>
                <div className="min-w-0">
                  <div className="truncate text-sm text-ink" title={o.name}>
                    {o.name}
                  </div>
                  <div className="cap mt-1">
                    <span style={{ color: "var(--color-loss)" }}>{pct(o.adjWinRate)}</span>{" "}
                    adjusted · {o.games} games
                  </div>
                  <div className="mt-1 text-xs text-ink-faint">
                    raw {pct(o.winRate)} · 95% CI {Math.round(o.ciLo * 100)}-
                    {Math.round(o.ciHi * 100)}%
                    {o.conf === "low" ? " · small sample" : ""}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}

function RecentGames({ games }: { games: GameLite[] }) {
  return (
    <div>
      <h2 className="mb-5 font-serif text-2xl text-ink">Recent games</h2>
      <div className="divide-y divide-line">
        {games.map((g) => (
          <Link
            key={g.id}
            to={`/game/${g.id}`}
            className="-mx-2 flex items-center gap-3 rounded-[6px] px-2 py-2.5 text-sm transition-colors hover:bg-surface"
          >
            <ResultChip result={g.result} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-ink">
                {g.opponent}
                {g.opponentRating ? (
                  <span className="text-ink-faint"> ({g.opponentRating})</span>
                ) : null}
              </div>
              <div className="cap mt-0.5 truncate">
                {g.color} {g.opening ? `· ${family(g.opening)}` : ""}
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
            <div className="cap w-14 text-right normal-case tracking-normal">{relTime(g.createdAt)}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}

function EngineRead({ s }: { s: Summary }) {
  const a = s.analyzed;
  return (
    <div>
      <div className="cap mb-4">Engine read · {a.count} analyzed games</div>
      {a.count > 0 ? (
        <div className="flex gap-8">
          {a.avgAccuracy !== undefined && (
            <div>
              <div className="metric text-3xl text-ink">
                <CountUp value={a.avgAccuracy} decimals={1} suffix="%" />
              </div>
              <div className="cap mt-1">Accuracy</div>
            </div>
          )}
          <div>
            <div className="metric text-3xl" style={{ color: "var(--color-loss)" }}>
              <CountUp value={a.blundersPerGame} decimals={1} />
            </div>
            <div className="cap mt-1">Blunders / game</div>
          </div>
        </div>
      ) : (
        <p className="text-sm text-ink-muted">
          No engine-analyzed games yet. Run analysis to see accuracy and blunder rate.
        </p>
      )}
    </div>
  );
}

function Focus({ s, opening }: { s: Summary; opening: OpeningExplorerData | null }) {
  const weaker = s.byColor.black.winRate <= s.byColor.white.winRate ? s.byColor.black : s.byColor.white;
  const weakerLabel = weaker === s.byColor.black ? "Black" : "White";
  const family = opening ? rankOpeningFamilies(opening.families)[0] : null;
  return (
    <div
      className="rounded-panel p-6"
      style={{ background: "color-mix(in oklch, var(--color-accent) 9%, var(--color-surface))" }}
    >
      <div className="cap mb-3" style={{ color: "var(--color-accent)" }}>
        Next review
      </div>
      <p className="font-serif text-lg leading-snug text-ink">
        {family
          ? `${family.family} is the clearest opening pattern in the games Tempo has checked.`
          : `You score ${pct(weaker.winRate)} as ${weakerLabel}. Import analyzed games to learn whether the cause is in the opening.`}
      </p>
      <Link to="/openings" className="primary-button mt-5 w-full">Open review</Link>
    </div>
  );
}

export function Dashboard({
  summary,
  opening,
  coverage,
}: {
  summary: Summary;
  opening: OpeningExplorerData | null;
  coverage: PlayerCoverage | null;
}) {
  return (
    <div className="relative z-10 min-h-dvh">
      <a className="skip-link" href="#player-overview-main">Skip to player overview</a>
      <TopBar username={summary.username} coverage={coverage} />
      <main id="player-overview-main" className="mx-auto max-w-[1160px] px-6 pb-28 sm:px-10">
        <Masthead s={summary} />
        {opening ? <OpeningPriority data={opening} /> : null}
        <BoardAndTrend s={summary} />
        <Openings s={summary} />
        <section className="rise grid gap-12 py-12 lg:grid-cols-[1fr_18rem]">
          <RecentGames games={summary.recent} />
          <div className="flex flex-col gap-8 lg:border-l lg:border-line lg:pl-10">
            <EngineRead s={summary} />
            <Focus s={summary} opening={opening} />
          </div>
        </section>
      </main>
    </div>
  );
}
