/**
 * The access request an account holds over itself.
 *
 * Everything here runs inside a transaction that has already bound the actor.
 * `app.access_requests` carries `force row level security` with an owner policy
 * on `private.current_actor_id()`, so a read off the pool returns zero rows
 * rather than raising — and a zero-row read here would look exactly like "this
 * account never asked", which the gate would then treat as a state it does not
 * recognise. Every function takes the transaction rather than the shared client
 * so that cannot happen by accident.
 */

import type { client } from "../db/client.js";
import { isoOf, requiredIso } from "../db/timestamps.js";
import { ProblemError } from "../v1/problem.js";
import { MAX_NOTE_LENGTH, type AccessRequest, type AccessState } from "./contract.js";

interface AccessRow {
  user_id: string;
  state: string;
  note: string | null;
  requested_at: string | Date;
  note_updated_at: string | Date | null;
  decided_at: string | Date | null;
  decision_note: string | null;
}

function toRequest(row: AccessRow): AccessRequest {
  return {
    userId: row.user_id,
    // The column carries a check constraint naming the three states, so this
    // cast is a statement about the schema rather than about the value.
    state: row.state as AccessState,
    note: row.note,
    requestedAt: requiredIso(row.requested_at, "access_requests.requested_at"),
    noteUpdatedAt: isoOf(row.note_updated_at),
    decidedAt: isoOf(row.decided_at),
    decisionNote: row.decision_note,
  };
}

const COLUMNS = "user_id, state, note, requested_at, note_updated_at, decided_at, decision_note";

/**
 * The account's request, creating it if this is the first time we have seen them.
 *
 * Creating it here rather than on a button press is what makes "notify us about
 * a signup" true without an outbound channel: somebody who signs up and opens
 * the app is in the pending queue before they have typed anything, so an
 * operator sees a person who is waiting even if they never write a note. It
 * also means approval needs no provisioning step later.
 *
 * The insert names no state. `pending` is the column default and the owner
 * insert policy additionally pins it, so neither this function nor a future
 * caller can create a row that arrives already approved.
 */
export async function ensureAccessRequest(
  tx: typeof client,
  actorId: string,
): Promise<AccessRequest> {
  await tx`
    insert into app.access_requests (user_id) values (${actorId}::uuid)
    on conflict (user_id) do nothing`;
  const rows = await tx<AccessRow[]>`
    select ${tx.unsafe(COLUMNS)} from app.access_requests where user_id = ${actorId}::uuid`;
  const row = rows[0];
  if (!row) {
    // Not a missing row: the insert above just ran. This is the actor context
    // being absent, which makes the owner policy match nothing and returns an
    // empty set with no error. Failing loudly is the whole point, because the
    // alternative is a gate that reads "no request" and has to guess.
    throw new Error("access request is unreadable; the actor context is not bound");
  }
  return toRequest(row);
}

/** The account's own request. Null only when the row genuinely does not exist. */
export async function readAccessRequest(
  tx: typeof client,
  actorId: string,
): Promise<AccessRequest | null> {
  const rows = await tx<AccessRow[]>`
    select ${tx.unsafe(COLUMNS)} from app.access_requests where user_id = ${actorId}::uuid`;
  return rows[0] ? toRequest(rows[0]) : null;
}

/**
 * Write the sentence the person wants an operator to read.
 *
 * `forma_api` holds `update (note, note_updated_at)` and no grant on `state`,
 * so this statement is the whole of what an account may change about its own
 * access. That is enforced by the grant rather than by this function being
 * careful: a later edit here that added `state` to the SET list would be
 * refused by the database instead of quietly shipping self-approval.
 */
export async function writeAccessNote(
  tx: typeof client,
  actorId: string,
  note: string,
): Promise<AccessRequest> {
  const trimmed = note.trim();
  if (trimmed.length > MAX_NOTE_LENGTH) {
    throw new ProblemError("VALIDATION_FAILED", {
      detail: `Keep it under ${MAX_NOTE_LENGTH} characters.`,
      errors: [{ path: "body.note", code: "TOO_LONG", message: "note is too long" }],
    });
  }
  const rows = await tx<AccessRow[]>`
    update app.access_requests
    set note = ${trimmed.length === 0 ? null : trimmed}, note_updated_at = now()
    where user_id = ${actorId}::uuid
    returning ${tx.unsafe(COLUMNS)}`;
  const row = rows[0];
  if (!row) throw new ProblemError("NOT_FOUND", { detail: "No access request for this account." });
  return toRequest(row);
}
