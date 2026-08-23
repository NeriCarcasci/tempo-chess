/**
 * The opponent a player asked to play against.
 *
 * This is the "play it out" path, and it is deliberately not the analysis path.
 * `engine/interactive.ts` answers "how good is this position" and its answer is
 * a calibrated evaluation pinned to the promoted recipe; this file answers
 * "what do you play here" and its answer is a move and nothing else. The two
 * must never be confused, so the isolation is built into the types rather than
 * left to a convention:
 *
 *   * `OpponentReply` has no score, no mate distance, no WDL, no principal
 *     variation and no candidate list. Stockfish emits all of them on the way
 *     to `bestmove`; the adapter reads none of them off the wire, so there is
 *     no field for a caller to store in `analysis.*` even by mistake.
 *   * The search is a handicapped one — `UCI_LimitStrength` at a requested
 *     rating, a few hundred milliseconds — so it is not `ENGINE_PROFILES`, not
 *     tied to an `engine_version_id` or a `calibration_version_id`, and has
 *     nothing an evaluation row could be keyed to.
 *   * Nothing here reads or writes the database. A played game is not evidence
 *     about a position, and the surest way to keep it from becoming evidence is
 *     for it never to become a row.
 *
 * Maia-3 is served by the durable continuation workflow on the private
 * `forma-maia` deployment, not by an in-process adapter here. The play route
 * branches to that workflow before synchronous adapter selection. What must
 * never happen is a Stockfish move returned under Maia's name: a request for a
 * family we cannot serve is refused, never substituted.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Chess } from "chessops/chess";
import { makeFen, parseFen } from "chessops/fen";
import { makeSan } from "chessops/san";
import { makeUci, parseUci } from "chessops/util";
import { CONTINUATION_RATINGS } from "../models/continuation-rating.js";
import { resolveDeployment, hasCapability } from "../platform/deployment.js";

export const OPPONENT_FAMILIES = ["stockfish", "maia"] as const;
export type OpponentFamily = (typeof OPPONENT_FAMILIES)[number];

/**
 * How long the opponent may think, and how long before we give up on it.
 *
 * Constants rather than request fields, for the same reason API contract §14
 * refuses "arbitrary depth/threads/MultiPV parameters" on the evaluation route:
 * a field that can carry a search budget is a field that can be used to buy
 * unbounded engine time from a signed-in account. The budget matches the
 * prototype's default, which is what the current bot feels like to play.
 */
export const MOVE_BUDGET_MS = 350;
const ENGINE_GRACE_MS = 5_000;

/** A game long enough for any real one, and short enough to replay for free. */
export const MOVE_HISTORY_LIMIT = 300;

// ---------------------------------------------------------------------------
// The level catalogue
// ---------------------------------------------------------------------------

/**
 * The strengths a player may ask for.
 *
 * A server catalogue rather than a number on the request, per API contract §14
 * ("level/profile is server catalogue"). Two things follow from that which a
 * raw Elo field could not give us. A client cannot ask for a strength no engine
 * family can honour, and the catalogue can say — per family — what a level
 * actually plays at, which is the honest form of a claim the prototype made
 * silently and wrongly.
 */
export interface PlayLevel {
  /** Stable across releases: it is what a client stores as the user's choice. */
  readonly key: string;
  /** The rating the level claims. Not necessarily one any family can reach. */
  readonly nominalRating: number;
}

export const PLAY_LEVELS: readonly PlayLevel[] = [
  { key: "800", nominalRating: 800 },
  { key: "1000", nominalRating: 1000 },
  { key: "1200", nominalRating: 1200 },
  { key: "1400", nominalRating: 1400 },
  { key: "1600", nominalRating: 1600 },
  { key: "1800", nominalRating: 1800 },
  { key: "2000", nominalRating: 2000 },
  { key: "2200", nominalRating: 2200 },
  { key: "2400", nominalRating: 2400 },
] as const;

export const PLAY_LEVEL_KEYS = PLAY_LEVELS.map((level) => level.key) as [string, ...string[]];

export function levelByKey(key: string): PlayLevel | null {
  return PLAY_LEVELS.find((level) => level.key === key) ?? null;
}

