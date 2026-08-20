/**
 * JSON parameters, as this process can actually send them.
 *
 * `postgres.js` ships a helper for this — `sql.json(value)` — and it does not
 * work here. `drizzle(client, { schema })` in `db/client.ts` mutates the shared
 * connection when it is constructed: `drizzle-orm/postgres-js` replaces the
 * handlers for the json and jsonb OIDs so that drizzle can map them itself, and
 * it replaces the **serializer** along with the parser. The wrapper `sql.json`
 * returns is then handed to a serializer that does not recognise it, and the
 * bind fails with
 *
 *   TypeError: The "string" argument must be of type string ... Received an
 *   instance of Object
 *
 * before the statement is ever sent. It is a `TypeError`, not a `PostgresError`,
 * so it does not look like a database problem in a log — it looks like a bug in
 * the caller.
 *
 * Sixteen call sites used `sql.json`, which is every jsonb write in the
 * analysis, estimates, engine and editorial paths. None of them could ever have
 * succeeded in a deployed process. That is why this is a named helper rather
 * than an inline `JSON.stringify`: the next person reaching for `sql.json` needs
 * to find out why it is absent, and a bare `JSON.stringify` beside a `::jsonb`
 * cast does not tell them.
 *
 * Always cast at the call site — `${jsonParam(value)}::jsonb` — so the column's
 * type is never inferred from an untyped parameter.
 */

/** A JSON value as a bind parameter. Cast the placeholder to `jsonb`. */
export function jsonParam(value: unknown): string {
  return JSON.stringify(value ?? null);
}
