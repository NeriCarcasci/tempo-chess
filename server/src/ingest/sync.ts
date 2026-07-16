export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio?: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 250,
  maxDelayMs: 8_000,
  jitterRatio: 0.2,
};

export interface HttpLikeResponse {
  status: number;
}

export interface RetryDependencies {
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
}

function validateRetryPolicy(policy: RetryPolicy): void {
  if (
    !Number.isInteger(policy.maxAttempts)
    || policy.maxAttempts < 1
    || !Number.isFinite(policy.baseDelayMs)
    || policy.baseDelayMs < 0
    || !Number.isFinite(policy.maxDelayMs)
    || policy.maxDelayMs < policy.baseDelayMs
    || (policy.jitterRatio !== undefined
      && (!Number.isFinite(policy.jitterRatio) || policy.jitterRatio < 0 || policy.jitterRatio > 1))
  ) {
    throw new Error("Invalid retry policy");
  }
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export function retryDelayMs(
  failedAttempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  random = Math.random,
): number {
  validateRetryPolicy(policy);
  const raw = Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * 2 ** Math.max(0, failedAttempt - 1),
  );
  const jitter = policy.jitterRatio ?? 0;
  return Math.round(raw * (1 - jitter + 2 * jitter * random()));
}

/** Retries only rate limits and transient server failures; other responses pass through. */
export async function requestWithBackoff<T extends HttpLikeResponse>(
  request: () => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  dependencies: RetryDependencies = {},
): Promise<T> {
  validateRetryPolicy(policy);
  const sleep = dependencies.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = dependencies.random ?? Math.random;
  let lastResponse: T | undefined;
  let lastError: unknown;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      lastResponse = await request();
      lastError = undefined;
      if (!isRetryableStatus(lastResponse.status) || attempt === policy.maxAttempts) {
        return lastResponse;
      }
    } catch (error) {
      // Fetch-style network failures are transient; caller validation/auth errors should
      // be represented by non-retryable HTTP responses rather than thrown exceptions.
      lastError = error;
      if (attempt === policy.maxAttempts) throw error;
    }
    await sleep(retryDelayMs(attempt, policy, random));
  }
  if (lastError) throw lastError;
  return lastResponse!;
}

export interface ImportedItem {
  /** Stable provider identity used as the idempotency key. */
  id: string;
  playedAt?: number;
}

export interface IdempotentImportSink<T extends ImportedItem> {
  upsert(item: T): Promise<void>;
}

export interface SyncStateStore<T> {
  load(accountKey: string): Promise<T | undefined>;
  save(accountKey: string, state: T): Promise<void>;
}

