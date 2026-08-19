/**
 * Structured events for the engine worker, per plans/v1-platform-spec.md §19.
 *
 * Same discipline as `ops/telemetry.ts` and `analysis/telemetry.ts`: a closed
 * field list per event and a serializer that knows only those fields, so a
 * field nobody thought about cannot leak. Nothing here carries a FEN, a PGN, a
 * position, a subject, a player name or an account — an engine event says how
 * much work was done and how it went, never what was analysed.
 *
 * §19 asks these of the engine: "what are Stockfish latency, nodes, cache hit,
 * and cost per game?" Two events answer it. Queue depth, oldest ready-item age,
 * lease expiry and duplicate delivery are already answered by E04's `work_depth`
 * and `lease_recovery` events over the same ledger rows, so they are not
 * re-emitted here — a second source for one number is a second thing that can
 * be wrong about it.
 */

/** One engine task finished, or failed. The cost-per-game signal. */
export interface EngineTaskEvent {
  event: "engine_task";
  traceId: string | null;
  taskType: string;
  queue: string;
  /** How long the item waited between becoming ready and being claimed. */
  queueAgeMs: number | null;
  /** UCI handshake to `readyok`. A rising value means cold starts dominate. */
  engineStartupMs: number | null;
  positions: number;
  cacheHits: number;
  cacheMisses: number;
  /** Positions selected for a deeper look by this task. */
  deepSelected: number;
  nodes: number;
  nps: number | null;
  engineMs: number;
  durationMs: number;
  estimatedCostMicroUsd: number;
  /** A closed retry class from E04's vocabulary, never an engine message. */
  failureClass: string | null;
  /** A short stable code such as `engine_unavailable`. Never a stack trace. */
  errorCode: string | null;
}

/** Cache effectiveness for one scope. Emitted once per scope per task. */
export interface EngineCacheEvent {
  event: "engine_cache";
  traceId: string | null;
  taskType: string;
  scope: string;
  profile: string;
  hits: number;
  misses: number;
}

export type EngineEvent = EngineTaskEvent | EngineCacheEvent;

/** Every key an engine event may emit. The security gate asserts against this. */
export const ENGINE_EVENT_FIELDS = {
  engine_task: [
    "event", "traceId", "taskType", "queue", "queueAgeMs", "engineStartupMs", "positions",
    "cacheHits", "cacheMisses", "deepSelected", "nodes", "nps", "engineMs", "durationMs",
    "estimatedCostMicroUsd", "failureClass", "errorCode",
  ],
  engine_cache: ["event", "traceId", "taskType", "scope", "profile", "hits", "misses"],
} as const satisfies Record<EngineEvent["event"], readonly string[]>;

export function engineEventLine(event: EngineEvent): string {
  const allowed = ENGINE_EVENT_FIELDS[event.event] as readonly string[];
  const out: Record<string, unknown> = {};
  const source = event as unknown as Record<string, unknown>;
  for (const field of allowed) out[field] = source[field] ?? null;
  return JSON.stringify(out);
}

let sink: (line: string) => void = (line) => console.log(line);

/** Test seam: capture lines instead of printing them. */
export function setEngineEventSink(next: ((line: string) => void) | null): void {
  sink = next ?? ((line) => console.log(line));
}

export function recordEngineEvent(event: EngineEvent): void {
  sink(engineEventLine(event));
}
