import { type FormEvent, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { apiFetch } from "../lib/api";
import { requireSession } from "../lib/session";

type Status = "queued" | "ingesting" | "analyzing" | "completed" | "failed" | "cancelled";
interface AnalysisImport {
  id: string; username: string; platform: string; status: Status; requestedGames: number;
  discoveredGames: number; queuedTasks: number; runningTasks: number; completedTasks: number;
  failedTasks: number; totalPositions: number; analyzedPositions: number; cacheHits: number;
  deepPositions: number; estimatedCostUsd: number; actualCostUsd: number;
  error: string | null;
}

const API = import.meta.env.DEV ? "/api" : (import.meta.env.VITE_ENGINE_URL ?? import.meta.env.VITE_API_URL ?? "/api");
const active = new Set<Status>(["queued", "ingesting", "analyzing"]);
const money = (value: number) => `$${value.toFixed(4)}`;
const progress = (item: AnalysisImport) => {
  const work = item.totalPositions + item.deepPositions;
  return work ? Math.min(100, Math.round(item.analyzedPositions / work * 100)) : item.status === "completed" ? 100 : 0;
};

export function meta() {
  return [{ title: "Analysis Operations · Forma" }];
}

/** Ops tooling reads the import pipeline, so it needs a signed-in user too. */
export async function clientLoader() {
  await requireSession();
  return null;
}

function StatusPill({ status }: { status: Status }) {
  return <span className={`status-pill status-${status}`}><i />{status}</span>;
}

function PipelineRail() {
  const stages = [
    ["01", "Ingest", "Normalize every game into one provider-neutral record."],
    ["02", "Screen", "Scan every position at 50k nodes and flag evaluation swings."],
    ["03", "Deepen", "Spend 500k nodes only on decisions that explain your weaknesses."],
  ];
  return <div className="grid gap-px overflow-hidden rounded-panel border border-line bg-line md:grid-cols-3">
    {stages.map(([n, title, copy]) => <div className="bg-surface p-5" key={n}>
      <div className="metric text-xs text-accent">PASS {n}</div>
      <h3 className="mt-3 text-xl font-extrabold uppercase tracking-[-0.04em]">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-ink-muted">{copy}</p>
    </div>)}
  </div>;
}

function JobCard({ item, onCancel }: { item: AnalysisImport; onCancel: (id: string) => void }) {
  const done = progress(item);
  const hitRate = item.analyzedPositions ? Math.round(item.cacheHits / item.analyzedPositions * 100) : 0;
  const metrics = [
    [item.analyzedPositions.toLocaleString(), "Positions read"], [item.deepPositions.toLocaleString(), "Deep targets"],
    [`${hitRate}%`, "Cache hit rate"], [money(item.actualCostUsd), "Compute cost"],
  ];
  return <article className="panel overflow-hidden">
    <div className="flex flex-wrap items-start justify-between gap-4 border-b border-line p-5 sm:p-6">
      <div>
        <div className="flex items-center gap-3"><StatusPill status={item.status} /><span className="metric text-xs text-ink-faint">{item.id.slice(0, 8)}</span></div>
        <h2 className="mt-4 text-2xl font-black tracking-[-0.05em]">{item.username}</h2>
        <p className="mt-1 text-xs font-bold uppercase tracking-[0.12em] text-ink-faint">{item.platform} · {item.discoveredGames}/{item.requestedGames} games secured</p>
      </div>
      {active.has(item.status) && <button onClick={() => onCancel(item.id)} className="rounded-control border border-line px-3 py-2 text-xs font-bold uppercase tracking-[0.08em] text-ink-muted hover:border-loss hover:text-loss">Cancel</button>}
    </div>
    <div className="p-5 sm:p-6">
      <div className="mb-2 flex items-end justify-between"><span className="cap">Pipeline progress</span><span className="metric text-3xl font-bold text-accent">{done}%</span></div>
      <div className="h-2 overflow-hidden rounded-full bg-surface-2"><div className="h-full bg-accent transition-[width] duration-700" style={{ width: `${done}%` }} /></div>
      <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">{metrics.map(([value, label]) => <div key={label} className="rounded-[8px] border border-line bg-bg/45 p-4"><div className="metric text-xl font-bold">{value}</div><div className="cap mt-2">{label}</div></div>)}</div>
      <div className="mt-5 flex flex-wrap gap-x-6 gap-y-2 border-t border-line pt-4 text-xs text-ink-faint">
        <span><b className="text-ink">{item.runningTasks}</b> running</span><span><b className="text-ink">{item.queuedTasks}</b> queued</span><span><b className="text-ink">{item.completedTasks}</b> complete</span><span>estimate {money(item.estimatedCostUsd)}</span>
      </div>
      {item.error && <p className="mt-4 rounded-[6px] border border-loss/35 bg-loss/8 p-3 text-sm text-loss">{item.error}</p>}
    </div>
  </article>;
}

export default function Operations() {
  const [imports, setImports] = useState<AnalysisImport[]>([]);
  const [username, setUsername] = useState("ncarcasc");
  const [games, setGames] = useState(30);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasActive = useMemo(() => imports.some((item) => active.has(item.status)), [imports]);

  async function reload() {
    try {
      const response = await apiFetch("/imports");
      if (!response.ok) throw new Error(`API returned ${response.status}`);
      setImports((await response.json()).imports); setError(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }
  useEffect(() => { void reload(); }, []);
  useEffect(() => {
    if (!hasActive) return;
    const timer = window.setInterval(() => void reload(), 1600);
    return () => window.clearInterval(timer);
  }, [hasActive]);

  async function start(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      const response = await apiFetch("/imports/lichess", { json: { username, games } });
      if (!response.ok) throw new Error((await response.json()).error ?? `API returned ${response.status}`);
      await reload();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  async function cancel(id: string) { await apiFetch(`/imports/${id}/cancel`, { method: "POST" }); await reload(); }

  return <div className="relative z-10 min-h-dvh">
    <header className="border-b border-line bg-bg/80 backdrop-blur-xl"><div className="mx-auto flex h-16 max-w-[1240px] items-center justify-between px-5 sm:px-8">
      <Link to="/today" className="text-lg font-black uppercase tracking-[-0.05em]">Forma</Link>
      <div className="flex items-center gap-2"><span className="h-2 w-2 animate-pulse rounded-full bg-accent" /><span className="cap text-ink-muted">Engine online</span></div>
    </div></header>
    <main className="mx-auto max-w-[1240px] px-5 pb-24 pt-12 sm:px-8 sm:pt-16">
      <section className="grid items-end gap-10 lg:grid-cols-[1fr_25rem]">
        <div><div className="cap text-accent">Analysis operations / Epic 03</div><h1 className="mt-5 max-w-4xl text-5xl font-black uppercase leading-[0.88] tracking-[-0.075em] sm:text-7xl">Turn game history into <span className="text-accent">signal.</span></h1><p className="mt-7 max-w-2xl text-lg font-medium leading-relaxed text-ink-muted">A durable two-pass pipeline that sees every position, then concentrates engine power where your decisions broke down.</p></div>
        <form onSubmit={start} className="panel p-5">
          <div className="cap mb-4 text-accent">Launch Lichess import</div>
          <label className="cap block">Username<input value={username} onChange={(e) => setUsername(e.target.value)} className="mt-2 block h-11 w-full rounded-control border border-line bg-bg px-3 font-sans text-sm normal-case tracking-normal text-ink outline-none focus:border-accent" /></label>
          <label className="cap mt-4 block">Games<input type="number" min={1} max={500} value={games} onChange={(e) => setGames(Number(e.target.value))} className="mt-2 block h-11 w-full rounded-control border border-line bg-bg px-3 font-sans text-sm normal-case tracking-normal text-ink outline-none focus:border-accent" /></label>
          <button disabled={busy} className="mt-5 h-11 w-full rounded-control bg-accent text-sm font-black uppercase tracking-[0.08em] text-accent-ink hover:brightness-110 disabled:opacity-50">{busy ? "Queuing…" : "Start analysis"}</button>
        </form>
      </section>
      <section className="mt-14"><PipelineRail /></section>
      <section className="mt-14">
        <div className="mb-5 flex items-center justify-between"><h2 className="text-2xl font-black uppercase tracking-[-0.045em]">Live jobs</h2><button onClick={() => void reload()} className="cap hover:text-accent">Refresh data ↻</button></div>
        {error && <div className="mb-5 rounded-panel border border-loss/40 bg-loss/8 p-4 text-sm text-loss">Cannot reach analysis API: {error}</div>}
        <div className="grid gap-5">{imports.map((item) => <JobCard key={item.id} item={item} onCancel={cancel} />)}</div>
        {!imports.length && !error && <div className="panel grid min-h-48 place-items-center p-8 text-center"><div><div className="metric text-3xl text-ink-faint">00</div><p className="mt-2 text-sm text-ink-muted">No analysis jobs yet. Launch the first one above.</p></div></div>}
      </section>
    </main>
  </div>;
}
