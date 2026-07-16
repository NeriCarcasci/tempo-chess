import assert from "node:assert/strict";
import { FixtureBenchmarkAdapter } from "./adapters.js";
import { buildBenchmarkCorpus } from "./corpus.js";
import { formatMarkdownReport, runBenchmark } from "./report.js";

const report = await runBenchmark(new FixtureBenchmarkAdapter(), buildBenchmarkCorpus());

assert.equal(report.corpusGames, 120);
assert.equal(report.profiles.length, 2);
assert.equal(report.recommended.screening, "screening");
assert.equal(report.recommended.deep, "deep");
assert.deepEqual(report.forecasts.map((entry) => entry.games), [30, 100, 500]);
assert.equal(report.regressions.length, 0, report.regressions.join(", "));
assert.ok(report.profiles[0].runtimeMs.cold.p50 > report.profiles[0].runtimeMs.warm.p50);
assert.ok(report.profiles[0].bestMoveAgreement >= 0.75);
assert.ok(report.profiles[0].judgmentStability >= 0.85);

const markdown = formatMarkdownReport(report);
assert.match(markdown, /Warm P50/);
assert.match(markdown, /\| 500 \|/);
assert.match(markdown, /All quality gates passed/);

console.log("PASS benchmark report: quality gates, cold/warm latency and cost forecasts");
