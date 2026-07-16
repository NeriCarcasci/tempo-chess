import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { FixtureBenchmarkAdapter, StockfishBenchmarkAdapter } from "./adapters.js";
import { buildBenchmarkCorpus, validateBenchmarkCorpus } from "./corpus.js";
import { formatMarkdownReport, runBenchmark } from "./report.js";

function argument(name: string): string | undefined {
  const token = process.argv.find((entry) => entry.startsWith(`--${name}=`));
  return token?.slice(name.length + 3);
}

const adapterName = argument("adapter") ?? "fixture";
const limit = Number(argument("limit") ?? "0");
const output = argument("output");
const adapter = adapterName === "stockfish"
  ? new StockfishBenchmarkAdapter()
  : new FixtureBenchmarkAdapter();

const fullCorpus = buildBenchmarkCorpus();
validateBenchmarkCorpus(fullCorpus);
const corpus = limit > 0 ? fullCorpus.slice(0, limit) : fullCorpus;
const report = await runBenchmark(adapter, corpus);
const markdown = formatMarkdownReport(report);

if (output) {
  const destination = resolve(output);
  await writeFile(destination, markdown, "utf8");
  console.log(`Wrote ${destination}`);
} else {
  console.log(markdown);
}

if (report.regressions.length) process.exitCode = 1;
