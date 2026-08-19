import { useEffect, useRef, useState } from "react";

/**
 * Ask again, on an interval, while it is worth asking.
 *
 * Three rules, each of which is a bug somebody has shipped:
 *
 *   * stop when the tab is hidden, and ask once immediately on return. A
 *     backgrounded tab polling every four seconds for an hour is somebody's
 *     battery and our rate limit;
 *   * clear the interval on unmount, and hold a cancelled flag so a response
 *     that arrives after unmount cannot set state;
 *   * `enabled` is re-evaluated every tick from the *latest* data, so a poll
 *     stops the moment the thing it was waiting for finishes or dies.
 */
/** Consecutive failures before the screen stops and says something. */
const MAX_CONSECUTIVE_FAILURES = 3;

export function usePoll<T>(
  fetcher: () => Promise<T>,
  options: {
    /** Seed, so the first paint has real data rather than a spinner. */
    initial: T;
    intervalMs: number;
    /** Given the latest value, should we ask again? */
    enabled: (value: T) => boolean;
  },
): { value: T; error: unknown; polling: boolean } {
  const [value, setValue] = useState<T>(options.initial);
  const [error, setError] = useState<unknown>(null);
  const [polling, setPolling] = useState<boolean>(() => options.enabled(options.initial));

  // Held in refs so changing the callback identity between renders does not
  // restart the interval — a poll that restarts every render is a poll with no
  // interval at all.
  const fetcherRef = useRef(fetcher);
  const enabledRef = useRef(options.enabled);
  fetcherRef.current = fetcher;
  enabledRef.current = options.enabled;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    let failures = 0;

    const tick = async (): Promise<void> => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      try {
        const next = await fetcherRef.current();
        if (cancelled) return;
        setValue(next);
        setError(null);
        failures = 0;
        if (!enabledRef.current(next)) {
          setPolling(false);
          if (timer) clearInterval(timer);
          timer = null;
        }
      } catch (caught) {
        if (cancelled) return;
        // A redirect is a Response, and it must reach the router: the client
        // throws one on a 401 so an expired session becomes a sign-in rather
        // than a permanent error card on a page that will never move again.
        if (caught instanceof Response) throw caught;

        // One failure is a blip — a sleeping laptop, a dropped packet — and
        // killing the loop for the life of the page would leave somebody
        // watching a bar that has stopped for ever. Several in a row is a
        // problem worth showing.
        failures += 1;
        if (failures < MAX_CONSECUTIVE_FAILURES) return;
        setError(caught);
        setPolling(false);
        if (timer) clearInterval(timer);
        timer = null;
      }
    };

    if (enabledRef.current(value)) {
      timer = setInterval(tick, options.intervalMs);
    }

    const onVisible = (): void => {
      if (document.visibilityState === "visible" && timer) void tick();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisible);
    }

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisible);
      }
    };
    // Only the interval restarts this effect. `value` is deliberately absent:
    // including it would tear down and rebuild the timer on every tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.intervalMs]);

  return { value, error, polling };
}
