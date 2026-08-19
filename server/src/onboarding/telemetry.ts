/**
 * Structured events for onboarding, per plans/v1-platform-spec.md §19 and
 * E16's observability requirements.
 *
 * Same discipline as the other telemetry modules: a closed field list per event
 * and a serializer that knows only those fields. Nothing here carries a user, a
 * subject, a provider handle, a position or a diagnostic answer.
 *
 * §19 asks for stage and duration, drop-off, eligible and coverage dimensions,
 * diagnostic selection and attempt, and baseline publication — all answerable
 * from counts and states. What would make these lines identifying is the thing
 * they deliberately omit: which person was at which stage.
 */

/** One onboarding stage entered. Drop-off is the difference between counts. */
export interface StageEvent {
  event: "onboarding_stage";
  traceId: string | null;
  onboardingRunId: string;
  stage: string;
  /** Time in the previous stage. Null on the first. */
  previousStageMs: number | null;
}

/** One baseline published. Coverage and size, never content. */
export interface BaselineEvent {
  event: "baseline_published";
  traceId: string | null;
  onboardingRunId: string;
  coverageState: string;
  limitationCount: number;
  eligibleGames: number;
  reportItems: number;
  /** True when a retry found the report it had already written. */
  alreadyPublished: boolean;
}

/** One diagnostic attempt. Whether it was right, never what was played. */
export interface DiagnosticEvent {
  event: "diagnostic_attempt";
  traceId: string | null;
  sessionId: string;
  purpose: string;
  correct: boolean;
  hintsUsed: number;
  withinTimedWindow: boolean;
}

export type OnboardingEvent = StageEvent | BaselineEvent | DiagnosticEvent;

export const ONBOARDING_EVENT_FIELDS = {
  onboarding_stage: ["event", "traceId", "onboardingRunId", "stage", "previousStageMs"],
  baseline_published: [
    "event", "traceId", "onboardingRunId", "coverageState", "limitationCount",
    "eligibleGames", "reportItems", "alreadyPublished",
  ],
  diagnostic_attempt: [
    "event", "traceId", "sessionId", "purpose", "correct", "hintsUsed", "withinTimedWindow",
  ],
} as const satisfies Record<OnboardingEvent["event"], readonly string[]>;

export function onboardingEventLine(event: OnboardingEvent): string {
  const allowed = ONBOARDING_EVENT_FIELDS[event.event] as readonly string[];
  const out: Record<string, unknown> = {};
  const source = event as unknown as Record<string, unknown>;
  for (const field of allowed) out[field] = source[field] ?? null;
  return JSON.stringify(out);
}

let sink: (line: string) => void = (line) => console.log(line);

/** Test seam: capture lines instead of printing them. */
export function setOnboardingEventSink(next: ((line: string) => void) | null): void {
  sink = next ?? ((line) => console.log(line));
}

export function recordOnboardingEvent(event: OnboardingEvent): void {
  sink(onboardingEventLine(event));
}
