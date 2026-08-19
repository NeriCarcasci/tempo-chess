/**
 * Materializing a replay into positions.
 *
 * E09 built `buildRun` and `publishRun` and nothing called them outside a gate,
 * so a synced game never became a chain of core positions — which meant no
 * transposition was findable, no engine work had anything to screen, and the
 * analysis pipeline had no input. One work item does it for one replay revision.
 *
 * Deliberately two steps in one handler. Building without publishing leaves a
 * run nothing reads, and publishing is the atomic pointer move E09 already owns;
 * splitting them across two items would buy a queue hop and a state to clean up
 * after a crash between them.
 */

import type { Sql } from "postgres";
import { registerHandler, type WorkContext, type WorkResult } from "../ops/handlers.js";
import { WorkFailure } from "../ops/retry.js";
import { buildRun, publishRun } from "./materialize.js";

export const MATERIALIZE_TASK = "chess_materialize_replay";

interface ReplayRow {
  id: string;
  /** jsonb, which a driver may hand over parsed or as text. Accept either. */
  normalized_replay: unknown;
  initial_fen: string | null;
}

interface NormalizedReplay {
  moves?: { uci: string; clockMs?: number | null }[];
}

function replayOf(value: unknown): NormalizedReplay {
  if (value === null || value === undefined) return {};
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as NormalizedReplay;
    } catch {
      return {};
    }
  }
  return value as NormalizedReplay;
}

export async function materializeReplayRevision(
  input: { replayRevisionId: string },
  sql: Sql,
): Promise<{ runId: string; occurrences: number; alreadyPublished: boolean }> {
  const [revision] = await sql<ReplayRow[]>`
    select id, normalized_replay, initial_fen
    from chess.game_replay_revisions where id = ${input.replayRevisionId}
  `;
  if (!revision) {
    throw new WorkFailure("invalid_input", "unknown_revision", "no such replay revision");
  }
  const moves = replayOf(revision.normalized_replay).moves ?? [];
  if (moves.length === 0) {
    // A replay with no moves is not a materialization failure; it is a game
    // that should never have been accepted, and the normalizer already refuses
    // them. Saying `invalid_input` puts it in front of somebody rather than
    // retrying forever.
    throw new WorkFailure("invalid_input", "empty_replay", "the replay has no moves");
  }

  const built = await buildRun(sql, revision.id, {
    initialFen: revision.initial_fen,
    moves: moves.map((move) => ({ uci: move.uci, clockMs: move.clockMs ?? null })),
  });
  if (!built.alreadyPublished) {
    await publishRun(sql, built.runId);
  }
  return {
    runId: built.runId,
    occurrences: built.occurrenceCount,
    alreadyPublished: built.alreadyPublished,
  };
}

async function runMaterializeItem(context: WorkContext, sql: Sql): Promise<WorkResult> {
  const payload = context.item.payload as { replayRevisionId?: unknown };
  const replayRevisionId =
    typeof payload.replayRevisionId === "string" ? payload.replayRevisionId : null;
  if (replayRevisionId === null) {
    throw new WorkFailure("invalid_input", "invalid_payload", "the payload names no revision");
  }
  const startedAt = Date.now();
  const result = await materializeReplayRevision({ replayRevisionId }, sql);
  return {
    outputRef: `materialization-run:${result.runId}`,
    outputSummary: { occurrences: result.occurrences, alreadyPublished: result.alreadyPublished },
    metrics: { outputCount: result.occurrences, computeMs: Date.now() - startedAt },
  };
}

let registered = false;

export function registerPositionHandlers(): void {
  if (registered) return;
  registered = true;
  registerHandler(MATERIALIZE_TASK, async (context) =>
    runMaterializeItem(context, await runtimeSql()),
  );
}

async function runtimeSql(): Promise<Sql> {
  const { client } = await import("../db/client.js");
  return client as unknown as Sql;
}
