/**
 * Timestamps as they actually arrive from a raw query.
 *
 * `drizzle(client, { schema })` in `db/client.ts` mutates the shared postgres.js
 * connection when it is constructed: `drizzle-orm/postgres-js` replaces the
 * parsers for every date and timestamp OID with a transparent one, so that
 * drizzle can map them itself. Every raw `client\`...\`` query in this process
 * therefore gets a **string** back from a `timestamptz` column, not a Date.
 *
 * Code that assumed a Date threw a TypeError three layers up and served a 500.
 * That is not a hypothetical: both of E20's case-study endpoints did exactly
 * that until they went through here.
 *
 * These two functions are the fix and the documentation. They accept either
 * shape, so nothing here depends on which driver is in the middle — which is
 * the property worth having, rather than a note telling the next person to
 * remember.
 */

/** A timestamp column, as the driver may hand it over. */
export type RawTimestamp = string | Date | null | undefined;

export function toDate(value: RawTimestamp): Date | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(value);
}

/**
 * The ISO string a `/v1` body carries.
 *
 * Never `String(value)`: a string from the driver is PostgreSQL's own text
 * format (`2026-08-19 14:45:10.71+00`), which is not ISO 8601 and would put a
 * subtly different timestamp on the wire depending on the driver's mood.
 */
export function isoOf(value: RawTimestamp): string | null {
  return toDate(value)?.toISOString() ?? null;
}

/** For a column the schema says is `not null`. Throws rather than lying. */
export function requiredIso(value: RawTimestamp, column: string): string {
  const iso = isoOf(value);
  if (iso === null) throw new Error(`${column} is null, but the schema says it cannot be`);
  return iso;
}
