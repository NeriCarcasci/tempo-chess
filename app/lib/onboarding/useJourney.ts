import { useEffect, useMemo, useState } from "react";
import { listWorkflows } from "./api";
import {
  currentStep,
  emptyTracker,
  etaLabel,
  observe,
  readJourney,
  readSteps,
  remainingAt,
  type Journey,
  type Step,
} from "./sync";
import type { Workflow } from "../v1/types";

/**
 * Where the examination has got to, as one hook.
 *
 * It used to live inside `SyncStage`, which was fine while the full-screen wait
 * was the only place a person could watch a run. It is not any more: the
 * examination now runs behind `/today`, with a bar across the top of the
 * dashboard, and two implementations of "how far through is this" would drift
 * the day one of them was fixed. So the polling, the tracker and the estimate
 * are here, and both screens draw the same reading.
 *
 * The two rules it keeps from `usePoll`: nothing is asked for while the tab is
 * hidden, and a response that lands after unmount cannot set state. What it
 * deliberately does *not* borrow is the loader seed — this has none, and waiting
 * a whole interval before the first reading would leave a bar with no
 * denominator for six seconds every time somebody reloads.
 */

/**
 * Slower than the run's own poll on purpose. One reading of the workflow list
 * is up to three requests, and the weights move in units of a whole game.
 */
const WEIGH_MS = 6_000;

function useWorkflows(enabled: boolean): { workflows: Workflow[]; error: unknown } {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const read = async (): Promise<void> => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      try {
        const next = await listWorkflows();
        if (cancelled) return;
        setWorkflows(next);
        setError(null);
      } catch (caught) {
        if (cancelled) return;
        // A redirect is a Response and belongs to the router. The run's own
        // poll on the surrounding route is what turns an expired session into a
        // sign-in; a progress bar must not navigate on its own.
        if (caught instanceof Response) return;
        setError(caught);
      }
    };
    void read();
    const timer = setInterval(() => void read(), WEIGH_MS);
    // Ask immediately on tab return, exactly as `usePoll` does. Reads are
    // skipped while hidden, so without this the person who comes back to check
    // on the run stares at a bar up to a poll's width out of date -- the one
    // moment the screen is being looked at is the one it was stalest.
    const onVisible = (): void => {
      if (document.visibilityState === "visible") void read();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled]);

  return { workflows, error };
}

export interface JourneyReading {
  journey: Journey;
  /** The four named steps, each answering for its own progress. */
  steps: Step[];
  /** The one being worked on now, or null once everything has finished. */
  step: Step | null;
  /** Its position in the four, from 1. Zero once nothing is running. */
  stepNumber: number;
  /** The bar's fill, high-water marked, or null while nothing is measurable. */
  fraction: number | null;
  /**
   * The estimate as a sentence, never as a ticking clock, and null unless the
   * step running now is the one it was measured from. Throughput is observed on
   * analysis weight alone, so quoting it beside "rebuilding the positions"
   * would be attaching a number to work it did not measure.
   */
  eta: string | null;
  /** A workflow read that failed. The caller decides whether it is worth saying. */
  error: unknown;
}

export function useJourney(runStage: string, enabled = true): JourneyReading {
  const { workflows, error } = useWorkflows(enabled);
  const journey = useMemo(() => readJourney(workflows, runStage), [workflows, runStage]);
  const steps = useMemo(() => readSteps(workflows, runStage), [workflows, runStage]);

  const [tracker, setTracker] = useState(emptyTracker);
  // Folded in when a reading lands, not on every render: a sample taken over no
  // elapsed work is a rate of infinity, and two of them in a row would put a
  // fabricated estimate on screen inside a second.
  useEffect(() => {
    setTracker((current) => observe(current, { at: Date.now(), journey }));
  }, [journey]);

  const step = currentStep(steps);
  const remaining = remainingAt(tracker, Date.now());

  return {
    journey,
    steps,
    step,
    stepNumber: step ? steps.indexOf(step) + 1 : 0,
    fraction: tracker.fraction,
    // Only while studying, and only once there is enough evidence for a figure.
    // "Working out how long this will take" was being shown for minutes beside
    // work whose length nothing was measuring, which is a hedge rather than an
    // estimate — the step's own tally is the honest answer in that window.
    eta: step?.key === "analyse" && remaining !== null ? etaLabel(remaining) : null,
    error,
  };
}