/**
 * What one family does with one level.
 *
 * `clamped` exists because the prototype lied here. Stockfish's `UCI_Elo` stops
 * at 1320, so its "800 Elo bot" was a 1320 Elo bot with an 800 label, and a
 * player losing to it drew the wrong conclusion about their own rating. Saying
 * `playsAt: 1320, clamped: true` costs one boolean and stops the screen making
 * a claim the engine cannot support.
 */
export interface FamilyLevel extends PlayLevel {
  readonly playsAt: number;
  readonly clamped: boolean;
}

function clampToRange(level: PlayLevel, floor: number, ceiling: number): FamilyLevel {
  const playsAt = Math.min(ceiling, Math.max(floor, level.nominalRating));
  return { ...level, playsAt, clamped: playsAt !== level.nominalRating };
}

// ---------------------------------------------------------------------------
// The adapter contract
// ---------------------------------------------------------------------------

/** Why a family cannot answer here. Both are configuration, not user error. */
export type OpponentUnavailable =
  | { readonly reason: "not_configured"; readonly detail: string }
  | { readonly reason: "not_permitted_here"; readonly detail: string };

export interface OpponentRequest {
  /** A legal standard position. Validated by `resolveGame`, never by a client. */
  readonly rootFen: string;
  /**
   * UCI moves from `rootFen` to the position being answered, already verified
   * legal. They are replayed into the engine rather than collapsed into a FEN
   * so repetition and the fifty-move rule are facts it can see; a bare
   * `position fen` erases both and the bot walks into draws it could avoid.
   */
  readonly moves: readonly string[];
  readonly level: PlayLevel;
  readonly budgetMs: number;
}

/**
 * One move, and what produced it.
 *
 * There is no evaluation field and there must never be one. This type is the
 * boundary that keeps a play move from being read as an analysis claim, and a
 * boundary that is enforced by the compiler survives people who have not read
 * this comment.
 */
export interface OpponentReply {
  readonly uci: string;
  /** Read from the running engine's handshake, not from configuration. */
  readonly engine: string;
  readonly playsAt: number;
  readonly clamped: boolean;
}

export interface OpponentAdapter {
  readonly family: OpponentFamily;
  /** What this family does with each catalogue level. */
  levelFor(level: PlayLevel): FamilyLevel;
  /** Null when this family can answer in this process, a reason when it cannot. */
  unavailable(): OpponentUnavailable | null;
  reply(request: OpponentRequest): Promise<OpponentReply>;
}

/** The engine did not produce a usable move. Never a caller's fault. */
export class OpponentEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpponentEngineError";
  }
}

// ---------------------------------------------------------------------------
// Position validation
// ---------------------------------------------------------------------------

export type GameStatus =
  | "in_play"
  | "checkmate"
  | "stalemate"
  | "insufficient_material"
  | "fifty_move";

export type GameRejection =
  | { readonly field: "fen"; readonly detail: string }
  | { readonly field: "moves"; readonly detail: string };

export interface ResolvedGame {
  /**
   * The position the moves start from, re-emitted by chessops rather than
   * echoed. What reaches the engine's `position fen` line is then a string this
   * server produced from a setup it validated, not the bytes a client sent.
   */
  readonly rootFen: string;
  /** The position to be answered, canonicalized the same way. */
  readonly fen: string;
  readonly turn: "white" | "black";
  readonly status: GameStatus;
  readonly position: Chess;
}

/**
 * Whether the position after `moves` is over on its own terms.
 *
 * Threefold repetition is deliberately absent. It is a property of a game's
 * history rather than of a position, and this server keeps no game — so
 * claiming it would mean trusting the move list a client happened to send as if
 * it were the whole history, which it need not be. The client, which does hold
 * the game, is the honest place for that call. The engine still sees the moves
 * that were supplied, so it plays as if repetition matters even though the
 * server will not declare it.
 */
function statusOf(position: Chess): GameStatus {
  if (position.isCheckmate()) return "checkmate";
  if (position.isStalemate()) return "stalemate";
  if (position.isInsufficientMaterial()) return "insufficient_material";
  if (position.halfmoves >= 100) return "fifty_move";
  return "in_play";
}

