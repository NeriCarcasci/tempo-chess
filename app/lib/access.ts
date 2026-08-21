import { v1Data, newIdempotencyKey } from "./v1/client";
import type { AccessRequest } from "./v1/types";

/**
 * The account's own request to join the closed beta.
 *
 * The only two `/v1` calls an unapproved account can make. Everything else the
 * product offers answers `ACCESS_NOT_APPROVED`, which `lib/v1/client` turns
 * into a redirect back to the screen these feed.
 */

/**
 * Mirrors `MAX_NOTE_LENGTH` in `server/src/access/contract.ts`.
 *
 * Duplicated rather than shared because the app and the server are separate
 * builds with no common package, and a `maxLength` on the textarea is worth
 * having even so: it stops somebody writing eight hundred words and losing
 * them to a validation failure. The server's limit is the real one and rejects
 * rather than truncates, so the two disagreeing costs a clear error, not data.
 */
export const MAX_NOTE_LENGTH = 1000;

export function getAccessRequest(): Promise<AccessRequest> {
  return v1Data<AccessRequest>("/v1/access-request");
}

/**
 * Replace the note.
 *
 * One idempotency key per save rather than one per keystroke: this is a single
 * user intent, and a key reused across two different drafts would make the
 * second save a replay of the first. The caller passes nothing and gets a fresh
 * key, which is correct for a form somebody presses once.
 */
export function setAccessNote(note: string): Promise<AccessRequest> {
  return v1Data<AccessRequest>("/v1/access-request/note", {
    method: "PUT",
    json: { note },
    idempotencyKey: newIdempotencyKey(),
  });
}
