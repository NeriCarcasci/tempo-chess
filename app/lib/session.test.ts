import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Me } from "./v1/types";

/**
 * The session, tested where getting it wrong locks somebody out.
 *
 * Two of these are regressions with a history. `requireSession` used to gate
 * on `session.username`, which is the provider's display handle and is allowed
 * to be null — so a player with a perfectly good linked account was read as a
 * player who had linked nothing and sent to /welcome, which sends a live run
 * to /onboarding, which sends a written report to /report, which calls
 * `requireSession`. And the account list `/v1/me` returns includes
 * disconnected links, so pointing the product at one would aim every read at a
 * subject that no longer receives games.
 *
 * Supabase is stubbed with plain functions rather than spies: a spy keeps a
 * handle on every promise it returns, so a rejecting one is reported as an
 * unhandled rejection whatever the code under test does with it.
 */

let token: string | null = "access-token";
let signedOut = false;

vi.mock("./supabase", () => ({
  supabaseConfigured: true,
  getSupabase: () => ({
    auth: {
      getSession: async () => ({
        data:
          token === null
            ? { session: null }
            : {
                session: {
                  access_token: token,
                  user: { id: "auth-uid", email: "player@example.com" },
                },
              },
      }),
      signOut: async () => {
        signedOut = true;
      },
      signInWithPassword: async () => ({ error: { message: "not configured" } }),
    },
  }),
}));

const { getSession, requireSession, requireUser, invalidateSession, awaitingApproval } =
  await import("./session");

type WireAccount = Me["accounts"][number];

const account = (over: Partial<WireAccount> = {}): WireAccount => ({
  id: "acc-1",
  provider: "lichess",
  handle: "someone",
  connectionKind: "public_lookup",
  verificationStatus: "unverified",
  status: "active",
  providerHandleDiscoverable: true,
  createdAt: "2026-08-01T00:00:00.000Z",
  ...over,
});

const me = (accounts: WireAccount[]): Me => ({
  profileId: "profile-uuid",
  locale: null,
  timezone: null,
  personalSubject: { id: "subject-uuid", displayLabel: "My games", status: "active" },
  accounts,
});

/** The next `/v1/me` answer. */
function answering(body: Me, status = 200): void {
  vi.stubGlobal("fetch", async () =>
    new Response(JSON.stringify({ data: body, meta: { requestId: "req-1" } }), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

function failing(status: number): void {
  vi.stubGlobal("fetch", async () => new Response("{}", { status }));
}

/** A problem document, as `/v1/me` returns one. */
function refusing(status: number, code: string): void {
  vi.stubGlobal("fetch", async () =>
    new Response(JSON.stringify({ code, status, title: "no" }), {
      status,
      headers: { "content-type": "application/problem+json" },
    }),
  );
}

/** The redirect a guard threw, or null when it did not throw one. */
async function redirectFrom(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    if (!(error instanceof Response)) throw error;
    return error.headers.get("location");
  }
}

beforeEach(() => {
  token = "access-token";
  signedOut = false;
  invalidateSession();
  localStorage.clear();
});

describe("loadSession", () => {
  test("identity is the profile the server resolved, not the id the client holds", async () => {
    answering(me([account()]));
    const session = await getSession();
    expect(session?.userId).toBe("profile-uuid");
    expect(session?.subject?.id).toBe("subject-uuid");
    // The one field Supabase still owns: `/v1/me` publishes no email.
    expect(session?.email).toBe("player@example.com");
  });

  test("a disconnected account is not a choice the product can be pointed at", async () => {
    answering(me([account({ id: "gone", status: "disconnected" }), account({ id: "live" })]));
    const session = await getSession();
    expect(session?.accounts.map((a) => a.id)).toEqual(["live"]);
    expect(session?.activeAccount?.id).toBe("live");
  });

  test("an active account is preferred over a paused one", async () => {
    answering(me([account({ id: "paused", status: "paused" }), account({ id: "live" })]));
    const session = await getSession();
    expect(session?.activeAccount?.id).toBe("live");
  });

  test("a rejected token signs out rather than leaving a session that keeps failing", async () => {
    failing(401);
    await expect(getSession()).resolves.toBeNull();
    expect(signedOut).toBe(true);
  });

  test("no Supabase session is no session, and no request", async () => {
    token = null;
    failing(500); // would throw the wrong way if it were called at all
    await expect(getSession()).resolves.toBeNull();
  });
});

describe("requireSession", () => {
  test("a linked account with no handle is still a linked account", async () => {
    // The loop this closes: /welcome -> /onboarding -> /report -> /welcome.
    answering(me([account({ handle: null })]));
    expect(await redirectFrom(requireSession)).toBeNull();
    const session = await requireSession();
    expect(session.activeAccount?.id).toBe("acc-1");
    expect(session.username).toBe("");
  });

  test("nothing connected goes to /welcome", async () => {
    answering(me([]));
    expect(await redirectFrom(requireSession)).toBe("/welcome");
  });

  test("only a disconnected account goes to /welcome", async () => {
    answering(me([account({ status: "disconnected" })]));
    expect(await redirectFrom(requireSession)).toBe("/welcome");
  });

  test("no session at all goes to sign-in", async () => {
    token = null;
    expect(await redirectFrom(requireSession)).toBe("/login");
  });
});

/**
 * The closed beta gate, on the side that decides where somebody lands.
 *
 * The API is the gate and has already refused the request by the time any of
 * this runs. What is being tested is the loop: an unapproved account sent to
 * `/login` signs in successfully, gets refused again, and is sent back to
 * `/login`, forever. That shape of bug has shipped to a real person once on a
 * different redirect, which is why it is pinned here rather than trusted.
 */
describe("the closed beta gate", () => {
  test("an unapproved account is not signed out", async () => {
    refusing(403, "ACCESS_NOT_APPROVED");
    await expect(getSession()).resolves.toBeNull();
    // Signing them out would drop a session that is perfectly valid and leave
    // them with no way back to the screen that explains the wait.
    expect(signedOut).toBe(false);
    expect(awaitingApproval()).toBe(true);
  });

  test("the guards send them to the waiting screen, not to sign in again", async () => {
    refusing(403, "ACCESS_NOT_APPROVED");
    expect(await redirectFrom(requireSession)).toBe("/access");
    expect(await redirectFrom(requireUser)).toBe("/access");
  });

  test("a forbidden that is not the beta gate still means sign in", async () => {
    refusing(403, "FORBIDDEN");
    await expect(getSession()).resolves.toBeNull();
    expect(awaitingApproval()).toBe(false);
    expect(await redirectFrom(requireSession)).toBe("/login");
  });

  test("approval clears the flag rather than leaving it set", async () => {
    refusing(403, "ACCESS_NOT_APPROVED");
    await getSession();
    expect(awaitingApproval()).toBe(true);

    // The operator approved them; the next read succeeds. A flag that survived
    // would bounce an approved account off every product page.
    invalidateSession();
    answering(me([account()]));
    await expect(getSession()).resolves.not.toBeNull();
    expect(awaitingApproval()).toBe(false);
    expect(await redirectFrom(requireSession)).toBeNull();
  });
});
