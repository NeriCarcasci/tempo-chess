/**
 * The opening surface on `/v1`.
 *
 * Two calls, and they are deliberately different shapes because the endpoints
 * behind them are.
 *
 * `getOpeningExplorer` is a read. The whole graph arrives at once and walking a
 * line is pure client state, so stepping through a variation costs nothing.
 *
 * `evaluatePosition` is a **command**: it carries an idempotency key, it is
 * rate-limited per actor, and it can answer 202 with a workflow instead of a
 * number. That is why the explorer asks for an evaluation when somebody wants
 * one rather than on every keypress — an auto-fetch per board step would spend
 * the actor's budget walking a line and would queue work nobody asked for.
 */

import { v1, v1Data, newIdempotencyKey } from "./client";
import type { OpeningBook, OpeningExplorer, OpeningGraphV1 } from "./types";
import type { OpeningGraph } from "../openings";

export interface ExplorerQuery {
  provider?: "lichess" | "chesscom" | null;
  speed?: string | null;
  color?: "white" | "black" | null;
  since?: string | null;
  family?: string | null;
}

export function getOpeningExplorer(query: ExplorerQuery = {}): Promise<OpeningExplorer> {
  return v1Data<OpeningExplorer>("/v1/openings/explorer", {
    query: {
      provider: query.provider ?? undefined,
      speed: query.speed ?? undefined,
      color: query.color ?? undefined,
      since: query.since ?? undefined,
      family: query.family ?? undefined,
    },
  });
}

/**
 * The book at one position.
 *
 * A read, like the explorer, but the opposite shape: the explorer ships a whole
 * graph once because walking it is the interaction, and this ships one position
 * because studying it is. It is asked for when somebody has already decided
 * which position they care about, never on a keypress.
 *
 * `line` is the UCI moves that reached the position. Without it the response
 * still names the opening — from the catalogue's own representative line — but
 * it cannot say where the player left the book, and it says null rather than
 * "nowhere".
 */
export function getOpeningBook(query: {
  position: string;
  line?: readonly string[] | string | null;
}): Promise<OpeningBook> {
  const line = typeof query.line === "string" ? query.line : (query.line ?? []).join(" ");
  return v1Data<OpeningBook>("/v1/openings/book", {
    query: { position: query.position, line: line || undefined },
  });
}

/**
 * The v1 graph as something the walking helpers accept.
 *
 * `app/lib/openingGraph.ts` is typed against the legacy `OpeningGraph`, and the
 * two encodings are the same shape apart from the loss field: legacy carries
 * `al` in centipawns, v1 carries `dl` in expected score. Every field the
 * helpers actually read is present and identically named, so this is a widening
 * and not a conversion — nothing is renamed, defaulted or invented, which is
 * what keeps it honest. The cast is the whole adapter; if it ever needs a body,
 * the two encodings have diverged and that should be a visible change.
 */
export function walkable(graph: OpeningGraphV1): OpeningGraph {
  return graph as unknown as OpeningGraph;
}

/** What the engine said, or why it cannot say yet. */
export type PositionEvaluation =
  | {
      state: "ready";
      scoreCp: number | null;
      mateIn: number | null;
      bestMoveUci: string | null;
      candidates: Array<{ uci: string; expectedScore: number }>;
    }
  | { state: "queued"; workflowId: string | null };

interface EvaluationBody {
  state: string;
  workflowId: string | null;
  evaluation: {
    scoreCp: number | null;
    mateIn: number | null;
    bestMoveUci: string | null;
    candidates: Array<{ uci: string; expectedScore: number }>;
  } | null;
}

/**
 * Ask for one evaluation of one position.
 *
 * The key is derived from the position rather than generated, so pressing the
 * button twice on the same board is the same intent and does not queue a second
 * job. A different position is a different intent and gets its own key.
 */
export async function evaluatePosition(
  fen: string,
  options: { signal?: AbortSignal; idempotencyKey?: string } = {},
): Promise<PositionEvaluation> {
  const result = await v1<EvaluationBody>("/v1/positions/evaluations", {
    method: "POST",
    json: { fen, purpose: "exploration" },
    idempotencyKey: options.idempotencyKey ?? newIdempotencyKey(),
    signal: options.signal,
  });

  const body = result.data;
  if (body.state === "ready" && body.evaluation) {
    return {
      state: "ready",
      scoreCp: body.evaluation.scoreCp,
      mateIn: body.evaluation.mateIn,
      bestMoveUci: body.evaluation.bestMoveUci,
      candidates: body.evaluation.candidates ?? [],
    };
  }
  // 202, or a 200 whose evaluation member is absent. Either way there is no
  // number yet, and saying "queued" is the truth; a null score rendered as a
  // dash would read as "the engine looked and found nothing".
  return { state: "queued", workflowId: body.workflowId };
}

/**
 * Why there is no graph.
 *
 * Three genuinely different situations produce the same `graph: null`, and a
 * screen that renders one sentence for all three is telling two thirds of its
 * readers something false. Kept here rather than in the route so it can be
 * tested without a loader.
 *
 *   - `no_games`     nothing is connected, or nothing has synced.
 *   - `filtered_out` there are games, but not these ones.
 *   - `not_materialized` games synced and the position graph has not been built
 *     from them yet. Temporary, and the only one of the three that resolves on
 *     its own.
 */
export type ExplorerEmptyReason = "no_games" | "filtered_out" | "not_materialized";

export function explorerEmptyReason(explorer: {
  coverage: { games: number };
  filters: { color: string | null; speed: string | null; provider: string | null; family: string | null };
}): ExplorerEmptyReason {
  const filtered = Boolean(
    explorer.filters.color
      || explorer.filters.speed
      || explorer.filters.provider
      || explorer.filters.family,
  );
  if (explorer.coverage.games === 0) return filtered ? "filtered_out" : "no_games";
  // Games reached the join but produced no walkable move, which means their
  // occurrences are not there yet. Not an empty archive.
  return "not_materialized";
}

export interface EmptyCopy {
  title: string;
  detail: string;
}

export function explorerEmptyCopy(
  reason: ExplorerEmptyReason,
  games: number,
): EmptyCopy {
  switch (reason) {
    case "filtered_out":
      return {
        title: "No games match these filters",
        detail: "Widen the side or the time control and the graph will come back.",
      };
    case "no_games":
      return {
        title: "No games yet",
        detail:
          "Once an account is connected and a sync has run, the positions your games reached will appear here.",
      };
    case "not_materialized":
      return {
        title: "These games have not been broken into positions yet",
        detail: `${games} ${games === 1 ? "game is" : "games are"} synced. The position graph is built after a sync lands, so this fills in shortly.`,
      };
  }
}