export interface CacheValidators {
  etag?: string;
  lastModified?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validCacheValidators(value: unknown): value is CacheValidators {
  return isRecord(value)
    && (value.etag === undefined || typeof value.etag === "string")
    && (value.lastModified === undefined || typeof value.lastModified === "string");
}

export interface ChesscomSyncState {
  version: 1;
  validators: Record<string, CacheValidators>;
  resume?: { archiveUrl: string; itemOffset: number };
  highWaterMark?: number;
}

export type ChesscomArchiveResult<T> =
  | { status: "not-modified"; validators?: CacheValidators }
  | { status: "ok"; items: readonly T[]; validators?: CacheValidators };

export interface ChesscomSyncOptions<T extends ImportedItem> {
  accountKey: string;
  /** Newest first. A changed current-month archive is revisited on every run. */
  archiveUrls: readonly string[];
  store: SyncStateStore<ChesscomSyncState>;
  sink: IdempotentImportSink<T>;
  fetchArchive: (
    archiveUrl: string,
    validators: CacheValidators | undefined,
  ) => Promise<ChesscomArchiveResult<T>>;
}

/**
 * Processes monthly archives with HTTP cache validation and per-item checkpoints.
 * If a process dies after upsert but before save, the stable-id upsert safely replays.
 */
export async function syncChesscomArchives<T extends ImportedItem>(
  options: ChesscomSyncOptions<T>,
): Promise<ChesscomSyncState> {
  const state = (await options.store.load(options.accountKey)) ?? {
    version: 1,
    validators: {},
  };
  const resumeState: unknown = state.resume;
  if (
    state.version !== 1
    || !isRecord(state.validators)
    || !Object.values(state.validators).every(validCacheValidators)
    || (state.highWaterMark !== undefined && !Number.isFinite(state.highWaterMark))
    || (resumeState !== undefined && (
      !isRecord(resumeState)
      || typeof resumeState.archiveUrl !== "string"
      || !Number.isInteger(resumeState.itemOffset)
      || (resumeState.itemOffset as number) < 0
    ))
  ) {
    throw new Error("Invalid Chess.com sync state");
  }
  if (state.resume && !options.archiveUrls.includes(state.resume.archiveUrl)) {
    throw new Error(`Chess.com resume archive is no longer available: ${state.resume.archiveUrl}`);
  }
  let resumeReached = state.resume === undefined;

  for (const archiveUrl of options.archiveUrls) {
    if (!resumeReached) {
      if (archiveUrl !== state.resume!.archiveUrl) continue;
      resumeReached = true;
    }

    const isResumingArchive = state.resume?.archiveUrl === archiveUrl;
    // A partial archive must be fetched in full again so itemOffset can resume it;
    // a conditional 304 would otherwise discard the unfinished tail.
    const result = await options.fetchArchive(
      archiveUrl,
      isResumingArchive ? undefined : state.validators[archiveUrl],
    );
    if (result.validators) state.validators[archiveUrl] = result.validators;
    if (result.status === "not-modified") {
      state.resume = undefined;
      await options.store.save(options.accountKey, state);
      continue;
    }

    const start = isResumingArchive ? state.resume!.itemOffset : 0;
    for (let index = start; index < result.items.length; index += 1) {
      const item = result.items[index]!;
      await options.sink.upsert(item);
      state.highWaterMark = Math.max(state.highWaterMark ?? 0, item.playedAt ?? 0) || undefined;
      state.resume = { archiveUrl, itemOffset: index + 1 };
      await options.store.save(options.accountKey, state);
    }
    state.resume = undefined;
    await options.store.save(options.accountKey, state);
  }

  state.resume = undefined;
  await options.store.save(options.accountKey, state);
  return state;
}

export interface LichessWindow {
  since: number;
  until: number;
}

export interface LichessSyncState {
  version: 1;
  highWaterMark?: number;
  resume?: LichessWindow & { itemOffset: number };
}

export function nextLichessWindow(
  highWaterMark: number | undefined,
  now: number,
  maxWindowMs: number,
  overlapMs = 1,
  initialSince = 0,
): LichessWindow | undefined {
  if (
    !Number.isFinite(now)
    || maxWindowMs <= 0
    || overlapMs < 0
    || overlapMs >= maxWindowMs
    || !Number.isFinite(initialSince)
    || initialSince < 0
    || initialSince > now
  ) {
    throw new Error("Invalid Lichess sync window configuration");
  }
  if (highWaterMark !== undefined && highWaterMark >= now) return undefined;
  const since = Math.max(
    initialSince,
    (highWaterMark ?? initialSince) - (highWaterMark === undefined ? 0 : overlapMs),
  );
  if (since >= now) return undefined;
  return { since, until: Math.min(now, since + maxWindowMs) };
}

export interface LichessSyncOptions<T extends ImportedItem> {
  accountKey: string;
  now: number;
  maxWindowMs: number;
  /** Explicit beginning of the historical import; prevents epoch-to-present empty scans. */
  initialSince: number;
  overlapMs?: number;
  store: SyncStateStore<LichessSyncState>;
  sink: IdempotentImportSink<T>;
  /** Fetch must return a deterministic order for a given inclusive window. */
  fetchWindow: (window: LichessWindow) => Promise<readonly T[]>;
}

/** Processes bounded since/until windows and persists progress after every item. */
export async function syncLichessWindows<T extends ImportedItem>(
  options: LichessSyncOptions<T>,
): Promise<LichessSyncState> {
  const state = (await options.store.load(options.accountKey)) ?? { version: 1 };
  const resumeState: unknown = state.resume;
  if (
    state.version !== 1
    || (state.highWaterMark !== undefined && !Number.isFinite(state.highWaterMark))
    || (resumeState !== undefined && (
      !isRecord(resumeState)
      || !Number.isFinite(resumeState.since)
      || !Number.isFinite(resumeState.until)
      || (resumeState.since as number) >= (resumeState.until as number)
      || !Number.isInteger(resumeState.itemOffset)
      || (resumeState.itemOffset as number) < 0
    ))
  ) {
    throw new Error("Invalid Lichess sync state");
  }

  for (;;) {
    const window = state.resume ?? nextLichessWindow(
      state.highWaterMark,
      options.now,
      options.maxWindowMs,
      options.overlapMs,
      options.initialSince,
    );
    if (!window) break;
    const items = await options.fetchWindow(window);
    const start = state.resume?.itemOffset ?? 0;

    for (let index = start; index < items.length; index += 1) {
      await options.sink.upsert(items[index]!);
      state.resume = { since: window.since, until: window.until, itemOffset: index + 1 };
      await options.store.save(options.accountKey, state);
    }
    state.highWaterMark = window.until;
    state.resume = undefined;
    await options.store.save(options.accountKey, state);
  }
  return state;
}
