/**
 * Provider payloads, as the canonical sync wants them.
 *
 * E08 built the atomic checkpoint commit and the normalizer that decides what
 * may become a canonical game. What it never had was the thing in front: an
 * adapter that talks to a provider and yields `ProviderGameInput`. Without one,
 * `commitBatch` had no caller and no user's games ever reached the canonical
 * tables through the product — only through the operator's backfill.
 *
 * This is that adapter, and it is deliberately thin. Fetching is a generator so
 * a page can be committed and checkpointed before the next one is asked for: a
 * sync that dies halfway through a large archive resumes from a cursor that is
 * true rather than starting again.
 *
 * The fetch itself is injectable. Every gate in this repo runs against a real
 * database and no real provider, which is the only arrangement where "did the
 * cursor advance correctly" is a question a test can answer.
 */

import { Chess } from "chessops/chess";
import { parseFen, INITIAL_FEN } from "chessops/fen";
import { parseSan } from "chessops/san";
import { makeUci } from "chessops/util";
import type { ProviderGameInput } from "./contract.js";

/**
 * Where the Lichess adapter fetches from.
 *
 * Read per call, not captured at module load. It was a `const`, which meant the
 * override only applied if this module happened to be imported after the
 * variable was set — and the journey gate sets it after its own static imports
 * have already pulled this file in. So a gate written to serve its own NDJSON
 * over loopback was calling the public API instead, getting nothing back for a
 * username that only exists in its fixture, and failing every run on an empty
 * sync. A function has no load order to get wrong.
 */
export function lichessApi(): string {
  return process.env.LICHESS_API_URL ?? "https://lichess.org";
}

/**
 * How Forma identifies itself to a provider.
 *
 * Lichess asks every client for a User-Agent it can contact, and throttles the
 * ones that send none far harder than the ones that do. This adapter sent none,
 * so syncing an archive of a few hundred games spent its attempts on 429s
 * instead of on games. Overridable so a deployment can put its own contact
 * address on the wire rather than this repository's.
 */
export const SYNC_USER_AGENT =
  process.env.SYNC_USER_AGENT ?? "forma-sync/1.0 (+https://formachess.com)";

/** A page as the provider returned it, with the cursor that page ended at. */
export interface ProviderPage {
  games: readonly ProviderGameInput[];
  /**
   * How many records the provider sent, counted before any were dropped.
   *
   * The walk ends when a page has nothing on it, and this is the number that
   * says so. `games.length` cannot: a record this adapter cannot map is missing
   * from `games` but the provider did send it, and a page of nothing but such
   * records would look like the end of the archive while the archive carried
   * on. The distinction is between "there is no more" and "there was nothing
   * here we could read", and only the first one is a reason to stop.
   */
  received: number;
  /**
   * The cursor to resume from *after* this page committed.
   *
   * For Lichess this is the millisecond timestamp of the newest game seen, so
   * the next run asks for games created strictly after it. Null means the
   * provider had nothing to give and the cursor should not move.
   */
  cursorAfter: string | null;
}

export type ProviderFetch = (input: {
  username: string;
  /** The stored cursor, or null on a first sync. */
  since: string | null;
  /** A page bound, so one work item does not swallow an entire archive. */
  limit: number;
}) => Promise<ProviderPage>;

// ---------------------------------------------------------------------------
// Lichess
// ---------------------------------------------------------------------------

interface LichessPlayer {
  user?: { name?: string; title?: string; id?: string };
  rating?: number;
  ratingDiff?: number;
  provisional?: boolean;
  aiLevel?: number;
}

interface LichessGame {
  id?: string;
  rated?: boolean;
  variant?: string;
  speed?: string;
  perf?: string;
  createdAt?: number;
  lastMoveAt?: number;
  status?: string;
  winner?: "white" | "black";
  moves?: string;
  clocks?: number[];
  initialFen?: string;
  clock?: { initial?: number; increment?: number };
  players?: { white?: LichessPlayer; black?: LichessPlayer };
}

/**
 * One Lichess game payload, mapped to the provider-neutral input.
 *
 * `winner` carries three meanings and they are all different: white, black, or
 * — when the game finished with no winner — a draw. `undefined` is reserved for
 * a game that has not finished, and the normalizer rejects those. Lichess omits
 * the field for both a draw and an unfinished game, so the status decides which
 * it is; getting this wrong would either drop every draw or admit games still
 * being played.
 */