/**
 * Turn what a client says the game is into a position the server believes.
 *
 * Every claim is re-derived: the FEN is parsed and checked for legality, and
 * each move is checked against the position it is played into rather than
 * assumed. A client that sends an illegal position, a move that is not legal,
 * or a move list longer than any real game gets a validation failure naming the
 * field, and the engine is never started.
 *
 * `Chess.fromSetup` is what makes this standard chess only. A variant setup is
 * refused here rather than handed to an engine that would answer confidently
 * about a game nobody asked about.
 */
export function resolveGame(
  fen: string,
  moves: readonly string[],
): { ok: true; game: ResolvedGame } | { ok: false; rejection: GameRejection } {
  const setup = parseFen(fen.trim());
  if (setup.isErr) {
    return { ok: false, rejection: { field: "fen", detail: "that is not a readable FEN" } };
  }
  const parsed = Chess.fromSetup(setup.value);
  if (parsed.isErr) {
    return {
      ok: false,
      rejection: { field: "fen", detail: "that is not a legal standard chess position" },
    };
  }
  if (moves.length > MOVE_HISTORY_LIMIT) {
    return {
      ok: false,
      rejection: { field: "moves", detail: `at most ${MOVE_HISTORY_LIMIT} moves may be replayed` },
    };
  }

  const position = parsed.value;
  const rootFen = makeFen(position.toSetup());
  for (const [index, uci] of moves.entries()) {
    const move = parseUci(uci);
    // Legality is checked before the move is played, and a move played into a
    // finished game is refused too: an engine asked to answer a position after
    // checkmate would answer something, and it would be nonsense.
    if (!move || !position.isLegal(move) || position.isEnd()) {
      return {
        ok: false,
        rejection: { field: "moves", detail: `move ${index + 1} is not legal in this game` },
      };
    }
    position.play(move);
  }

  return {
    ok: true,
    game: {
      rootFen,
      fen: makeFen(position.toSetup()),
      turn: position.turn,
      status: statusOf(position),
      position,
    },
  };
}

/** A reply the engine produced, checked against the board before it is served. */
export function describeReply(
  position: Chess,
  uci: string,
): { ok: true; uci: string; san: string; fen: string; status: GameStatus } | { ok: false } {
  const move = parseUci(uci);
  if (!move || !position.isLegal(move)) return { ok: false };
  const after = position.clone();
  const san = makeSan(after, move);
  after.play(move);
  return {
    ok: true,
    uci: makeUci(move),
    san,
    fen: makeFen(after.toSetup()),
    status: statusOf(after),
  };
}

// ---------------------------------------------------------------------------
// The Stockfish adapter
// ---------------------------------------------------------------------------

/**
 * Stockfish's own `UCI_Elo` range. Below 1320 it will not go, whatever the
 * catalogue says, which is why `FamilyLevel.clamped` exists.
 */
export const STOCKFISH_ELO_FLOOR = 1320;
export const STOCKFISH_ELO_CEILING = 3190;

export interface StockfishOpponentOptions {
  command: string;
  /** Test seam: the fixture engine is `node <fixture.cjs>`. */
  args?: readonly string[];
  /** Injected so a test can describe a deployment it is not running as. */
  env?: NodeJS.ProcessEnv;
}

export function stockfishOpponent(options: StockfishOpponentOptions): OpponentAdapter {
  const env = options.env ?? process.env;
  return {
    family: "stockfish",
    levelFor: (level) => clampToRange(level, STOCKFISH_ELO_FLOOR, STOCKFISH_ELO_CEILING),
    unavailable: () => engineCapability(env),
    async reply(request) {
      const level = clampToRange(request.level, STOCKFISH_ELO_FLOOR, STOCKFISH_ELO_CEILING);
      const answer = await askStockfish(options.command, options.args ?? [], request, level.playsAt);
      return { uci: answer.uci, engine: answer.engine, playsAt: level.playsAt, clamped: level.clamped };
    },
  };
}

/**
 * The one deployment that may run an engine in process without saying so.
 *
 * Any other deployment must set this to `true` to spawn one, and the variable
 * exists rather than an implicit allowance because of what it costs. Read
 * `engineCapability` before setting it.
 */
