import assert from "node:assert/strict";
import { test } from "node:test";
import { isoOf, requiredDate, requiredIso, toDate } from "./timestamps.js";

// PostgreSQL's own text format, which is what the driver hands back once
// drizzle has replaced the timestamp parsers. Note the space and the `+00`.
const RAW = "2026-08-19 14:45:10.71+00";

test("a driver string becomes the same instant as the equivalent Date", () => {
  const fromString = toDate(RAW);
  const fromDate = toDate(new Date("2026-08-19T14:45:10.710Z"));
  assert.ok(fromString instanceof Date);
  assert.equal(fromString?.getTime(), fromDate?.getTime());
});

test("requiredDate hands back something with getTime, whichever form arrived", () => {
  assert.equal(requiredDate(RAW, "x").getTime(), requiredDate(new Date(RAW), "x").getTime());
});

test("requiredDate refuses null rather than inventing an epoch", () => {
  assert.throws(() => requiredDate(null, "played_at"), /played_at is null/);
  assert.throws(() => requiredDate(undefined, "played_at"), /played_at is null/);
});

test("nullable columns stay null", () => {
  assert.equal(toDate(null), null);
  assert.equal(isoOf(null), null);
});

test("the wire format is ISO 8601, not the driver's text", () => {
  assert.equal(isoOf(RAW), "2026-08-19T14:45:10.710Z");
  assert.equal(requiredIso(RAW, "x"), "2026-08-19T14:45:10.710Z");
});
