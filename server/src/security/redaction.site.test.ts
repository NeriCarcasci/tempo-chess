import assert from "node:assert/strict";
import { test } from "node:test";
import { redactError } from "./redaction.js";

test("a logged error names where it was thrown and never what it said", () => {
  function boom(): never {
    throw new RangeError("nerihc played 1. e4 at 2026-08-20T00:00:00Z");
  }
  let line = "";
  try {
    boom();
  } catch (error) {
    line = redactError(error);
  }
  assert.match(line, /^RangeError\//);
  assert.match(line, /at security\/redaction\.site\.test\.ts:\d+/);
  assert.doesNotMatch(line, /nerihc/);
  assert.doesNotMatch(line, /e4/);
});

test("an error with no application frames still classifies", () => {
  const error = new RangeError("x");
  error.stack = "RangeError: x\n    at foo (node:internal/thing:1:1)";
  const line = redactError(error);
  assert.match(line, /^RangeError\//);
  assert.doesNotMatch(line, / at /);
});
