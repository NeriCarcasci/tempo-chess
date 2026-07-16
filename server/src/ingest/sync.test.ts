import assert from "node:assert/strict";
import {
  nextLichessWindow,
  requestWithBackoff,
  syncChesscomArchives,
  syncLichessWindows,
  type ChesscomSyncState,
  type LichessSyncState,
  type SyncStateStore,
} from "./sync.js";

class MemoryStore<T> implements SyncStateStore<T> {
  value?: T;
  saves = 0;
  async load(): Promise<T | undefined> { return this.value; }
  async save(_key: string, value: T): Promise<void> {
    this.value = structuredClone(value);
    this.saves += 1;
  }
}

const delays: number[] = [];
let attempts = 0;
const response = await requestWithBackoff(
  async () => ({ status: ++attempts < 3 ? 429 : 200 }),
  { maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 1_000, jitterRatio: 0 },
  { sleep: async (delay) => { delays.push(delay); } },
);
assert.equal(response.status, 200);
assert.deepEqual(delays, [100, 200]);
let networkAttempts = 0;
await requestWithBackoff(
  async () => {
    networkAttempts += 1;
    if (networkAttempts < 2) throw new TypeError("network unavailable");
    return { status: 200 };
  },
  { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
  { sleep: async () => undefined },
);
assert.equal(networkAttempts, 2);
await assert.rejects(
  () => requestWithBackoff(async () => ({ status: 200 }), { maxAttempts: 0, baseDelayMs: 1, maxDelayMs: 1 }),
  /Invalid retry policy/,
);

const chessStore = new MemoryStore<ChesscomSyncState>();
const written: string[] = [];
const seenValidators: Array<string | undefined> = [];
await syncChesscomArchives({
  accountKey: "chesscom:me",
  archiveUrls: ["2026-07", "2026-06"],
  store: chessStore,
  sink: { upsert: async (item) => { written.push(item.id); } },
  fetchArchive: async (url, validators) => {
    seenValidators.push(validators?.etag);
    return { status: "ok", items: [{ id: `${url}:1`, playedAt: 10 }], validators: { etag: url } };
  },
});
assert.deepEqual(written, ["2026-07:1", "2026-06:1"]);
assert.equal(chessStore.value?.highWaterMark, 10);
assert.equal(chessStore.value?.resume, undefined);

await syncChesscomArchives({
  accountKey: "chesscom:me",
  archiveUrls: ["2026-07", "2026-06"],
  store: chessStore,
  sink: { upsert: async () => { throw new Error("not modified archives must not write"); } },
  fetchArchive: async (url, validators) => {
    seenValidators.push(validators?.etag);
    return { status: "not-modified" };
  },
});
assert.deepEqual(seenValidators.slice(2), ["2026-07", "2026-06"]);

const resumeStore = new MemoryStore<ChesscomSyncState>();
resumeStore.value = {
  version: 1,
  validators: { "2026-07": { etag: "stale-for-resume" } },
  resume: { archiveUrl: "2026-07", itemOffset: 1 },
};
let resumeValidator: string | undefined = "not-called";
const resumedWrites: string[] = [];
await syncChesscomArchives({
  accountKey: "chesscom:resume",
  archiveUrls: ["2026-07"],
  store: resumeStore,
  sink: { upsert: async (item) => { resumedWrites.push(item.id); } },
  fetchArchive: async (_url, validator) => {
    resumeValidator = validator?.etag;
    return { status: "ok", items: [{ id: "already" }, { id: "remaining" }] };
  },
});
assert.equal(resumeValidator, undefined);
assert.deepEqual(resumedWrites, ["remaining"]);

const missingArchiveStore = new MemoryStore<ChesscomSyncState>();
missingArchiveStore.value = {
  version: 1,
  validators: {},
  resume: { archiveUrl: "missing", itemOffset: 1 },
};
await assert.rejects(() => syncChesscomArchives({
  accountKey: "chesscom:corrupt",
  archiveUrls: ["2026-07"],
  store: missingArchiveStore,
  sink: { upsert: async () => undefined },
  fetchArchive: async () => ({ status: "ok", items: [] }),
}), /resume archive is no longer available/);

const corruptChessStore = new MemoryStore<ChesscomSyncState>();
corruptChessStore.value = { version: 1, validators: [], resume: null } as unknown as ChesscomSyncState;
await assert.rejects(() => syncChesscomArchives({
  accountKey: "chesscom:invalid",
  archiveUrls: [],
  store: corruptChessStore,
  sink: { upsert: async () => undefined },
  fetchArchive: async () => ({ status: "ok", items: [] }),
}), /Invalid Chess.com sync state/);

assert.deepEqual(nextLichessWindow(1_000, 5_000, 2_000), { since: 999, until: 2_999 });
assert.throws(() => nextLichessWindow(1_000, 5_000, 1, 1), /Invalid Lichess sync window/);
assert.deepEqual(nextLichessWindow(undefined, 5_000, 2_000, 1, 4_000), { since: 4_000, until: 5_000 });
const lichessStore = new MemoryStore<LichessSyncState>();
const windows: Array<{ since: number; until: number }> = [];
const lichessWrites = new Set<string>();
await syncLichessWindows({
  accountKey: "lichess:me",
  now: 5,
  maxWindowMs: 2,
  initialSince: 0,
  store: lichessStore,
  sink: { upsert: async (item) => { lichessWrites.add(item.id); } },
  fetchWindow: async (window) => {
    windows.push(window);
    return [{ id: `at:${window.until}`, playedAt: window.until }];
  },
});
assert.deepEqual(windows, [{ since: 0, until: 2 }, { since: 1, until: 3 }, { since: 2, until: 4 }, { since: 3, until: 5 }]);
assert.equal(lichessStore.value?.highWaterMark, 5);
assert.equal(lichessWrites.size, 4);

console.log("sync tests passed");
