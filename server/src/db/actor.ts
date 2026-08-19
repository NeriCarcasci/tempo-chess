/**
 * Running a unit of work as one actor.
 *
 * `private.set_actor_context` sets a transaction-local setting, so every
 * statement a forced row-level policy will judge has to run inside the same
 * transaction that bound the actor. `withActorContext` in `v1/auth/context.ts`
 * does that for one API request against the API's own connection; this does it
 * for any connection, which is what a worker needs.
 *
 * The shim exists because postgres.js transaction handles expose `savepoint`
 * and not `begin`, while the repository's composite writers — `completeRun`,
 * `publishSubjectGame`, `writeAssessments` — legitimately open a transaction of
 * their own. A nested transaction *is* a savepoint, so mapping one onto the
 * other lets those functions be called inside a bound transaction without
 * rewriting them, and without the alternative: a policy exemption for the
 * worker role, which would turn E11's tenancy claim into a comment.
 */

import type { Sql } from "postgres";

interface Savepointable {
  savepoint<T>(fn: (tx: unknown) => Promise<T>): Promise<T>;
  begin?: unknown;
}

/** A transaction handle that also answers to `begin`, by taking a savepoint. */
function nestable(tx: unknown): Sql {
  const handle = tx as Savepointable;
  if (typeof handle.begin !== "function" && typeof handle.savepoint === "function") {
    Object.defineProperty(handle, "begin", {
      value: <T>(fn: (inner: unknown) => Promise<T>) => handle.savepoint((inner) => fn(nestable(inner))),
      configurable: true,
      enumerable: false,
    });
  }
  return handle as unknown as Sql;
}

/**
 * Bind an actor and run `fn` inside that transaction.
 *
 * The actor is never taken from a request body or a queue payload. Callers
 * derive it from a row the API already wrote — the workflow's owner, or the
 * verified token — so a forged identifier reaches a policy that hides the rows
 * rather than a check somebody remembered to write.
 */
export async function withActor<T>(
  sql: Sql,
  actorId: string,
  fn: (tx: Sql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`select private.set_actor_context(${actorId}::uuid)`;
    return fn(nestable(tx));
  }) as Promise<T>;
}