export const IN_PROCESS_ENGINE_ENV = "FORMA_PLAY_ENGINE_INPROCESS";

/**
 * Whether this process is allowed to run an engine at all.
 *
 * E05 gives exactly one deployment `engine_analysis`, and the topology comment
 * is explicit that the rule holds "by the process refusing the work rather than
 * by nobody having written the call". This is that refusal. Outside Cloud Run
 * there is no deployment to be, so a local process and the test suite run the
 * engine in process, which is how the prototype has always worked.
 *
 * A deployment that does not hold the capability is refused unless it sets
 * `FORMA_PLAY_ENGINE_INPROCESS=true`. The override is here because the honest
 * alternative today is shipping nothing. `forma-stockfish` is sized for batch
 * analysis — one request per instance, a fifteen-minute timeout — and a play
 * move is the opposite shape, so routing play there would either starve the
 * game behind a running analysis or starve the analysis; and there is no
 * synchronous channel from the API to a private deployment to route it through
 * anyway, only the work ledger, whose outbox is on a one-minute schedule. So
 * the choice is between running the engine in the public service and not having
 * the feature, and that is a call for whoever owns the deployment rather than
 * one to bury in a module.
 *
 * What setting it means, stated so nobody has to reconstruct it: the public
 * autoscaler spawns a Stockfish process per bot move, on one CPU, at a
 * container concurrency of forty. It is bounded by `MOVE_BUDGET_MS`, by
 * `Threads 1`, and by the per-actor rate limit, and it is still engine work
 * inside the service E05 split it out of. It should come back out when there is
 * somewhere for it to go.
 */
function engineCapability(env: NodeJS.ProcessEnv): OpponentUnavailable | null {
  const refusal = {
    reason: "not_permitted_here",
    detail: "this service is not configured to run an engine",
  } as const;
  try {
    const deployment = resolveDeployment(env);
    if (!deployment || hasCapability(deployment, "engine_analysis")) return null;
    return env[IN_PROCESS_ENGINE_ENV] === "true" ? null : refusal;
  } catch {
    // A process that cannot say which deployment it is has no business running
    // an engine, and no override applies: the override is a statement about a
    // known deployment, not a way to skip declaring one.
    return refusal;
  }
}

interface StockfishAnswer {
  uci: string;
  engine: string;
}

/**
 * One move out of one throwaway Stockfish process.
 *
 * A process per move rather than a pool: a play move is rare compared with
 * analysis, and a fresh process cannot carry a hash table from one player's
 * game into another's. `Threads 1` and a small hash for the same reason the
 * budget is short — a bot move must not be able to take the machine.
 *
 * Only `bestmove` is read. The `info` lines carrying `score`, `wdl` and the
 * principal variation stream past and are dropped on purpose; see the header.
 */
function askStockfish(
  command: string,
  args: readonly string[],
  request: OpponentRequest,
  elo: number,
): Promise<StockfishAnswer> {
  return new Promise<StockfishAnswer>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      reject(new OpponentEngineError("the engine could not be started"));
      return;
    }

    let settled = false;
    let buffer = "";
    let engine = "Stockfish";
    child.stdout.setEncoding("utf8");
    // Stockfish writes little to stderr, but a pipe nobody reads fills and
    // stalls the process it belongs to.
    child.stderr.resume();

    const finish = (error: Error | null, answer?: StockfishAnswer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.stdin.write("quit\n");
      } catch {
        /* the process is already gone */
      }
      child.kill();
      if (error) reject(error);
      else resolve(answer!);
    };

    const timer = setTimeout(
      () => finish(new OpponentEngineError("the engine did not answer in time")),
      request.budgetMs + ENGINE_GRACE_MS,
    );
    timer.unref();

    child.on("error", () => finish(new OpponentEngineError("the engine could not be started")));
    child.on("exit", () => finish(new OpponentEngineError("the engine stopped before answering")));

    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);

        if (line.startsWith("id name ")) engine = line.slice(8).trim();
        if (line === "uciok") {
          child.stdin.write("setoption name Threads value 1\n");
          child.stdin.write("setoption name Hash value 16\n");
          child.stdin.write("setoption name UCI_LimitStrength value true\n");
          child.stdin.write(`setoption name UCI_Elo value ${elo}\n`);
          child.stdin.write("isready\n");
          continue;
        }
        if (line === "readyok") {
          const moves = request.moves.length > 0 ? ` moves ${request.moves.join(" ")}` : "";
          child.stdin.write(`position fen ${request.rootFen}${moves}\n`);
          child.stdin.write(`go movetime ${request.budgetMs}\n`);
          continue;
        }
        if (line.startsWith("bestmove")) {
          const uci = line.split(/\s+/)[1];
          if (!uci || uci === "(none)") {
            finish(new OpponentEngineError("the engine reported no move for the position"));
            return;
          }
          finish(null, { uci, engine });
          return;
        }
      }
    });

    child.stdin.write("uci\n");
  });
}

