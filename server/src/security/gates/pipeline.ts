/**
 * `npm run pipeline:test` — 9 contract assertions.
 *
 * The deterministic pipeline suites plus the eight CORS assertions. The suites
 * are run as subprocesses and judged on exit status and output, so this gate
 * cannot accidentally count their assertions as its own or let a suite that
 * skipped everything report success.
 */

import { spawnSync } from "node:child_process";
import {
  assertionsFor,
  gateExitCode,
  loadManifest,
  runGate,
  type AssertionBody,
  type AssertionRecord,
} from "../assertions.js";
import { repoRoot } from "../repo-scan.js";
import { corsBodies } from "../../cors.test.js";

const COMMAND = "cd server && npm run pipeline:test";
const PIPELINE_SUITES = [
  "src/pipeline/state.test.ts",
  "src/pipeline/fire-and-forget.test.ts",
] as const;

/** Run the pre-existing suite and require a clean, non-empty, non-skipped result. */
export function existingSuiteBody(serverRoot: string): AssertionBody {
  return async () => {
    const build = spawnSync("npm", ["run", "build"], {
      cwd: serverRoot,
      encoding: "utf8",
      timeout: 60_000,
    });
    if (build.status !== 0) {
      throw new Error(`pipeline adversarial fixture build exited ${build.status}`);
    }

    for (const suite of PIPELINE_SUITES) {
      const result = spawnSync("npx", ["tsx", suite], {
        cwd: serverRoot,
        encoding: "utf8",
        timeout: 60_000,
      });
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      if (result.status !== 0) {
        throw new Error(`${suite} exited ${result.status}`);
      }
      if (/\b(skip|skipped|todo|pending)\b/i.test(output)) {
        throw new Error(`${suite} reported a skipped or unfinished case`);
      }
      if (output.trim().length === 0) {
        throw new Error(`${suite} produced no output; an empty suite is not a pass`);
      }
    }
    return `${PIPELINE_SUITES.join(" and ")} exited 0 with no skipped or unfinished case`;
  };
}

export function buildPipelineBodies(
  serverRoot: string,
  records: readonly AssertionRecord[],
): Map<string, AssertionBody> {
  const cors = corsBodies();
  const bodies = new Map<string, AssertionBody>();
  for (const record of records) {
    if (record.category === "baseline") {
      bodies.set(record.id, existingSuiteBody(serverRoot));
      continue;
    }
    if (record.category === "cors") {
      const body = cors.get(record.target);
      if (!body) throw new Error(`no CORS body for target "${record.target}"`);
      bodies.set(record.id, body);
      continue;
    }
    throw new Error(`unexpected category "${record.category}" for ${record.id}`);
  }
  return bodies;
}

export async function main(): Promise<number> {
  const root = repoRoot();
  const manifest = loadManifest(root);
  const records = assertionsFor(manifest, COMMAND);
  const bodies = buildPipelineBodies(`${root}/server`, records);
  const outcome = await runGate({ command: COMMAND, records, bodies });
  return gateExitCode(outcome);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`pipeline:test failed to run: ${String(error)}\n`);
      process.exit(1);
    },
  );
}
