/**
 * `node --test --import tsx src/sync/pagination.test.ts` — the walk and the
 * cursor, offline.
 *
 * The sync stopped early and said it was finished. One Lichess account held 337
 * games; Forma had 196 of them, the run was marked succeeded with
 * `moreAvailable: false`, and every re-sync stopped in the same place and
 * agreed. Two things had to be true for that, and neither needs a database or a
 * provider to demonstrate: the adapter turned a 404 into a page with no games
 * on it, and the walk read a page with no games on it — or merely fewer games
 * than it asked for — as the end of the archive.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import {
  MAX_PAGES_PER_ITEM,
  SYNC_PAGE_SIZE,
  UnsupportedProvider,
  syncFailureClass,
  syncWorkFailure,
  walkProviderPages,
} from "./worker.js";
import {
  ProviderAccountMissing,
  ProviderUnavailable,
  SYNC_USER_AGENT,
  fetchLichessPage,
} from "./providers.js";
import type { ProviderFetch, ProviderPage } from "./providers.js";
import type { ProviderGameInput } from "./contract.js";
import { WorkFailure } from "../ops/retry.js";

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

function game(createdAt: number): ProviderGameInput {
  return { providerGameId: `g${createdAt}`, moves: [{ uci: "e2e4" }], playedAt: new Date(createdAt) };
}

/**
 * A page as a provider would hand it over: `received` records, of which
 * `mapped` became games. Keeping the two apart is the point — the walk used to
 * read the second as though it were the first.
 */
function page(received: number, mapped: number, newestCreatedAt: number): ProviderPage {
  return {
    games: Array.from({ length: mapped }, (_, index) => game(newestCreatedAt - mapped + 1 + index)),
    received,
    cursorAfter: String(newestCreatedAt),
  };
}

/** A fetch that hands back a script of pages and records what it was asked. */
function scripted(pages: readonly ProviderPage[]): {
  fetchPage: ProviderFetch;
  asked: { since: string | null; limit: number }[];
} {
  const asked: { since: string | null; limit: number }[] = [];
  const fetchPage: ProviderFetch = async ({ since, limit }) => {
    asked.push({ since, limit });
    return pages[asked.length - 1] ?? { games: [], received: 0, cursorAfter: null };
  };
  return { fetchPage, asked };
}

async function walk(pages: readonly ProviderPage[], since: string | null = null) {
  const { fetchPage, asked } = scripted(pages);
  const committed: ProviderPage[] = [];
  const sequences: number[] = [];
  const result = await walkProviderPages({
    fetchPage,
    username: "ncarcasc",
    since,
    commit: async (fetched, sequenceNo) => {
      committed.push(fetched);
      sequences.push(sequenceNo);
    },
  });
  return { result, asked, committed, sequences };
}

test("a full page the adapter could not fully map is not the end of the archive", async () => {
  // The shape that lost 139 games: a hundred records came back, two of them
  // were unreadable, and the walk called it a complete archive.
  const { result, committed } = await walk([
    page(SYNC_PAGE_SIZE, SYNC_PAGE_SIZE, 1_000),
    page(SYNC_PAGE_SIZE, SYNC_PAGE_SIZE - 2, 2_000),
    page(37, 37, 3_000),
  ]);

  assert.equal(result.pages, 3);
  assert.equal(result.cursorAfter, "3000");
  assert.equal(result.moreAvailable, false);
  const games = committed.reduce((total, fetched) => total + fetched.games.length, 0);
  assert.equal(games, SYNC_PAGE_SIZE + (SYNC_PAGE_SIZE - 2) + 37);
});

