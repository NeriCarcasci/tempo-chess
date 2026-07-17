import { Form, Link, useFetcher, useSearchParams } from "react-router";
import type { Route } from "./+types/openings";
import { Chessboard } from "../components/Chessboard";

type FindingStatus = "emerging" | "stable" | "unstable" | "blind_spot" | "decaying";
interface Metrics {
  mastery: number;
  evidence: number;
  interval: { low: number; high: number };
  effectiveSample: number;
  consistency: number;
  averageLossCp: number | null;
  status: FindingStatus;
}
interface Family {
  family: string; games: number; opportunities: number; mastery: number;
  evidence: number; status: FindingStatus; weakestNodeKey: string | null; weakestLine: string;
}
interface Finding {
  nodeKey: string; name: string; family: string; variation: string | null; fen: string;
  lineSan: string; lineUci: string; opportunities: number; games: number; acceptable: number;
  failures: number; metrics: Metrics; transposition: boolean;
}
interface Child {
  moveUci: string; moveSan: string; nextPositionKey: string; games: number; playerMove: boolean;
  mastery: number | null; evidence: number | null; status: FindingStatus | "opponent_reply";
  name: string; transposition: boolean;
}
interface Failure {
  gameId: string; platformGameId: string; ply: number; opponent: string | null; playedAt: string | null;
  result: string; moveUci: string; moveSan: string; bestMoveUci: string | null;
  evaluationLossCp: number | null; reason: string | null; url: string | null; fen: string;
}
interface ExplorerData {
  username: string;
  sample: { games: number; observations: number; scoredDecisions: number };
  families: Family[];
  selected: Finding | null;
  children: Child[];
  failures: Failure[];
  findings: Finding[];
}

const API = import.meta.env.DEV ? "/api" : (import.meta.env.VITE_ENGINE_URL ?? "/api");
const STATUS: Record<FindingStatus, { label: string; copy: string }> = {
  blind_spot: { label: "Blind spot", copy: "Repeated failure with enough evidence to act." },
  decaying: { label: "Decaying", copy: "Recent handling is weaker than your established history." },
  unstable: { label: "Unstable", copy: "Your choices vary or frequently surrender value." },
  emerging: { label: "Emerging", copy: "Interesting signal, but the sample is still small." },
  stable: { label: "Stable", copy: "Repeatedly handled within the acceptable move set." },
};

export function meta() {
  return [
    { title: "Opening Line Explorer · Tempo Chess" },
    { name: "description", content: "Find the exact opening branches where your confidence ends." },
  ];
}

export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  const url = new URL(request.url);
  const query = new URLSearchParams(url.search);
  if (!query.has("username")) query.set("username", "ncarcasc");
  const response = await fetch(`${API}/opening-explorer?${query}`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `Explorer API returned ${response.status}`);
  return data as ExplorerData;
}

export async function clientAction({ request }: Route.ClientActionArgs) {
  const form = await request.formData();
  const response = await fetch(`${API}/opening-explorer/drills`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: form.get("username"),
      positionKey: form.get("positionKey"),
    }),
  });
  const data = await response.json();
  if (!response.ok) return { ok: false, message: data.error ?? "Could not create drill" };
  return { ok: true, message: "Branch drill added to your queue" };
}

function queryHref(params: URLSearchParams, changes: Record<string, string | null>) {
  const next = new URLSearchParams(params);
  for (const [key, value] of Object.entries(changes)) {
    if (value) next.set(key, value);
    else next.delete(key);
  }
  return `/openings?${next}`;
}

function SignalRing({ value, label, kind }: { value: number; label: string; kind: "mastery" | "evidence" }) {
  const color = kind === "mastery" ? "var(--color-accent)" : "var(--color-signal)";
  return <div className="signal-ring" style={{ "--signal": value, "--signal-color": color } as React.CSSProperties}>
    <div><strong>{value}</strong><span>/100</span></div>
    <p>{label}</p>
  </div>;
}

function StatusBadge({ status }: { status: FindingStatus }) {
  return <span className={`opening-status opening-status-${status}`}>
    <i aria-hidden="true" />{STATUS[status].label}
  </span>;
}

function Filters({ username, params }: { username: string; params: URLSearchParams }) {
  const today = new Date();
  const since = (days: number) => {
    const date = new Date(today);
    date.setDate(date.getDate() - days);
    return date.toISOString().slice(0, 10);
  };
  const filters = [
    { name: "platform", label: "Provider", options: [["all", "all"], ["lichess", "lichess"], ["chesscom", "chess.com"]] },
    { name: "speed", label: "Speed", options: [["all", "all"], ["bullet", "bullet"], ["blitz", "blitz"], ["rapid", "rapid"], ["classical", "classical"]] },
    { name: "color", label: "Color", options: [["all", "all"], ["white", "white"], ["black", "black"]] },
    { name: "since", label: "History", options: [["", "all time"], [since(90), "last 90 days"], [since(180), "last 6 months"], [since(365), "last year"]] },
  ];
  return <Form method="get" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
    <input type="hidden" name="username" value={username} />
    {filters.map(({ name, label, options }) => <label className="cap" key={name}>
      {label}
      <select name={name} defaultValue={params.get(name) ?? options[0]![0]} className="mt-2 block h-10 w-full rounded-control border border-line bg-bg px-3 font-sans text-sm normal-case tracking-normal text-ink">
        {options.map(([value, copy]) => <option key={value} value={value}>{copy}</option>)}
      </select>
    </label>)}
    <button className="mt-auto h-10 rounded-control border border-line bg-surface-2 text-xs font-black uppercase tracking-[0.08em] hover:border-accent hover:text-accent">Apply cohort</button>
  </Form>;
}

