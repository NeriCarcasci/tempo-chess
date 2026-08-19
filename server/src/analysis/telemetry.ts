/**
 * Structured events for the versioning and publication graph, per
 * plans/v1-platform-spec.md §19.
 *
 * Same discipline as `ops/telemetry.ts`: a closed field list per event and a
 * serializer that knows only those fields, so a field nobody thought about
 * cannot leak. The identifiers here are run, recipe and publication ids —
 * opaque, and deliberately never a subject id, a game id, a FEN, a player name
 * or a manifest body. A publication event says *what version became current*,
 * not whose data it was about.
 *
 * The questions these answer are the ones an operator has during a promotion:
 * did the manifest validate, how much was reused rather than recomputed, how
 * long did the pointer switch hold its lock, and did anything roll back.
 */

/** A run reached a terminal state, or failed its manifest check. */
export interface RunEvent {
  event: "analysis_run";
  traceId: string | null;
  runId: string;
  runType: string;
  recipeVersionId: string;
  from: string;
  to: string;
  /** Output families the recipe declared and the run did not produce. */
  missingFamilies: number;
  /** Families produced that the recipe never declared. */
  undeclaredFamilies: number;
  /** Roles carried over from an upstream run instead of recomputed. */
  reusedRoles: number;
  failureClass: string | null;
  durationMs: number | null;
}

/** A publication pointer moved, or refused to. */
export interface PublicationEvent {
  event: "publication_switch";
  traceId: string | null;
  target: string;
  publicationId: string | null;
  runId: string;
  previousRunId: string | null;
  reason: string;
  /** How long the switch held the target lock. The contention cost. */
  durationMs: number;
  /** Set when the switch was refused, e.g. an incomplete or mismatched run. */
  refusedCode: string | null;
}

/** A snapshot was frozen. Size is an operational signal: snapshots grow. */
export interface SnapshotEvent {
  event: "snapshot_frozen";
  traceId: string | null;
  snapshotId: string;
  cohortVersionId: string;
  gameCount: number;
  underCovered: boolean;
  /** True when an identical manifest already existed and nothing was written. */
  deduplicated: boolean;
  durationMs: number;
}

/** A recipe failed validation. Incompatibility is the signal worth alerting on. */
export interface RecipeValidationEvent {
  event: "recipe_validation";
  traceId: string | null;
  recipeKey: string;
  version: string;
  valid: boolean;
  incompatibleEdges: number;
  cyclic: boolean;
}

export type AnalysisEvent = RunEvent | PublicationEvent | SnapshotEvent | RecipeValidationEvent;

/** Every key an analysis event may emit. The security gate asserts against this. */
export const ANALYSIS_EVENT_FIELDS = {
  analysis_run: [
    "event", "traceId", "runId", "runType", "recipeVersionId", "from", "to",
    "missingFamilies", "undeclaredFamilies", "reusedRoles", "failureClass", "durationMs",
  ],
  publication_switch: [
    "event", "traceId", "target", "publicationId", "runId", "previousRunId", "reason",
    "durationMs", "refusedCode",
  ],
  snapshot_frozen: [
    "event", "traceId", "snapshotId", "cohortVersionId", "gameCount", "underCovered",
    "deduplicated", "durationMs",
  ],
  recipe_validation: ["event", "traceId", "recipeKey", "version", "valid", "incompatibleEdges", "cyclic"],
} as const satisfies Record<AnalysisEvent["event"], readonly string[]>;

export function analysisEventLine(event: AnalysisEvent): string {
  const allowed = ANALYSIS_EVENT_FIELDS[event.event] as readonly string[];
  const out: Record<string, unknown> = {};
  const source = event as unknown as Record<string, unknown>;
  for (const field of allowed) out[field] = source[field] ?? null;
  return JSON.stringify(out);
}

let sink: (line: string) => void = (line) => console.log(line);

/** Test seam: capture lines instead of printing them. */
export function setAnalysisEventSink(next: ((line: string) => void) | null): void {
  sink = next ?? ((line) => console.log(line));
}

export function recordAnalysisEvent(event: AnalysisEvent): void {
  sink(analysisEventLine(event));
}