test("a page the provider itself cut short is not the end of the archive either", async () => {
  // How many records a page carries is the provider's decision, not a promise
  // about what is behind it. Only an empty page is that promise.
  const { result, asked, committed } = await walk([
    page(SYNC_PAGE_SIZE, SYNC_PAGE_SIZE, 1_000),
    page(SYNC_PAGE_SIZE - 2, SYNC_PAGE_SIZE - 2, 2_000),
    page(40, 40, 3_000),
  ]);

  assert.equal(result.pages, 3);
  assert.equal(result.cursorAfter, "3000");
  assert.equal(result.moreAvailable, false);
  // Three pages of games and the empty page that proved there were no more.
  assert.equal(asked.length, 4);
  const games = committed.reduce((total, fetched) => total + fetched.games.length, 0);
  assert.equal(games, SYNC_PAGE_SIZE + (SYNC_PAGE_SIZE - 2) + 40);
});

test("a walk that hit its page budget says so rather than claiming completeness", async () => {
  const full = Array.from({ length: MAX_PAGES_PER_ITEM }, (_, index) =>
    page(SYNC_PAGE_SIZE, SYNC_PAGE_SIZE, (index + 1) * 1_000),
  );
  const { result } = await walk(full);

  // The item hands back rather than walking an entire archive in one lease, and
  // it has to say so. A `moreAvailable: false` here would be the summary
  // telling a planner there is nothing left to ask for.
  assert.equal(result.pages, MAX_PAGES_PER_ITEM);
  assert.equal(result.moreAvailable, true);
  assert.equal(result.cursorAfter, String(MAX_PAGES_PER_ITEM * 1_000));
});

test("each page resumes from the cursor the page before it ended at", async () => {
  const { asked, sequences } = await walk(
    [
      page(SYNC_PAGE_SIZE, SYNC_PAGE_SIZE, 1_000),
      page(SYNC_PAGE_SIZE, SYNC_PAGE_SIZE, 2_000),
      page(5, 5, 3_000),
    ],
    "500",
  );

  assert.deepEqual(
    asked.map((request) => request.since),
    ["500", "1000", "2000", "3000"],
  );
  assert.deepEqual(
    asked.map((request) => request.limit),
    Array.from({ length: 4 }, () => SYNC_PAGE_SIZE),
  );
  // The sequence number is the checkpoint's identity, so it counts pages
  // committed and never restarts inside a run.
  assert.deepEqual(sequences, [1, 2, 3]);
});

test("a page of records none of which mapped still moves the cursor past them", async () => {
  // Committing an empty batch is the point: the cursor advances, so the next
  // page is the one after these rather than these again.
  const { result, committed } = await walk([
    page(SYNC_PAGE_SIZE, 0, 1_000),
    page(4, 4, 2_000),
  ]);

  assert.equal(result.pages, 2);
  assert.equal(result.cursorAfter, "2000");
  assert.equal(committed[0].games.length, 0);
});

test("a provider with nothing to give commits nothing and moves no cursor", async () => {
  const { result, committed } = await walk([{ games: [], received: 0, cursorAfter: null }]);

  assert.equal(result.pages, 0);
  assert.equal(result.cursorAfter, null);
  assert.equal(result.moreAvailable, false);
  assert.equal(committed.length, 0);
});

test("a page that did not move the cursor is not asked for again", async () => {
  // Without this the same hundred games are fetched, committed and re-fetched
  // until the lease dies.
  const stuck: ProviderPage = { games: [game(1_000)], received: SYNC_PAGE_SIZE, cursorAfter: "500" };
  const { result, asked } = await walk([stuck, stuck, stuck], "500");

  assert.equal(asked.length, 1);
  assert.equal(result.pages, 1);
  // Stopping because we cannot position the provider's records is not the same
  // as finishing, and the summary must not read like it was.
  assert.equal(result.moreAvailable, true);
});

test("a cancelled checkpoint stops the walk and still reports what is left", async () => {
  const { fetchPage, asked } = scripted([
    page(SYNC_PAGE_SIZE, SYNC_PAGE_SIZE, 1_000),
    page(SYNC_PAGE_SIZE, SYNC_PAGE_SIZE, 2_000),
  ]);
  const result = await walkProviderPages({
    fetchPage,
    username: "ncarcasc",
    since: null,
    commit: async () => {},
    checkpoint: async () => ({ continue: false }),
  });

  assert.equal(asked.length, 1);
  assert.equal(result.pages, 1);
  assert.equal(result.moreAvailable, true);
});

