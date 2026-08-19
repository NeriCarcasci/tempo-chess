/**
 * Structured events for the human-context layer, per plans/v1-platform-spec.md
 * §19 and E14's observability requirements.
 *
 * Same discipline as `engine/telemetry.ts`: a closed field list per event and a
 * serializer that knows only those fields, so a field nobody thought about
 * cannot leak. Nothing here carries a FEN, a position, a rating, an account or
 * a subject. A rating is the whole input to a human-policy inference and is
 * exactly the thing that would make one of these lines identifying, so the
 * events carry the *slice* they were answered under and never the number.
 *
 * §19's questions for this layer are inference latency, cost and cache;
 * coverage, out-of-domain and unavailable; calibration error by slice; retained
 * mass and entropy; and promotion comparison. The first three are answered per
 * task here. Calibration error by slice is not an event: it is a row in
 * `analysis.validation_metrics`, written once per benchmark and queryable
 * forever, and re-emitting it as a log line would be a second source that can
 * disagree with the first.
 */

/** One practical-context task finished. Coverage and cost per game. */
export interface PracticalContextEvent {
  event: "practical_context_written";
  traceId: string | null;
  runId: string;
  /** Assessments this task answered, available or not. */
  written: number;
  available: number;
  /** The distinct refusal reasons, comma-joined. Never a count per player. */
  unavailableReasons: string;
  inferencesComputed: number;
  inferencesReused: number;
}

/** One inference batch's latency and mass. Emitted per slice, not per position. */
export interface ModelInferenceEvent {
  event: "model_inference";
  traceId: string | null;
  slice: string;
  positions: number;
  failures: number;
  latencyP95Ms: number | null;
  /** Mean retained mass and entropy: how much of the policy we are keeping. */
  meanRetainedMass: number | null;
  meanEntropyBits: number | null;
  outOfDomain: number;
}

export type ModelsEvent = PracticalContextEvent | ModelInferenceEvent;

/** Every key a models event may emit. The security gate asserts against this. */
export const MODELS_EVENT_FIELDS = {
  practical_context_written: [
    "event", "traceId", "runId", "written", "available", "unavailableReasons",
    "inferencesComputed", "inferencesReused",
  ],
  model_inference: [
    "event", "traceId", "slice", "positions", "failures", "latencyP95Ms",
    "meanRetainedMass", "meanEntropyBits", "outOfDomain",
  ],
} as const satisfies Record<ModelsEvent["event"], readonly string[]>;

export function modelsEventLine(event: ModelsEvent): string {
  const allowed = MODELS_EVENT_FIELDS[event.event] as readonly string[];
  const out: Record<string, unknown> = {};
  const source = event as unknown as Record<string, unknown>;
  for (const field of allowed) out[field] = source[field] ?? null;
  return JSON.stringify(out);
}

let sink: (line: string) => void = (line) => console.log(line);

/** Test seam: capture lines instead of printing them. */
export function setModelsEventSink(next: ((line: string) => void) | null): void {
  sink = next ?? ((line) => console.log(line));
}

export function recordModelsEvent(event: ModelsEvent): void {
  sink(modelsEventLine(event));
}