function FamilyRail({ families, selected, params }: { families: Family[]; selected: Finding | null; params: URLSearchParams }) {
  return <aside className="min-w-0">
    <div className="mb-4 flex items-center justify-between"><h2 className="cap text-ink">Repertoire</h2><span className="metric text-xs text-ink-faint">{families.length} families</span></div>
    <div className="opening-family-list">
      {families.map((family, index) => {
        const active = selected?.family === family.family;
        return <Link
          key={family.family}
          to={queryHref(params, { family: family.family, node: family.weakestNodeKey })}
          className={`opening-family ${active ? "is-active" : ""}`}
        >
          <span className="metric text-xs text-ink-faint">{String(index + 1).padStart(2, "0")}</span>
          <span className="min-w-0 flex-1"><strong>{family.family}</strong><small>{family.games} games · {family.opportunities} decisions</small></span>
          <span className="metric text-sm" aria-label={`Mastery ${family.mastery}`}>{family.mastery}</span>
        </Link>;
      })}
    </div>
  </aside>;
}

function BranchMap({ children, params }: { children: Child[]; params: URLSearchParams }) {
  if (!children.length) return <div className="rounded-panel border border-dashed border-line p-6 text-sm text-ink-muted">No deeper observed branch in this cohort.</div>;
  return <div className="space-y-2">
    {children.map((child) => <Link
      key={`${child.moveUci}-${child.nextPositionKey}`}
      to={queryHref(params, { node: child.nextPositionKey })}
      className="branch-edge group"
    >
      <span className={`move-chip ${child.playerMove ? "is-player" : ""}`}>{child.moveSan}</span>
      <span className="min-w-0 flex-1"><strong>{child.name}</strong><small>{child.games} game{child.games === 1 ? "" : "s"}{child.transposition ? " · transposition" : ""}</small></span>
      {child.mastery == null
        ? <span className="cap">Opponent reply</span>
        : <span className="metric text-sm text-ink-muted">{child.mastery} <small className="text-ink-faint">M</small> / {child.evidence} <small className="text-ink-faint">E</small></span>}
      <span aria-hidden="true" className="text-ink-faint transition-transform group-hover:translate-x-1">→</span>
    </Link>)}
  </div>;
}

function Evidence({ failures }: { failures: Failure[] }) {
  return <section>
    <div className="mb-4 flex items-baseline justify-between"><h2 className="cap text-ink">Responsible games</h2><span className="metric text-xs text-ink-faint">{failures.length} shown</span></div>
    {failures.length ? <div className="divide-y divide-line border-y border-line">
      {failures.map((failure) => <Link key={`${failure.gameId}-${failure.ply}`} to={`/game/${failure.platformGameId}`} className="group grid grid-cols-[1fr_auto] gap-3 py-4">
        <div><div className="text-sm font-bold">vs {failure.opponent ?? "Unknown"} · {failure.moveSan}</div><div className="mt-1 text-xs text-ink-faint">{failure.playedAt ? new Date(failure.playedAt).toLocaleDateString() : "Unknown date"} · move {Math.ceil(failure.ply / 2)} · {failure.result}</div></div>
        <div className="text-right"><div className="metric text-sm text-loss">−{failure.evaluationLossCp ?? "?"}cp</div><div className="mt-1 text-xs text-ink-faint group-hover:text-accent">Open position →</div></div>
      </Link>)}
    </div> : <p className="rounded-panel border border-line p-5 text-sm leading-relaxed text-ink-muted">No engine-backed failures for this position in the active cohort. That is evidence of stability—not an empty chart.</p>}
  </section>;
}

