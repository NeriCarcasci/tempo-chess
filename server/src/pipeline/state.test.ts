import assert from "node:assert/strict";
import { assertImportTransition, assertTaskTransition, classifyTaskFailure, progressPercent } from "./state.js";

assert.doesNotThrow(() => assertImportTransition("queued", "ingesting"));
assert.doesNotThrow(() => assertImportTransition("analyzing", "completed"));
assert.throws(() => assertImportTransition("completed", "queued"), /Invalid import transition/);
assert.doesNotThrow(() => assertTaskTransition("running", "queued"));
assert.throws(() => assertTaskTransition("completed", "running"), /Invalid task transition/);
assert.equal(classifyTaskFailure(1, 3), "queued");
assert.equal(classifyTaskFailure(3, 3), "failed");
assert.equal(progressPercent(25, 100), 25);
assert.equal(progressPercent(120, 100), 100);
console.log("pipeline state tests passed");
