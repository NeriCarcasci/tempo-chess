import { canonicalJson } from "./canonical-json.js";
import { client } from "../db/client.js";
import { ProblemError } from "./problem.js";
import { sign, type KernelEnv } from "./signing.js";

/**
 * Durable command replay, per plans/v1-api-contract.md §1.4 and
 * plans/database-architecture.md §14.7.
 *
 * The problem this solves is narrow and real: a client posts a command, the
 * connection dies before the response arrives, and the client retries. Without
 * a record, the retry is a second command. With one, it is the same command,
 * and it gets the same answer.
 *
 * Three failure modes it must not have:
 *
 *  - it must not treat *different* requests sharing a key as the same command,
 *    hence the digest and `IDEMPOTENCY_CONFLICT`;
 *  - it must not let a process that died mid-command wedge the key forever,
 *    hence the lease;
 *  - it must not become a place private request data is retained, hence a keyed
 *    digest instead of the body and a stored response that is only ever the
 *    kernel's own envelope.
 */

/** §1.4: opaque, client-generated, up to 128 characters. */
export const MAX_KEY_LENGTH = 128;

/** Deliberately narrow: printable, URL-safe, no whitespace or control bytes. */
const KEY_PATTERN = /^[A-Za-z0-9._~:@!$&'()*+,;=-]{1,128}$/;

/** How long a `processing` attempt is believed before a duplicate may claim it. */
export const LEASE_MS = 60_000;

/** §1.4 requires an expiry; a day covers any realistic client retry window. */
export const RECORD_TTL_MS = 24 * 60 * 60_000;

/** The scope literal used when a command has no authenticated actor. */
export const ANONYMOUS_ACTOR_KEY = "anon";

export type IdempotencyOutcome = "stored" | "replayed" | "conflict" | "in_progress";

export interface IdempotencyScope {
  /** `POST /v1/public/beta-signups`. Part of the uniqueness key. */
  routeKey: string;
  method: string;
  /** Null for an anonymous command. */
  actorProfileId: string | null;
}

export interface StoredResponse {
  status: number;
  body: unknown;
}

/**
 * Validate the header. Missing is as much a failure as malformed: §1.4 makes
 * the key required on commands, and a command that silently ran without one is
 * a command that cannot be safely retried.
 */
export function requireIdempotencyKey(header: string | null | undefined): string {
  const key = header?.trim() ?? "";
  if (key.length === 0) {
    throw new ProblemError("VALIDATION_FAILED", {
      detail: "This command needs an Idempotency-Key header so a retry cannot run it twice.",
      errors: [
        { path: "header.Idempotency-Key", code: "REQUIRED", message: "an idempotency key is required" },
      ],
    });
  }
  if (!KEY_PATTERN.test(key)) {
    throw new ProblemError("VALIDATION_FAILED", {
      detail: `Idempotency-Key must be at most ${MAX_KEY_LENGTH} URL-safe characters.`,
      errors: [
        { path: "header.Idempotency-Key", code: "MALFORMED", message: "unsupported characters or length" },
      ],
    });
  }
  return key;
}

/**
 * The digest that decides whether a retry is the same command.
 *
 * Keyed rather than plain. A plain SHA-256 of the body would let anyone holding
 * a database copy confirm a guessed body — for the beta signup route, that
 * means confirming that a specific person signed up. The HMAC removes that
 * without changing anything about how the digest is used.
 */
export function requestDigest(scope: IdempotencyScope, body: unknown, env?: KernelEnv): string {
  return sign("idempotency-digest", [scope.method, scope.routeKey, canonicalJson(body ?? null)], env);
}

/**
 * Every timestamp is the database's, never an instance's.
 *
 * A lease compared against `Date.now()` is a lease decided by whichever Cloud
 * Run instance happens to answer, and two instances with a few seconds of clock
 * skew would disagree about whether a command is still running — one replaying,
 * one taking the record over. `now()` inside the statement gives every instance
 * one clock. It also sidesteps the driver: with prepared statements disabled,
 * which the transaction pooler requires, postgres.js neither serializes a
 * `Date` parameter nor parses a timestamp back into one.
 */
const LEASE_SECONDS = LEASE_MS / 1_000;
const RECORD_TTL_SECONDS = RECORD_TTL_MS / 1_000;

interface RecordRow {
  id: string;
  state: string;
  request_digest: string;
  response_status: number | null;
  response_body: unknown;
  /** Computed by the database, so the decision does not depend on our clock. */
  lease_live: boolean;
}

export type BeginResult =
  | { kind: "proceed"; recordId: string }
  | { kind: "replay"; response: StoredResponse };

function actorKey(scope: IdempotencyScope): string {
  return scope.actorProfileId ?? ANONYMOUS_ACTOR_KEY;
}

/**
 * Claim the key, or find out why we may not.
 *
 * The insert races other instances on purpose: the unique index is the lock. A
 * loser reads the winner's row and decides from its state, which is the only
 * arrangement that stays correct when two Cloud Run instances receive the same
 * retry at the same millisecond.
 */
export async function beginCommand(
  scope: IdempotencyScope,
  key: string,
  digest: string,
  sql = client,
): Promise<BeginResult> {
  const inserted = await sql<{ id: string }[]>`
    insert into ops.idempotency_records (
      actor_profile_id, actor_key, route_key, idempotency_key,
      request_method, request_digest, state, lease_expires_at, expires_at
    ) values (
      ${scope.actorProfileId}, ${actorKey(scope)}, ${scope.routeKey}, ${key},
      ${scope.method}, ${digest}, 'processing',
      now() + make_interval(secs => ${LEASE_SECONDS}),
      now() + make_interval(secs => ${RECORD_TTL_SECONDS})
    )
    on conflict (actor_key, route_key, idempotency_key) do nothing
    returning id`;
  if (inserted[0]) return { kind: "proceed", recordId: inserted[0].id };

  const existing = await sql<RecordRow[]>`
    select id, state, request_digest, response_status, response_body,
           (state = 'processing' and lease_expires_at > now()) as lease_live
    from ops.idempotency_records
    where actor_key = ${actorKey(scope)}
      and route_key = ${scope.routeKey}
      and idempotency_key = ${key}
    limit 1`;
  const row = existing[0];
  // Expired between the failed insert and this read. Retry the claim once; a
  // second miss is a genuine race we let the caller retry.
  if (!row) return beginCommandAfterExpiry(scope, key, digest, sql);

  // The digest check comes first. A different request under the same key is a
  // client bug or an attack, and it is a conflict whatever state the record is
  // in — including a completed one, which must never replay someone else's
  // response to a different command.
  if (row.request_digest !== digest) {
    throw new ProblemError("IDEMPOTENCY_CONFLICT", {
      detail: "This idempotency key was already used for a different request. Use a new key.",
    });
  }

  if (row.state === "completed") {
    return {
      kind: "replay",
      response: { status: row.response_status ?? 200, body: row.response_body },
    };
  }

  if (row.lease_live) {
    throw new ProblemError("IDEMPOTENCY_IN_PROGRESS", {
      detail: "The original request is still running. Retry in a moment.",
      retryAfterSeconds: 1,
    });
  }

  // `failed`, or `processing` with a dead lease. Exactly one caller may take it
  // over: the compare-and-set names the state we read, so a concurrent claimant
  // updates zero rows and is told to retry.
  const claimed = await sql<{ id: string }[]>`
    update ops.idempotency_records
    set state = 'processing',
        lease_expires_at = now() + make_interval(secs => ${LEASE_SECONDS}),
        response_status = null,
        response_body = null,
        completed_at = null,
        updated_at = now()
    where id = ${row.id}
      and request_digest = ${digest}
      and (state = 'failed' or (state = 'processing' and lease_expires_at <= now()))
    returning id`;
  if (claimed[0]) return { kind: "proceed", recordId: claimed[0].id };
  throw new ProblemError("IDEMPOTENCY_IN_PROGRESS", {
    detail: "The original request is still running. Retry in a moment.",
    retryAfterSeconds: 1,
  });
}

/** One retry of the claim after a record expired out from under the insert. */
async function beginCommandAfterExpiry(
  scope: IdempotencyScope,
  key: string,
  digest: string,
  sql: typeof client,
): Promise<BeginResult> {
  const rows = await sql<{ id: string }[]>`
    insert into ops.idempotency_records (
      actor_profile_id, actor_key, route_key, idempotency_key,
      request_method, request_digest, state, lease_expires_at, expires_at
    ) values (
      ${scope.actorProfileId}, ${actorKey(scope)}, ${scope.routeKey}, ${key},
      ${scope.method}, ${digest}, 'processing',
      now() + make_interval(secs => ${LEASE_SECONDS}),
      now() + make_interval(secs => ${RECORD_TTL_SECONDS})
    )
    on conflict (actor_key, route_key, idempotency_key) do nothing
    returning id`;
  if (rows[0]) return { kind: "proceed", recordId: rows[0].id };
  throw new ProblemError("IDEMPOTENCY_IN_PROGRESS", {
    detail: "The original request is still running. Retry in a moment.",
    retryAfterSeconds: 1,
  });
}

/**
 * Record the outcome so the next retry replays it.
 *
 * Only the kernel's own envelope is stored. A handler cannot smuggle a provider
 * body or an internal error into this column, because the only caller is the
 * kernel middleware and the only value it has is the envelope it just built.
 */
export async function completeCommand(
  recordId: string,
  response: StoredResponse,
  resource?: { type: string; id: string } | null,
  sql = client,
): Promise<void> {
  // The body is encoded here rather than through the driver's `json` helper,
  // and cast `::text::jsonb` rather than `::jsonb`: postgres.js reads the
  // trailing cast to choose a serializer, and a bare `::jsonb` would make it
  // JSON-encode the string we already encoded.
  await sql`
    update ops.idempotency_records
    set state = 'completed',
        response_status = ${response.status},
        response_body = ${JSON.stringify(response.body)}::text::jsonb,
        resource_type = ${resource?.type ?? null},
        resource_id = ${resource?.id ?? null},
        lease_expires_at = null,
        completed_at = now(),
        updated_at = now()
    where id = ${recordId}`;
}

/**
 * Release the key after a failed attempt so the client's retry can run.
 *
 * The record is kept rather than deleted: it still carries the digest, so a
 * retry with a *different* body is still a conflict, which is the whole point
 * of the digest surviving a failure.
 */
export async function failCommand(recordId: string, sql = client): Promise<void> {
  await sql`
    update ops.idempotency_records
    set state = 'failed',
        lease_expires_at = null,
        completed_at = now(),
        updated_at = now()
    where id = ${recordId}`;
}
