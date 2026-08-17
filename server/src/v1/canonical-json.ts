/**
 * A deterministic JSON encoding.
 *
 * Two things in the kernel depend on the same bytes coming out for the same
 * value every time: the idempotency request digest, which decides whether a
 * retry is "the same command", and the ETag, which decides whether a cached
 * copy is still current. `JSON.stringify` does not promise that — object key
 * order follows insertion order, so two structurally identical bodies parsed
 * from differently ordered JSON encode differently.
 *
 * So: keys sorted, `undefined` dropped, and nothing clever. This is a hashing
 * input, not a wire format.
 */

export function canonicalJson(value: unknown): string {
  return encode(value, 0);
}

/** Deep structures in a request body are a denial-of-service surface, not a feature. */
const MAX_DEPTH = 32;

function encode(value: unknown, depth: number): string {
  if (depth > MAX_DEPTH) throw new RangeError("canonical JSON: value nests too deeply");
  if (value === null || value === undefined) return "null";
  const type = typeof value;
  if (type === "number") {
    // NaN and Infinity have no JSON form; encoding them as null would make two
    // different values hash the same.
    if (!Number.isFinite(value)) throw new RangeError("canonical JSON: non-finite number");
    return JSON.stringify(value);
  }
  if (type === "boolean" || type === "string") return JSON.stringify(value);
  if (type === "bigint") throw new TypeError("canonical JSON: bigint has no canonical form");
  if (Array.isArray(value)) {
    return `[${value.map((item) => encode(item, depth + 1)).join(",")}]`;
  }
  if (type === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${encode(item, depth + 1)}`)
      .join(",")}}`;
  }
  throw new TypeError(`canonical JSON: unsupported value of type ${type}`);
}
