/**
 * Structured events for the estimate and finding layer, per plans/
 * v1-platform-spec.md §19 and E15's observability requirements.
 *
 * Same discipline as the other telemetry modules: a closed field list per event
 * and a serializer that knows only those fields. Nothing here carries a
 * subject, a user, a concept a person struggles with, or an estimate. That last
 * exclusion is the one worth naming: an event saying "subject X scores 0.21 on
 * blunder avoidance" would put a judgement about a named person into a log
 * pipeline, which is a place nobody consented to be assessed.
 *
 * What the events carry are counts. §19 asks for estimator coverage, effective
 * N, finding yield and corrections, trajectory sample and survival, renderer
 * safety and publication freshness — all of which are answerable from counts,
 * and all of which stop being answerable if the fields are removed to make the
 * lines shorter.
 */

/** One subject report finished. Coverage, yield and cost for one publication. */
export interface SubjectReportEvent {
  event: "subject_report_built";
  traceId: string | null;
  runId: string;
  estimates: number;
  /** How many dimensions had too little evidence to estimate. */
  unavailableEstimates: number;
  trajectoryBins: number;
  findingsPublished: number;
  /** Dropped by false-discovery control or by the display cap. */
  findingsWithheld: number;
  /** Rendered text the safety check did not pass. */
  explanationsHeld: number;
  includedGames: number;
  durationMs: number;
}

/** One renderer refusal, so a pattern of them is visible before a user sees it. */
export interface RendererSafetyEvent {
  event: "renderer_safety";
  traceId: string | null;
  runId: string;
  findingType: string;
  state: string;
  /** How many unsupported tokens, never which ones: they are model output. */
  unsupportedCount: number;
}

export type EstimatesEvent = SubjectReportEvent | RendererSafetyEvent;

/** Every key an estimates event may emit. The security gate asserts against this. */
export const ESTIMATES_EVENT_FIELDS = {
  subject_report_built: [
    "event", "traceId", "runId", "estimates", "unavailableEstimates", "trajectoryBins",
    "findingsPublished", "findingsWithheld", "explanationsHeld", "includedGames", "durationMs",
  ],
  renderer_safety: ["event", "traceId", "runId", "findingType", "state", "unsupportedCount"],
} as const satisfies Record<EstimatesEvent["event"], readonly string[]>;

export function estimatesEventLine(event: EstimatesEvent): string {
  const allowed = ESTIMATES_EVENT_FIELDS[event.event] as readonly string[];
  const out: Record<string, unknown> = {};
  const source = event as unknown as Record<string, unknown>;
  for (const field of allowed) out[field] = source[field] ?? null;
  return JSON.stringify(out);
}

let sink: (line: string) => void = (line) => console.log(line);

/** Test seam: capture lines instead of printing them. */
export function setEstimatesEventSink(next: ((line: string) => void) | null): void {
  sink = next ?? ((line) => console.log(line));
}

export function recordEstimatesEvent(event: EstimatesEvent): void {
  sink(estimatesEventLine(event));
}
