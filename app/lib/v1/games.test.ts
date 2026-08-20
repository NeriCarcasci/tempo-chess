import { describe, expect, test, vi } from "vitest";

/**
 * The adapter for a route that does not exist yet.
 *
 * Every test here is the same worry from a different side: this module is the
 * only thing standing between a screen full of chess and a screen that throws,
 * and it is reading a shape nobody has shipped. So it is pinned on what it does
 * when the route is missing, when the body is not what was agreed, and when a
 * game in an otherwise fine list is unusable.
 *
 * The client is stubbed with a plain function rather than a `vi.fn()`: a spy
 * keeps a handle on every promise it returns, so a test that makes one reject
 * is reported as an unhandled rejection whatever the code under test does with
 * it. Nothing here needs to assert on the call, so nothing here needs a spy.
 */

let answer: () => Promise<unknown> = async () => null;
vi.mock("./client", () => ({ v1Maybe: () => answer() }));

const { fetchRecentGames } = await import("./games");

const wire = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "g1",
  opponent: "someone",
  colour: "white",
  speed: "blitz",
  result: "win",
  playedAt: "2026-08-01T00:00:00Z",
  initialFen: null,
  moves: [{ uci: "e2e4", san: "e4" }, { uci: "e7e5" }],
  ...over,
});

const answering = (value: unknown): void => {
  answer = async () => value;
};

describe("fetchRecentGames", () => {
  test("a missing route is an empty list, never a throw", async () => {
    // `v1Maybe` answers null for a 404 and for anything else that failed.
    answering(null);
    await expect(fetchRecentGames(4)).resolves.toEqual([]);
  });

  test("a thrown redirect does not escape into an effect that cannot catch it", async () => {
    // `v1Maybe` swallows a `ProblemError` but deliberately rethrows the
    // redirect a 401 produces, and this is called from an effect where a thrown
    // `Response` reaches nothing that can act on it.
    answer = async () => {
      throw new Response(null, { status: 302 });
    };
    await expect(fetchRecentGames(4)).resolves.toEqual([]);
  });

  test("a body of the wrong shape is an empty list", async () => {
    answering({ nothing: "expected" });
    await expect(fetchRecentGames(4)).resolves.toEqual([]);
  });

  test("the agreed shape reads through", async () => {
    answering([wire()]);
    const games = await fetchRecentGames(4);
    expect(games).toHaveLength(1);
    expect(games[0]!.colour).toBe("white");
    expect(games[0]!.moves.map((move) => move.uci)).toEqual(["e2e4", "e7e5"]);
    expect(games[0]!.moves[0]!.san).toBe("e4");
  });

  test("a collection wrapped in an object reads through as well", async () => {
    answering({ games: [wire()] });
    await expect(fetchRecentGames(4)).resolves.toHaveLength(1);
  });

  test("either spelling of colour is understood", async () => {
    answering([wire({ colour: undefined, color: "black" })]);
    const games = await fetchRecentGames(4);
    expect(games[0]!.colour).toBe("black");
  });

  test("a colour nobody agreed on is null rather than a guess", async () => {
    // Null draws the board from White's side. Guessing would draw somebody's
    // own game from the wrong seat, which is worse than a default.
    answering([wire({ colour: "w" })]);
    const games = await fetchRecentGames(4);
    expect(games[0]!.colour).toBeNull();
  });

  test("an unusable game is dropped, and the rest of the list survives", async () => {
    answering([
      wire({ id: undefined }),
      wire({ moves: [] }),
      wire({ moves: ["not a move", { uci: "castle" }] }),
      wire({ id: "kept" }),
    ]);
    const games = await fetchRecentGames(4);
    expect(games.map((game) => game.id)).toEqual(["kept"]);
  });

  test("moves sent as bare strings are still moves", async () => {
    answering([wire({ moves: ["e2e4", "e7e5", "g1f3"] })]);
    const games = await fetchRecentGames(4);
    expect(games[0]!.moves.map((move) => move.uci)).toEqual(["e2e4", "e7e5", "g1f3"]);
  });
});