/**
 * Replay a SAN line into `{ uci, san }` pairs, or refuse it.
 *
 * `chessops` is the same library the materializer uses, so a line that parses
 * here is one that will replay there — which is the property that matters, and
 * the one that was missing.
 */
function sanToMoves(
  sanLine: string,
  initialFen: string | null,
  clocks: readonly number[] | undefined,
): { uci: string; san: string; clockMs: number | null }[] | null {
  const trimmed = sanLine.trim();
  const tokens = trimmed.length > 0 ? trimmed.split(/\s+/) : [];
  const setup = parseFen(initialFen ?? INITIAL_FEN);
  if (setup.isErr) return null;
  const position = Chess.fromSetup(setup.unwrap());
  if (position.isErr) return null;
  const board = position.unwrap();

  const moves: { uci: string; san: string; clockMs: number | null }[] = [];
  for (const [index, san] of tokens.entries()) {
    const move = parseSan(board, san);
    if (!move) return null;
    moves.push({
      uci: makeUci(move),
      san,
      // Lichess reports clocks in centiseconds, one entry per ply.
      clockMs: clocks?.[index] !== undefined ? clocks[index]! * 10 : null,
    });
    board.play(move);
  }
  return moves;
}

export function lichessGameInput(game: LichessGame): ProviderGameInput | null {
  if (!game.id || typeof game.moves !== "string" || game.createdAt === undefined) return null;
  const finished = game.status !== undefined && game.status !== "started" && game.status !== "created";
  const winner = game.winner ?? (finished ? null : undefined);

  // Lichess returns SAN in `moves`, not UCI. There is no flag on this endpoint
  // that changes that, so the conversion has to happen here -- and it was not
  // happening: the SAN was stored in the `uci` field and `san` was left null,
  // which every replay downstream then failed to parse at ply 1. Nothing that
  // reads a game could read one, and the failure surfaced as `unparsable_move`
  // rather than as "the provider adapter wrote the wrong field".
  //
  // Replaying is also the only way to be sure: SAN is only meaningful relative
  // to the position before it, so a game whose moves do not make a legal line
  // is not a game we can store. Returning null rejects it, which the sync
  // already counts and reports.
  const moves = sanToMoves(game.moves, game.initialFen ?? null, game.clocks);
  if (moves === null) return null;

  const participant = (player: LichessPlayer | undefined) => ({
    username: player?.user?.name ?? null,
    title: player?.user?.title ?? null,
    rating: player?.rating ?? null,
    ratingChange: player?.ratingDiff ?? null,
    isBot: player?.aiLevel !== undefined ? true : (player?.user?.title === "BOT" ? true : null),
    isProvisional: player?.provisional ?? null,
  });

  return {
    providerGameId: game.id,
    variant: game.variant ?? null,
    status: game.status ?? null,
    winner,
    moves,
    playedAt: new Date(game.createdAt),
    completedAt: game.lastMoveAt !== undefined ? new Date(game.lastMoveAt) : null,
    rated: game.rated ?? null,
    speed: game.speed ?? game.perf ?? null,
    timeControl:
      game.clock?.initial !== undefined
        ? `${game.clock.initial}+${game.clock.increment ?? 0}`
        : null,
    termination: game.status ?? null,
    initialFen: game.initialFen ?? null,
    url: `https://lichess.org/${game.id}`,
    white: participant(game.players?.white),
    black: participant(game.players?.black),
  };
}

/**
 * Read one page of a Lichess archive.
 *
 * `sort=dateAsc` and a `since` cursor, so pages walk *forwards* through history
 * and a cursor that advanced is a cursor that will not re-read what it already has.
 * The newest-first order the legacy importer uses is right for "show me the
 * last twenty games" and wrong for a resumable sync: with it, every page after
 * a crash starts at the top again.
 */
