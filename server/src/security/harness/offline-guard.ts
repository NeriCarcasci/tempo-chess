/**
 * Loopback-only network guard for the rehearsal API process.
 *
 * The rehearsal is meant to be self-contained and synthetic. The import routes
 * it exercises will, left alone, try to fetch games from a real chess provider
 * for whatever synthetic username the fixture invented. That request would leave
 * the machine, which is not something a "disposable, synthetic fixtures only"
 * rehearsal should ever do.
 *
 * Loaded with `--import` into the rehearsal API only. It is not imported by any
 * production code path and has no effect on the deployed service.
 */

const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

const realFetch = globalThis.fetch;

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url =
    typeof input === "string"
      ? new URL(input)
      : input instanceof URL
        ? input
        : new URL((input as Request).url);
  if (!ALLOWED_HOSTS.has(url.hostname)) {
    throw new Error(`e01 rehearsal: outbound request to ${url.hostname} refused`);
  }
  return realFetch(input, init);
}) as typeof fetch;