export default function OpeningExplorer({ loaderData }: Route.ComponentProps) {
  const data = loaderData as ExplorerData;
  const [params] = useSearchParams();
  const drill = useFetcher<typeof clientAction>();
  const selected = data.selected;

  return <div className="relative z-10 min-h-dvh">
    <header className="sticky top-0 z-30 border-b border-line bg-bg/85 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-[1480px] items-center justify-between px-5 sm:px-8">
        <Link to="/" className="text-lg font-black uppercase tracking-[-0.05em]">Tempo <span className="text-accent">Chess</span></Link>
        <div className="flex items-center gap-4"><span className="cap hidden sm:block">{data.username} · {data.sample.games} games</span><Link to="/" className="rounded-control border border-line px-3 py-2 text-xs font-bold uppercase tracking-[0.08em] hover:border-accent">Player report</Link></div>
      </div>
    </header>

    <main className="mx-auto max-w-[1480px] px-5 pb-24 pt-10 sm:px-8">
      <section className="grid gap-8 border-b border-line pb-9 lg:grid-cols-[1fr_auto] lg:items-end">
        <div><div className="cap text-accent">Opening line explorer / live repertoire</div><h1 className="mt-4 max-w-4xl text-4xl font-black uppercase leading-[0.92] tracking-[-0.065em] sm:text-6xl">Find where confidence <span className="text-accent">ends.</span></h1><p className="mt-5 max-w-2xl text-base font-medium leading-relaxed text-ink-muted">Mastery measures how reliably you handle a position. Evidence measures how much we should trust that conclusion. They are never the same score.</p></div>
        <div className="grid grid-cols-3 gap-5 border-l border-line pl-6">
          <div><strong className="metric text-2xl">{data.sample.games}</strong><span className="cap mt-1 block">Games</span></div>
          <div><strong className="metric text-2xl">{data.sample.scoredDecisions}</strong><span className="cap mt-1 block">Decisions</span></div>
          <div><strong className="metric text-2xl">{data.findings.filter((item) => item.metrics.status === "blind_spot").length}</strong><span className="cap mt-1 block">Blind spots</span></div>
        </div>
      </section>

      <section className="border-b border-line py-6"><Filters username={data.username} params={params} /></section>

      {selected ? <section className="opening-explorer-grid py-8">
        <FamilyRail families={data.families} selected={selected} params={params} />

        <div className="min-w-0">
          <div className="mb-5 flex flex-wrap items-center gap-2 text-xs text-ink-faint">
            <Link to={queryHref(params, { family: null, node: null })} className="hover:text-accent">All openings</Link><span>/</span><span>{selected.family}</span>{selected.variation ? <><span>/</span><span className="text-ink">{selected.variation}</span></> : null}
            {selected.transposition ? <span className="ml-auto rounded-full border border-signal/40 px-2 py-1 text-signal">↗ transposition-aware</span> : null}
          </div>
          <div className="panel overflow-hidden">
            <div className="grid lg:grid-cols-[minmax(17rem,0.72fr)_1fr]">
              <div className="border-b border-line p-5 lg:border-b-0 lg:border-r"><Chessboard fen={selected.fen} flip={params.get("color") === "black"} /></div>
              <div className="p-6 sm:p-8">
                <StatusBadge status={selected.metrics.status} />
                <h2 className="mt-5 text-3xl font-black leading-tight tracking-[-0.05em]">{selected.name}</h2>
                <p className="mt-2 text-sm leading-relaxed text-ink-muted">{STATUS[selected.metrics.status].copy}</p>
                <div className="mt-7 flex gap-6"><SignalRing value={selected.metrics.mastery} label="Mastery" kind="mastery" /><SignalRing value={selected.metrics.evidence} label="Evidence" kind="evidence" /></div>
                <div className="mt-7 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {[[selected.opportunities, "Opportunities"], [selected.failures, "Failures"], [`${selected.metrics.interval.low}–${selected.metrics.interval.high}`, "Mastery range"], [selected.metrics.averageLossCp == null ? "—" : `${selected.metrics.averageLossCp}cp`, "Average cost"]].map(([value, label]) => <div key={label} className="border-t border-line pt-3"><strong className="metric text-lg">{value}</strong><span className="cap mt-1 block">{label}</span></div>)}
                </div>
                <drill.Form method="post" className="mt-7">
                  <input type="hidden" name="username" value={data.username} /><input type="hidden" name="positionKey" value={selected.nodeKey} />
                  <button className="h-11 w-full rounded-control bg-accent text-xs font-black uppercase tracking-[0.1em] text-accent-ink disabled:opacity-50" disabled={drill.state !== "idle"}>{drill.state === "idle" ? "Train this branch" : "Building drill…"}</button>
                  {drill.data ? <p className={`mt-2 text-xs ${drill.data.ok ? "text-win" : "text-loss"}`} role="status">{drill.data.message}</p> : null}
                </drill.Form>
              </div>
            </div>
          </div>
          <div className="mt-8"><div className="mb-4 flex items-center justify-between"><h2 className="cap text-ink">Observed continuations</h2><span className="cap">M = mastery · E = evidence</span></div><BranchMap children={data.children} params={params} /></div>
        </div>

        <Evidence failures={data.failures} />
      </section> : <div className="panel mt-8 p-10 text-center"><h2 className="text-xl font-black">No opening evidence yet</h2><p className="mt-2 text-sm text-ink-muted">Sync analyzed games first, then Tempo can build your repertoire map.</p></div>}
    </main>
  </div>;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const message = error instanceof Error ? error.message : "Could not load opening explorer";
  return <main className="grid min-h-dvh place-items-center p-6"><div className="panel max-w-lg p-8 text-center"><div className="cap text-loss">Explorer unavailable</div><h1 className="mt-3 text-2xl font-black">No repertoire map yet</h1><p className="mt-3 text-sm leading-relaxed text-ink-muted">{message}</p><Link to="/dev/operations" className="mt-6 inline-block rounded-control bg-accent px-5 py-3 text-xs font-black uppercase tracking-[0.08em] text-accent-ink">Import games</Link></div></main>;
}
