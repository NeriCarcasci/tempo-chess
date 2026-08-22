/**
 * `npm run concepts:gate` — one command that proves the changed path.
 *
 * The tactical-concepts project touches a detector, a worker, a migration, an
 * API and two screens. Running the right subset of this repository's gates by
 * hand means remembering nine commands and noticing when one of them was not
 * run, so this is the sequence, written down and executed.
 *
 * It is deliberately not a platform. It runs the checks that cover *this*
 * project's boundaries and nothing else — adding the whole repository's gates
 * here would make it slow enough to be skipped, and a gate that gets skipped
 * protects nothing.
 *
 * ## What needs a database, and what does not
 *
 * Most of what this project changed is pure: detectors, the evidence layer,
 * the contract matrix, the backfill's selection, the read model's shaping. Those
 * run anywhere.
 *
 * Migration behaviour, row level security, ownership on the review route and
 * retry against real indexes are not pure, and there is no honest way to fake
 * them. When `DATABASE_URL` is absent those steps are reported as **skipped by
 * name** rather than quietly omitted, and the command says so in its summary —
 * because a gate that reports success while silently running half of itself is
 * the failure mode this whole project has spent four milestones avoiding.
 */

import { spawnSync } from "node:child_process";

interface Step {
  readonly name: string;
  /** What this step covers, named so a failure points at a ticket. */
  readonly covers: string;
  readonly script: string;
  /** True when the step cannot run without a database. */
  readonly needsDatabase: boolean;
}

const STEPS: readonly Step[] = [
  {
    name: "types",
    covers: "FOR-125/132/135 — the whole server compiles against the changed shapes",
    script: "typecheck",
    needsDatabase: false,
  },
  {
    name: "detectors",
    covers:
      "FOR-121/124/126-131 — catalogue and version invariants, detector fixtures for all "
      + "twelve families, event coalescing, censor rules, detection-key identity, backfill selection",
    script: "analysis:unit",
    needsDatabase: false,
  },
  {
    name: "engine",
    covers: "FOR-125 — static exchange and the attack helpers the detectors read through",
    script: "engine:unit",
    needsDatabase: false,
  },
  {
    name: "estimates",
    covers: "FOR-133 — the aggregate that reads opportunities and the words it publishes",
    script: "estimates:unit",
    needsDatabase: false,
  },
  {
    name: "api-schema",
    covers: "FOR-135 — the committed OpenAPI document matches the route registry",
    script: "v1:openapi:check",
    needsDatabase: false,
  },
  {
    name: "api-kernel",
    covers: "FOR-135 — envelope, ETag and problem shapes on the changed route",
    script: "v1:unit",
    needsDatabase: false,
  },
  {
    name: "performance",
    covers: "FOR-137 — the detector's cost on a production-shaped 80-ply game",
    script: "concepts:performance",
    needsDatabase: false,
  },
  {
    name: "migration",
    covers:
      "FOR-122/123/135 — empty database, existing E13 v1 rows, repeated migration and "
      + "forward recovery over migrations 0038, 0039 and 0041",
    script: "analysis:migration",
    needsDatabase: true,
  },
  {
    name: "security",
    covers:
      "FOR-135/136 — anonymous and non-owner access to a review, actor-bound backfill, "
      + "and least-privilege grants on the concept tables",
    script: "analysis:security",
    needsDatabase: true,
  },
  {
    name: "integration",
    covers: "FOR-132/136 — worker retry, row cardinality and exact evidence linkage",
    script: "analysis:integration",
    needsDatabase: true,
  },
];

function run(step: Step): boolean {
  const started = Date.now();
  const result = spawnSync("npm", ["run", "--silent", step.script], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const ok = result.status === 0;
  console.log(`${ok ? "pass" : "FAIL"}  ${step.name.padEnd(12)} ${seconds}s  ${step.script}`);
  if (!ok) {
    // The covering line is printed on failure rather than always, so a passing
    // run stays short enough to read and a failing one says which contract it
    // belongs to without anyone going looking.
    console.log(`      covers: ${step.covers}`);
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trimEnd();
    for (const line of output.split(/\r?\n/).slice(-25)) console.log(`      ${line}`);
  }
  return ok;
}

function main(): void {
  const hasDatabase = Boolean(process.env.DATABASE_URL);
  console.log(`concepts:gate  ${STEPS.length} steps, database ${hasDatabase ? "present" : "absent"}`);

  const failed: string[] = [];
  const skipped: Step[] = [];

  for (const step of STEPS) {
    if (step.needsDatabase && !hasDatabase) {
      skipped.push(step);
      continue;
    }
    if (!run(step)) failed.push(step.name);
  }

  for (const step of skipped) {
    console.log(`skip  ${step.name.padEnd(12)}       needs DATABASE_URL — ${step.covers}`);
  }

  console.log("");
  if (skipped.length > 0) {
    // Said plainly and at the end, where it cannot be missed. "Everything
    // passed" and "everything that ran passed" are different claims.
    console.log(
      `concepts:gate  ${STEPS.length - skipped.length - failed.length} passed, `
      + `${failed.length} failed, ${skipped.length} NOT RUN. `
      + "Set DATABASE_URL against a disposable database to run the rest.",
    );
  } else {
    console.log(`concepts:gate  ${STEPS.length - failed.length} passed, ${failed.length} failed.`);
  }

  if (failed.length > 0) {
    console.error(`concepts:gate  failed: ${failed.join(", ")}`);
    process.exit(1);
  }
  // A run that could not execute its database steps has not proved the project
  // is safe to release, and exiting zero would say that it had.
  process.exit(skipped.length > 0 ? 2 : 0);
}

main();
