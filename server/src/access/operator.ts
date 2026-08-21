/**
 * Running a unit of work as an operator.
 *
 * The admin surface has to look across accounts, and every tenant table it
 * reads is scoped to one actor. `withActorContext` is the wrong tool: there is
 * no single actor a queue of pending requests belongs to, and binding one would
 * hide every other account, which is the question being asked.
 *
 * So 0039 added a second transaction-local context beside the actor one, and
 * five SELECT policies that are dead unless it is bound. This is the only place
 * that binds it.
 *
 * The check is the database's, not this function's. `private.set_operator_context`
 * is `security definer` and reads `app.operators`, a table `forma_api` holds no
 * grant on. The API therefore cannot read the operator list, cannot write it,
 * and cannot set the flag for somebody who is not on it. A bug in this file
 * fails closed: the flag stays unset, the five policies match no row, and the
 * admin surface answers with an empty list rather than somebody else's data.
 */

import { client } from "../db/client.js";
import { ProblemError } from "../v1/problem.js";

/**
 * Bind `actorId` as an operator and run `fn` in that transaction.
 *
 * Throws `FORBIDDEN` when they are not one. Deliberately the same refusal an
 * ordinary user gets for somebody else's resource: a signed-in person probing
 * `/v1/admin/...` learns that they may not have it, and not whether the
 * endpoint found anything, or whether an operator list exists at all.
 */
export async function withOperatorContext<T>(
  actorId: string,
  fn: (tx: typeof client) => Promise<T>,
): Promise<T> {
  return client.begin(async (tx) => {
    const rows = await tx<{ granted: boolean }[]>`
      select private.set_operator_context(${actorId}::uuid) as granted`;
    if (rows[0]?.granted !== true) {
      throw new ProblemError("FORBIDDEN", { detail: "That does not belong to your account." });
    }
    return fn(tx as unknown as typeof client);
  }) as Promise<T>;
}

/**
 * Whether this account may use the admin surface at all.
 *
 * Used by the client to decide whether to render the operator navigation, and
 * by nothing that enforces anything: every admin route binds the context above
 * and is refused by the database's own answer if it is not held. A false here
 * hides a link; it does not close a door.
 */
export async function isOperator(actorId: string): Promise<boolean> {
  try {
    return await withOperatorContext(actorId, async () => true);
  } catch (error) {
    if (error instanceof ProblemError && error.code === "FORBIDDEN") return false;
    throw error;
  }
}
