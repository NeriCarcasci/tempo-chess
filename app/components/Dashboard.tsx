import type {
  Summary,
  GameLite,
  FormatStat,
  OpeningStat,
  Result,
} from "../lib/lichess";
import { pct, playTime, monthYear, relTime, signed } from "../lib/format";
import { Ring, CountUp, Sparkline, RecordBar } from "./charts";

const RESULT_STYLE: Record<Result, { ink: string; label: string }> = {
  win: { ink: "var(--color-accent)", label: "W" },
  loss: { ink: "var(--color-blunder)", label: "L" },
  draw: { ink: "var(--color-info)", label: "D" },
};

function ResultChip({ result }: { result: Result }) {
  const r = RESULT_STYLE[result];
  return (
    <span
      className="metric grid h-6 w-6 place-items-center rounded-control text-xs font-semibold"
      style={{ color: r.ink, background: `color-mix(in oklch, ${r.ink} 16%, transparent)` }}
    >
      {r.label}
    </span>
  );
}

function Delta({ value }: { value: number }) {
  if (!value) return <span className="text-ink-faint">–</span>;
  const up = value > 0;
  return (
    <span className="metric text-xs" style={{ color: up ? "var(--color-accent)" : "var(--color-blunder)" }}>
      {up ? "▲" : "▼"} {signed(value)}
    </span>
  );
}

