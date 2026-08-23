/**
 * Playing a game against the engine, on `/v1`.
 *
 * The game itself lives in the browser and is never filed as a real game.
 * Stockfish answers immediately; Maia may first schedule durable private model
 * work. This module hides that transport difference so the board receives the
 * same ready move contract from either family.
 */

import { newIdempotencyKey, v1Data } from "./client";
import type {
  OpponentCatalogue,
  OpponentFamilyEntry,
  OpponentFamilyLevel,
  OpponentMove,
  OpponentMoveBody,
  Workflow,
} from "./types";

export function getPlayOpponents(): Promise<OpponentCatalogue> {
  return v1Data<OpponentCatalogue>("/v1/play/opponents");
}

/**
 * Ask for the opponent's reply.
 *
 * `idempotencyKey` is one per *move*, not one per request: the caller retries a
 * dropped reply with the same key so a move that was already computed comes
 * back rather than being searched again. Omitting it makes every attempt a
 * fresh intent, which is the wrong behaviour for a retry loop.
 */
type OpponentMoveInput = Omit<OpponentMoveBody, "turnKey"> & { turnKey?: string };
type ReadyOpponentMove = OpponentMove & { state: "ready"; workflowId: null };

const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function waitForMaiaWorkflow(workflowId: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const workflow = await v1Data<Workflow>(`/v1/workflows/${workflowId}`);
    if (workflow.state === "succeeded") return;
    if (workflow.state === "failed" || workflow.state === "cancelled") {
      throw new Error(workflow.error?.message ?? "Maia could not produce a move.");
    }
    await wait(1_000);
  }
  throw new Error("Maia took too long to produce a move.");
}

export async function requestOpponentMove(
  body: OpponentMoveInput,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<ReadyOpponentMove> {
  // Stable across the schedule/wait/retry cycle, while the HTTP command key is
  // refreshed after a 202 so the idempotency layer does not replay that 202.
  const payload = { ...body, turnKey: body.turnKey ?? idempotencyKey } as OpponentMoveBody;
  let commandKey = idempotencyKey;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await v1Data<OpponentMove>("/v1/play/moves", {
      json: payload,
      idempotencyKey: commandKey,
    });
    if (result.state === "ready") return result as ReadyOpponentMove;
    if (!result.workflowId) throw new Error("Maia scheduled no move workflow.");
    await waitForMaiaWorkflow(result.workflowId);
    commandKey = newIdempotencyKey();
  }
  throw new Error("Maia completed its work but the move was not available.");
}

/**
 * The families this deployment can actually play.
 *
 * A screen offers these and nothing else. The catalogue also describes the
 * families it cannot serve, so an unavailable Maia deployment is never
 * silently substituted with Stockfish.
 */
export function availableFamilies(catalogue: OpponentCatalogue): OpponentFamilyEntry[] {
  return catalogue.families.filter((entry) => entry.available);
}

/**
 * The level closest to a rating, for the first-visit default.
 *
 * Ties go to the lower level: guessing a player weaker than they are costs them
 * an easy game, and guessing stronger costs them the feature.
 */
export function nearestLevel(
  levels: readonly OpponentFamilyLevel[],
  rating: number,
): OpponentFamilyLevel | null {
  let best: OpponentFamilyLevel | null = null;
  for (const level of levels) {
    if (best === null) {
      best = level;
      continue;
    }
    const closer = Math.abs(level.nominalRating - rating) < Math.abs(best.nominalRating - rating);
    if (closer) best = level;
  }
  return best;
}

/**
 * What to say under the strength selector, or nothing.
 *
 * The prototype offered an "800 Elo bot" that was really Stockfish's 1320 floor
 * wearing an 800 label, and a player losing to it drew a false conclusion about
 * their own rating. The server now reports what the engine really plays at, and
 * this is the sentence that passes that on rather than swallowing it.
 */
export function strengthNote(level: OpponentFamilyLevel | null): string | null {
  if (!level || !level.clamped) return null;
  // Both directions: an engine can fall short of a level as well as overshoot
  // it, and Maia's bands stop at 1900 where Stockfish's limiter starts at 1320.
  const direction = level.playsAt > level.nominalRating ? "weaker" : "stronger";
  return `This engine cannot play ${direction} than ${level.playsAt}, so that is what this level plays at.`;
}