export const fetchLichessPage: ProviderFetch = async ({ username, since, limit }) => {
  const params = new URLSearchParams({
    max: String(limit),
    sort: "dateAsc",
    moves: "true",
    clocks: "true",
    opening: "false",
    evals: "false",
  });
  if (since) params.set("since", String(Number(since) + 1));

  const response = await fetch(
    `${lichessApi()}/api/games/user/${encodeURIComponent(username)}?${params}`,
    { headers: { Accept: "application/x-ndjson", "User-Agent": SYNC_USER_AGENT } },
  );
  // A 404 is never "you have no games" — an account with none answers 200 with
  // an empty body — so it must never come back as an empty page. Nor is it
  // reliably "no such account": Lichess also answers 404 to a client it has
  // decided to throttle, and that is what quietly ended one account's sync two
  // pages into a four-page archive. Asking for the profile separates the two,
  // and a check that cannot be completed reads as "the account is still there",
  // because permanently failing a working link on a provider's bad day is the
  // more expensive mistake.
  if (response.status === 404) {
    throw (await lichessAccountExists(username))
      ? new ProviderUnavailable("lichess responded 404 for an account it still has", 404)
      : new ProviderAccountMissing("lichess");
  }
  if (!response.ok) {
    // Sanitized: the class the work ledger understands, never a provider body.
    throw new ProviderUnavailable(
      `lichess responded ${response.status}`,
      response.status,
      retryAfterSeconds(response),
    );
  }

  const body = await response.text();
  const games: ProviderGameInput[] = [];
  let received = 0;
  let newest: number | null = since ? Number(since) : null;
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Counted here, before anything can reject it, so that "the provider sent
    // nothing" stays distinguishable from "we could not read what it sent".
    received += 1;
    let payload: LichessGame;
    try {
      payload = JSON.parse(trimmed) as LichessGame;
    } catch {
      continue;
    }
    const input = lichessGameInput(payload);
    if (input) games.push(input);
    if (payload.createdAt !== undefined && (newest === null || payload.createdAt > newest)) {
      newest = payload.createdAt;
    }
  }
  return { games, received, cursorAfter: newest === null ? null : String(newest) };
};

/**
 * Does Lichess still have this account?
 *
 * Asked only when the games export answered 404, to decide which of two very
 * different things that 404 meant. A closed account counts as gone: its games
 * are not coming back either, and the linked account needs a person.
 */
async function lichessAccountExists(username: string): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch(`${lichessApi()}/api/user/${encodeURIComponent(username)}`, {
      headers: { Accept: "application/json", "User-Agent": SYNC_USER_AGENT },
    });
  } catch {
    return true;
  }
  if (response.status === 404) return false;
  if (!response.ok) return true;
  const profile = (await response.json().catch(() => null)) as { disabled?: boolean } | null;
  return profile?.disabled !== true;
}

/** A provider's own `Retry-After`, in seconds, when it sent a usable one. */
function retryAfterSeconds(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header.trim());
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

export class ProviderUnavailable extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfter: number | null = null,
  ) {
    super(message);
    this.name = "ProviderUnavailable";
  }
}

/**
 * The provider has no account under the username we hold.
 *
 * Its own class because the alternative was the worst outcome available. The
 * adapter used to turn every 404 into an empty page, so a throttled request in
 * the middle of an archive ended the walk, the run was marked succeeded, and
 * one account settled at 200 games of the 337 Lichess had — with a cursor
 * recording that as the whole of it. Nobody goes looking for a failure that did
 * not fail. A username that is genuinely gone lands here instead, which is
 * right: it needs a person to relink it, not another attempt.
 */
export class ProviderAccountMissing extends Error {
  constructor(readonly providerSlug: string) {
    super(`${providerSlug} has no account under that username`);
    this.name = "ProviderAccountMissing";
  }
}

/**
 * The adapters this deployment has.
 *
 * Chess.com is deliberately absent rather than half-written. Its archives are a
 * different shape — a month at a time, with HTTP cache validators — and an
 * adapter that pretended to sync it would produce a subject whose coverage says
 * "sufficient" over half a player's games. A missing provider is an honest
 * failure with a class an operator can see.
 */
export const PROVIDER_FETCHERS: Readonly<Record<string, ProviderFetch>> = Object.freeze({
  lichess: fetchLichessPage,
});

export function fetcherFor(providerSlug: string): ProviderFetch | null {
  return PROVIDER_FETCHERS[providerSlug] ?? null;
}