// ---------------------------------------------------------------------------
// The Lichess adapter
// ---------------------------------------------------------------------------

interface StubbedCall {
  url: string;
  headers: Record<string, string>;
}

/** Replace `fetch` for one call and hand back what the adapter asked for. */
async function withStubbedFetch<T>(
  respond: (call: StubbedCall) => Response,
  body: (calls: StubbedCall[]) => Promise<T>,
): Promise<T> {
  const calls: StubbedCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const call: StubbedCall = {
      url: String(url),
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([key, value]) => [
          key.toLowerCase(),
          value,
        ]),
      ),
    };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  try {
    return await body(calls);
  } finally {
    globalThis.fetch = original;
  }
}

function ndjson(...records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n");
}

test("received counts what the provider sent, not what the adapter could read", async () => {
  // A Lichess game with no move list at all — an abort before the first move
  // reads like this — is not a game Forma can store, but it is still one of the
  // records the provider counted against `max`.
  const body = ndjson(
    { id: "aaa", status: "mate", winner: "white", createdAt: 1_000, moves: "e2e4 e7e5" },
    { id: "bbb", status: "aborted", createdAt: 2_000 },
    { id: "ccc", status: "resign", winner: "black", createdAt: 3_000, moves: "d2d4" },
  );

  const result = await withStubbedFetch(
    () => new Response(body, { status: 200 }),
    async () => fetchLichessPage({ username: "ncarcasc", since: null, limit: 100 }),
  );

  assert.equal(result.received, 3);
  assert.equal(result.games.length, 2);
  // The unreadable record still carries a timestamp, and the cursor has to pass
  // it or the next page starts on it again.
  assert.equal(result.cursorAfter, "3000");
});

test("a page is requested oldest-first, bounded, and strictly after the cursor", async () => {
  const call = await withStubbedFetch(
    () => new Response("", { status: 200 }),
    async (calls) => {
      await fetchLichessPage({ username: "ncarcasc", since: "1785080181017", limit: 100 });
      return calls[0];
    },
  );
  const url = new URL(call.url);

  assert.equal(url.pathname, "/api/games/user/ncarcasc");
  assert.equal(url.searchParams.get("sort"), "dateAsc");
  assert.equal(url.searchParams.get("max"), "100");
  // Strictly after: `since` is inclusive, so resending the cursor itself would
  // re-read the game the cursor came from on every page.
  assert.equal(url.searchParams.get("since"), "1785080181018");
});

test("every provider request identifies itself", async () => {
  const call = await withStubbedFetch(
    () => new Response("", { status: 200 }),
    async (calls) => {
      await fetchLichessPage({ username: "ncarcasc", since: null, limit: 100 });
      return calls[0];
    },
  );

  // Lichess throttles anonymous clients that send no User-Agent far harder than
  // ones that do, which is how a few hundred games turned into a run of 429s.
  assert.equal(call.headers["user-agent"], SYNC_USER_AGENT);
  assert.ok(SYNC_USER_AGENT.length > 0);
});

test("a provider that has no such account fails by name, never as an empty archive", async () => {
  await withStubbedFetch(
    () => new Response('{"error":"Not found"}', { status: 404 }),
    async () => {
      await assert.rejects(
        () => fetchLichessPage({ username: "someone-who-left", since: null, limit: 100 }),
        (error: unknown) => {
          assert.ok(error instanceof ProviderAccountMissing);
          assert.equal(error.providerSlug, "lichess");
          return true;
        },
      );
    },
  );
});