function Panel({
  title,
  note,
  children,
  className = "",
}: {
  title?: string;
  note?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel p-5 ${className}`}>
      {title && (
        <header className="mb-4 flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          {note && <span className="label">{note}</span>}
        </header>
      )}
      {children}
    </section>
  );
}

function shortOpening(name: string): string {
  return name.split(":")[0].trim();
}

// ---------------------------------------------------------------------------

function TopBar({ username }: { username: string }) {
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-bg/85 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-[1200px] items-center justify-between px-5 sm:px-8">
        <div className="flex items-center gap-2.5">
          <span className="grid h-6 w-6 place-items-center rounded-[7px] bg-accent">
            <span className="h-2.5 w-2.5 rounded-[2px] bg-accent-ink" />
          </span>
          <span className="text-[15px] font-semibold tracking-tight text-ink">
            Tempo<span className="text-ink-faint">Chess</span>
          </span>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 rounded-control border border-line px-2.5 py-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            <span className="text-xs text-ink-muted">
              Lichess <span className="text-ink">{username}</span>
            </span>
          </div>
          <button
            type="button"
            className="rounded-control border border-line px-3 py-1.5 text-xs font-medium text-ink-muted transition-colors hover:border-line-strong hover:text-ink active:translate-y-px"
          >
            Sync
          </button>
        </div>
      </div>
    </header>
  );
}

function ProfileHeader({ s }: { s: Summary }) {
  return (
    <div className="rise flex flex-wrap items-end justify-between gap-4 pt-8 pb-6">
      <div className="flex items-center gap-4">
        <div className="grid h-14 w-14 place-items-center rounded-full bg-surface-2 text-lg font-semibold text-ink-muted ring-1 ring-line">
          {s.username.slice(0, 2)}
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">{s.username}</h1>
          <p className="mt-1 text-sm text-ink-muted">
            {s.location ? `${s.location} · ` : ""}Member since {monthYear(s.memberSince)} ·{" "}
            {playTime(s.playTimeSec)} played
          </p>
        </div>
      </div>
      <div className="text-right">
        <div className="label mb-1">Lifetime record</div>
        <div className="metric text-lg text-ink">
          <span className="text-accent">{s.record.win}</span>
          <span className="text-ink-faint"> · </span>
          <span className="text-blunder">{s.record.loss}</span>
          <span className="text-ink-faint"> · </span>
          <span className="text-info">{s.record.draw}</span>
        </div>
      </div>
    </div>
  );
}

function StatTile({
  label,
  value,
  sub,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
}) {
  return (
    <div>
      <div className="label mb-2">{label}</div>
      <div className="metric text-2xl leading-none text-ink">{value}</div>
      {sub && <div className="mt-1.5 text-xs text-ink-muted">{sub}</div>}
    </div>
  );
}

function Vitals({ s }: { s: Summary }) {
  const winPctText = Math.round(s.winRate * 100);
  const best = s.bestFormat;
  const a = s.analyzed;
  return (
    <div className="rise panel grid gap-6 p-6 sm:grid-cols-[auto_1fr] sm:items-center" style={{ animationDelay: "60ms" }}>
      <div className="flex items-center gap-5 sm:pr-6">
        <Ring value={s.winRate * 100}>
          <div className="metric text-3xl font-semibold text-ink">
            <CountUp value={winPctText} suffix="%" />
          </div>
          <div className="label mt-1">Win rate</div>
        </Ring>
        <div className="min-w-[8rem]">
          <div className="mb-2 text-xs text-ink-muted">Across {s.record.all} games</div>
          <RecordBar win={s.record.win} draw={s.record.draw} loss={s.record.loss} />
          <div className="mt-2 flex justify-between text-xs text-ink-faint">
            <span className="text-accent">{s.record.win}W</span>
            <span className="text-info">{s.record.draw}D</span>
            <span className="text-blunder">{s.record.loss}L</span>
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-6 border-line sm:grid-cols-3 sm:border-l sm:pl-6">
        {best && (
          <StatTile
            label={`Strongest · ${best.label}`}
            value={<CountUp value={best.rating} />}
            sub={`${best.games} games`}
          />
        )}
        <StatTile label="Games played" value={<CountUp value={s.record.all} />} sub={`${s.record.rated} rated`} />
        <StatTile label="Time played" value={playTime(s.playTimeSec)} sub="on the clock" />
        {a.count > 0 ? (
          <>
            {a.avgAccuracy !== undefined && (
              <StatTile
                label="Accuracy"
                value={<CountUp value={a.avgAccuracy} decimals={1} suffix="%" />}
                sub={`${a.count} analyzed games`}
              />
            )}
            <StatTile
              label="Blunders / game"
              value={<CountUp value={a.blundersPerGame} decimals={1} />}
              sub={`${a.blunders} in ${a.count} games`}
            />
          </>
        ) : (
          <div className="col-span-2 sm:col-span-1">
            <div className="label mb-2">Blunders</div>
            <div className="text-sm text-ink-muted">
              No engine-analyzed games in this window.
            </div>
            <div className="mt-1 text-xs text-accent">Run analysis to unlock →</div>
          </div>
        )}
      </div>
    </div>
  );
}

function FormatCard({ f }: { f: FormatStat }) {
  return (
    <div>
      <div className="label mb-2">{f.label}</div>
      <div className="metric text-xl text-ink">
        {f.rating}
        {f.prov && <span className="text-ink-faint">?</span>}
      </div>
      <div className="mt-1 flex items-center gap-2 text-xs text-ink-muted">
        <span>{f.games} games</span>
        <Delta value={f.prog} />
      </div>
    </div>
  );
}

function Ratings({ s }: { s: Summary }) {
  const trend = s.trend.ratings;
  const change = trend.length >= 2 ? trend[trend.length - 1] - trend[0] : 0;
  return (
    <Panel title="Ratings" note={`trend · ${s.trend.label}`} className="rise mt-6" >
      <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
        {s.formats.map((f) => (
          <FormatCard key={f.key} f={f} />
        ))}
      </div>
      {trend.length >= 2 && (
        <div className="mt-5 flex items-end gap-4 border-t border-line pt-4">
          <div className="flex-1">
            <Sparkline data={trend} />
          </div>
          <div className="text-right">
            <div className="metric text-lg text-ink">{trend[trend.length - 1]}</div>
            <div className="text-xs" style={{ color: change >= 0 ? "var(--color-accent)" : "var(--color-blunder)" }}>
              {signed(change)} over {trend.length}
            </div>
          </div>
        </div>
      )}
    </Panel>
  );
}

function OpeningRow({ o, tough }: { o: OpeningStat; tough?: boolean }) {
  return (
    <div className="flex items-center gap-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-ink" title={o.name}>
          {o.name}
        </div>
        <div className="text-xs text-ink-faint">
          {o.eco ? `${o.eco} · ` : ""}
          {o.games} games
        </div>
      </div>
      <div className="hidden w-24 sm:block">
        <RecordBar win={o.win} draw={o.draw} loss={o.loss} />
      </div>
      <div
        className="metric w-11 text-right text-sm"
        style={{ color: tough ? "var(--color-blunder)" : "var(--color-ink)" }}
      >
        {pct(o.winRate)}
      </div>
    </div>
  );
}

function RecentGames({ games }: { games: GameLite[] }) {
  return (
    <Panel title="Recent games" note="last 12">
      <div className="divide-y divide-line">
        {games.map((g) => (
          <div key={g.id} className="flex items-center gap-3 py-2.5 text-sm">
            <ResultChip result={g.result} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-ink">
                {g.opponent}
                {g.opponentRating ? (
                  <span className="text-ink-faint"> ({g.opponentRating})</span>
                ) : null}
              </div>
              <div className="truncate text-xs text-ink-faint">
                {g.color === "white" ? "White" : "Black"}
                {g.opening ? ` · ${shortOpening(g.opening)}` : ""}
              </div>
            </div>
            {g.accuracy !== undefined ? (
              <div className="metric hidden w-14 text-right text-xs text-ink-muted sm:block">
                {g.accuracy.toFixed(0)}%
              </div>
            ) : (
              <div className="hidden w-14 sm:block" />
            )}
            <div className="metric w-16 text-right text-xs text-ink-muted">
              {g.ratingDiff !== undefined ? (
                <span style={{ color: g.ratingDiff >= 0 ? "var(--color-accent)" : "var(--color-blunder)" }}>
                  {signed(g.ratingDiff)}
                </span>
              ) : null}
            </div>
            <div className="w-14 text-right text-xs text-ink-faint">{relTime(g.createdAt)}</div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function ColorSplit({ s }: { s: Summary }) {
  const rows: [string, typeof s.byColor.white][] = [
    ["As White", s.byColor.white],
    ["As Black", s.byColor.black],
  ];
  return (
    <Panel title="By color">
      <div className="space-y-4">
        {rows.map(([label, c]) => (
          <div key={label}>
            <div className="mb-1.5 flex items-baseline justify-between">
              <span className="text-sm text-ink">{label}</span>
              <span className="metric text-sm text-ink-muted">{pct(c.winRate)}</span>
            </div>
            <RecordBar win={c.win} draw={c.draw} loss={c.loss} />
            <div className="mt-1 text-xs text-ink-faint">
              {c.win}W · {c.draw}D · {c.loss}L over {c.games}
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function ToughLines({ openings }: { openings: OpeningStat[] }) {
  if (openings.length === 0) return null;
  return (
    <Panel title="Where you struggle" note="weak lines">
      <p className="mb-3 text-xs text-ink-muted">
        Openings with your worst results this window. Prime candidates to drill.
      </p>
      <div className="divide-y divide-line">
        {openings.map((o) => (
          <OpeningRow key={o.name} o={o} tough />
        ))}
      </div>
    </Panel>
  );
}

function NextUp({ s }: { s: Summary }) {
  const worst = s.toughOpenings[0];
  const weakerColor =
    s.byColor.black.winRate <= s.byColor.white.winRate ? s.byColor.black : s.byColor.white;
  const weakerLabel = weakerColor === s.byColor.black ? "Black" : "White";
  return (
    <section className="panel p-5" style={{ background: "color-mix(in oklch, var(--color-accent) 8%, var(--color-surface))" }}>
      <div className="label mb-2" style={{ color: "var(--color-accent)" }}>
        Focus
      </div>
      <p className="text-sm leading-relaxed text-ink">
        You score {pct(weakerColor.winRate)} as {weakerLabel}
        {worst ? (
          <>
            , and just {pct(worst.winRate)} in the{" "}
            <span className="text-ink">{shortOpening(worst.name)}</span>.
          </>
        ) : (
          "."
        )}{" "}
        Turn those positions into puzzles and drill the line.
      </p>
      <button
        type="button"
        className="mt-4 w-full rounded-control bg-accent px-3 py-2 text-sm font-semibold text-accent-ink transition-transform active:translate-y-px"
      >
        Build puzzles from my mistakes
      </button>
    </section>
  );
}

export function Dashboard({ summary }: { summary: Summary }) {
  return (
    <div className="min-h-dvh">
      <TopBar username={summary.username} />
      <main className="mx-auto max-w-[1200px] px-5 pb-24 sm:px-8">
        <ProfileHeader s={summary} />
        <Vitals s={summary} />
        <Ratings s={summary} />
        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <Panel title="Most played openings" note="last 100">
            <div className="divide-y divide-line">
              {summary.openings.map((o) => (
                <OpeningRow key={o.name} o={o} />
              ))}
            </div>
          </Panel>
          <ToughLines openings={summary.toughOpenings} />
        </div>
        <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_320px]">
          <RecentGames games={summary.recent} />
          <div className="space-y-6">
            <NextUp s={summary} />
            <ColorSplit s={summary} />
          </div>
        </div>
      </main>
    </div>
  );
}