// ---------------------------------------------------------------------------
// The Maia-3 family
// ---------------------------------------------------------------------------

/**
 * Maia-3 is exposed at the same closed strengths as the continuation contract.
 * Keeping one source of truth means the catalogue cannot offer a level the
 * worker will later reject.
 */
export const MAIA3_LEVELS = CONTINUATION_RATINGS;

/**
 * Maia-3 conditions directly on the selected level. There is no legacy
 * nearest-network clamp: the private service carries one Maia-3 checkpoint and
 * receives the requested rating as model context.
 */
export function maia3Level(level: PlayLevel): FamilyLevel {
  return { ...level, playsAt: level.nominalRating, clamped: false };
}

/**
 * Maia has no synchronous in-process adapter. This explicit refusal protects a
 * future caller from accidentally bypassing the private Maia-3 workflow.
 */
export type OpponentSelection =
  | { readonly ok: true; readonly adapter: OpponentAdapter }
  | { readonly ok: false; readonly family: OpponentFamily; readonly unavailable: OpponentUnavailable };

function adapterFor(family: OpponentFamily, env: NodeJS.ProcessEnv): OpponentAdapter {
  if (family === "maia") {
    throw new OpponentEngineError("Maia-3 must be served by the continuation workflow");
  }
  return stockfishOpponent({ command: env.STOCKFISH_PATH || "stockfish", env });
}

/**
 * The family the player asked for, or the reason it cannot answer.
 *
 * There is no fallback and no "best available" branch. A caller that asked for
 * Maia and got Stockfish would have been told a specific untruth — that this is
 * the move a human of that strength plays — and no amount of labelling
 * downstream can undo a move that was chosen by the wrong model.
 */
export function selectOpponent(
  family: OpponentFamily,
  env: NodeJS.ProcessEnv = process.env,
): OpponentSelection {
  if (family === "maia") {
    return {
      ok: false,
      family,
      unavailable: {
        reason: "not_permitted_here",
        detail: "Maia-3 must be requested through the private continuation service",
      },
    };
  }
  const adapter = adapterFor(family, env);
  const unavailable = adapter.unavailable();
  return unavailable ? { ok: false, family, unavailable } : { ok: true, adapter };
}

export interface CatalogueFamily {
  readonly family: OpponentFamily;
  readonly available: boolean;
  readonly unavailableReason: OpponentUnavailable["reason"] | null;
  readonly levels: readonly FamilyLevel[];
}

/**
 * Every family and what it would do with every level.
 *
 * Served so a screen renders the opponents that exist rather than a hard-coded
 * list that goes stale the day one is added or withdrawn. It is a pure function
 * of configuration: no query, nothing to cache beyond the process.
 */
export function opponentCatalogue(
  env: NodeJS.ProcessEnv = process.env,
  maiaAvailable = false,
): readonly CatalogueFamily[] {
  return OPPONENT_FAMILIES.map((family) => {
    if (family === "maia") {
      return {
        family,
        available: maiaAvailable,
        unavailableReason: maiaAvailable ? null : "not_configured",
        levels: PLAY_LEVELS.map(maia3Level),
      };
    }
    const adapter = adapterFor(family, env);
    const unavailable = adapter.unavailable();
    return {
      family,
      available: unavailable === null,
      unavailableReason: unavailable?.reason ?? null,
      levels: PLAY_LEVELS.map((level) => adapter.levelFor(level)),
    };
  });
}