test("a 404 for an account the provider still has is a provider fault, not a missing account", async () => {
  // This is the 404 that stopped a real sync: Lichess throttling an anonymous
  // client mid-archive. Swallowed as an empty page it read as a finished
  // archive; classified as a missing account it would kill a working link.
  const calls = await withStubbedFetch(
    (call) =>
      call.url.includes("/api/games/user/")
        ? new Response("", { status: 404 })
        : new Response('{"id":"ncarcasc","username":"ncarcasc"}', { status: 200 }),
    async (seen) => {
      await assert.rejects(
        () => fetchLichessPage({ username: "ncarcasc", since: null, limit: 100 }),
        (error: unknown) => {
          assert.ok(error instanceof ProviderUnavailable);
          assert.equal(error.status, 404);
          return true;
        },
      );
      return seen;
    },
  );

  assert.equal(calls.length, 2);
  assert.ok(calls[1].url.endsWith("/api/user/ncarcasc"));
});

test("a closed account is gone, and a check that could not be made is not proof", async () => {
  await withStubbedFetch(
    (call) =>
      call.url.includes("/api/games/user/")
        ? new Response("", { status: 404 })
        : new Response('{"id":"ncarcasc","disabled":true}', { status: 200 }),
    async () => {
      await assert.rejects(
        () => fetchLichessPage({ username: "ncarcasc", since: null, limit: 100 }),
        (error: unknown) => error instanceof ProviderAccountMissing,
      );
    },
  );

  // The profile check itself failing says nothing about the account, so the
  // account keeps the benefit of the doubt and the failure stays retryable.
  await withStubbedFetch(
    (call) =>
      call.url.includes("/api/games/user/")
        ? new Response("", { status: 404 })
        : new Response("", { status: 503 }),
    async () => {
      await assert.rejects(
        () => fetchLichessPage({ username: "ncarcasc", since: null, limit: 100 }),
        (error: unknown) => error instanceof ProviderUnavailable,
      );
    },
  );
});

test("a rate limit keeps its status and the wait the provider asked for", async () => {
  await withStubbedFetch(
    () => new Response("", { status: 429, headers: { "retry-after": "60" } }),
    async () => {
      await assert.rejects(
        () => fetchLichessPage({ username: "ncarcasc", since: null, limit: 100 }),
        (error: unknown) => {
          assert.ok(error instanceof ProviderUnavailable);
          assert.equal(error.status, 429);
          assert.equal(error.retryAfter, 60);
          return true;
        },
      );
    },
  );
});

// ---------------------------------------------------------------------------
// What the ledger is told
// ---------------------------------------------------------------------------

test("a missing account is dead on the first attempt, a rate limit waits", async () => {
  const missing = syncWorkFailure(new ProviderAccountMissing("lichess"));
  assert.ok(missing instanceof WorkFailure);
  // Not `transient`: the account will still be missing on the fifth attempt.
  assert.equal(missing.retryClass, "invalid_input");
  assert.equal(missing.code, "provider_account_missing");

  const limited = syncWorkFailure(new ProviderUnavailable("lichess responded 429", 429, 90));
  assert.ok(limited instanceof WorkFailure);
  assert.equal(limited.retryClass, "rate_limit");
  assert.equal(limited.retryAfterSeconds, 90);

  const unsupported = syncWorkFailure(new UnsupportedProvider("chesscom"));
  assert.ok(unsupported instanceof WorkFailure);
  assert.equal(unsupported.retryClass, "unsupported");

  // Anything else keeps the executor's own reading of an unexpected failure.
  const surprise = new Error("boom");
  assert.equal(syncWorkFailure(surprise), surprise);

  // The sync run carries the same distinction for whoever reads the run rather
  // than the work item.
  assert.equal(syncFailureClass(new ProviderAccountMissing("lichess")), "account_missing");
  assert.equal(syncFailureClass(new UnsupportedProvider("chesscom")), "unsupported");
  assert.equal(syncFailureClass(surprise), "transient");
});
