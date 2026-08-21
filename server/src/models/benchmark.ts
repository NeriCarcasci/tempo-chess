import { readFile, stat, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { createHash } from "node:crypto";

import { PROMOTION_THRESHOLDS, ratingBandFor } from "./contract.js";
import {
  describeVerdict,
  evaluatePromotion,
  type HoldoutOutcome,
  type PromotionVerdict,
} from "./calibration.js";
import {
  DEFAULT_SAMPLING_POLICY,
  checkSplitRules,
  groupBySlice,
  manifestHash,
  type HoldoutPosition,
} from "./holdout.js";
import { MaiaEngine, MaiaUnavailableError, fileSha256, type MaiaNetwork } from "./maia.js";
import { Maia3Engine, Maia3UnavailableError } from "./maia3.js";

/**
 * Run a candidate human model against a frozen holdout and ask the gate.
 *
 * `npm run models:benchmark -- --corpus=holdout.jsonl --engine=... --weights=dir`
 *
 * The output of this script is a verdict, not a model. A refusal is a normal
 * result and is written out in the same shape as an approval, because the epic
 * that ships `unavailable` has to be able to show the evidence for it exactly as
 * the one that ships a promotion does.
 */

interface Args {
  adapter: "maia1" | "maia3";
  corpus: string;
  enginePath: string;
  weightsDir: string;
  bridgePath: string;
  checkpointPath: string;
  out: string;
  limit: number;
  trainingWindowEnd: string;
}

function parseArgs(argv: readonly string[]): Args {
  const map = new Map(
    argv.map((arg) => {
      const [key, value = "true"] = arg.replace(/^--/, "").split("=");
      return [key, value] as const;
    }),
  );
  const adapter = map.get("adapter") === "maia3" ? "maia3" : "maia1";
  return {
    adapter,
    corpus: map.get("corpus") ?? "holdout.jsonl",
    enginePath: map.get("engine") ?? (adapter === "maia3" ? "python3" : "lc0"),
    weightsDir: map.get("weights") ?? ".",
    bridgePath: map.get("bridge") ?? "maia3/bridge.py",
    checkpointPath: map.get("checkpoint") ?? "/opt/forma/maia3/maia3-5m.pt",
    out: map.get("out") ?? "benchmark-result.json",
    limit: Number(map.get("limit") ?? Number.POSITIVE_INFINITY),
    trainingWindowEnd:
      map.get("training-window-end") ??
      (adapter === "maia3" ? "2025-08-01T00:00:00Z" : "2020-01-01T00:00:00Z"),
  };
}

/** Discover `maia-<band>.pb.gz` files in a directory listing. */
export function networksFrom(paths: readonly string[]): MaiaNetwork[] {
  const networks: MaiaNetwork[] = [];
  for (const path of paths) {
    const match = /maia-(\d{3,4})\.pb\.gz$/.exec(basename(path));
    if (match) networks.push({ band: Number(match[1]), weightsPath: path });
  }
  return networks.sort((a, b) => a.band - b.band);
}

export interface BenchmarkReport {
  corpus: {
    path: string;
    positions: number;
    accounts: number;
    games: number;
    manifestSha256: string;
    samplingPolicy: string;
    accountDisjoint: boolean;
    chronologicalSplit: boolean;
    earliestPlayedAt: string | null;
  };
  model: {
    family?: "maia1" | "maia3";
    networks: { band: number; sha256: string; byteSize: number }[];
    engineSha256: string;
    engineByteSize: number;
    checkpoint?: { sha256: string; byteSize: number };
    bridge?: { sha256: string; byteSize: number };
  };
  verdict: PromotionVerdict;
  thresholds: typeof PROMOTION_THRESHOLDS;
  outputChecksum: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const raw = await readFile(args.corpus, "utf8");
  const positions: HoldoutPosition[] = raw
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as HoldoutPosition)
    .slice(0, args.limit);
  if (positions.length === 0) throw new Error(`${args.corpus} holds no positions`);

  const rules = checkSplitRules(positions, args.trainingWindowEnd);
  const hash = manifestHash(positions);

  const { readdir } = await import("node:fs/promises");
  const networks = args.adapter === "maia1"
    ? networksFrom((await readdir(args.weightsDir)).map((name) => `${args.weightsDir}/${name}`))
    : [];
  if (args.adapter === "maia1" && networks.length === 0) {
    throw new Error(`no maia-*.pb.gz weights in ${args.weightsDir}`);
  }

  console.log(`corpus     ${positions.length} positions, manifest ${hash.slice(0, 16)}`);
  console.log(
    args.adapter === "maia1"
      ? `networks   ${networks.map((n) => n.band).join(", ")}`
      : `model      Maia-3 5M (${args.checkpointPath})`,
  );
  console.log(`disjoint   ${rules.accountDisjoint}   chronological ${rules.chronologicalSplit}`);
  console.log("");

  const engine = args.adapter === "maia3"
    ? new Maia3Engine({
        pythonPath: args.enginePath,
        bridgePath: args.bridgePath,
        checkpointPath: args.checkpointPath,
      })
    : new MaiaEngine({ enginePath: args.enginePath, networks });
  const outcomes = new Map<string, HoldoutOutcome[]>();
  let done = 0;
  let failures = 0;

  try {
    // Grouped by slice so each network is warm for a contiguous run of
    // positions rather than being reloaded as ratings alternate.
    for (const [key, group] of [...groupBySlice(positions).entries()].sort()) {
      const list: HoldoutOutcome[] = [];
      for (const position of group.positions) {
        let predictedUci: string | null = null;
        let predictedProbability: number | null = null;
        let latencyMs: number | null = null;
        try {
          const inference = await engine.inferPolicy(position.fen, position.moverRating);
          const top = inference.policy.moves[0];
          if (top) {
            predictedUci = top.uci;
            predictedProbability = top.probability;
          }
          latencyMs = inference.latencyMs;
        } catch (error) {
          failures += 1;
          if (!(error instanceof MaiaUnavailableError) && !(error instanceof Maia3UnavailableError)) {
            throw error;
          }
        }
        list.push({
          accountKey: position.moverAccountKey,
          playedUci: position.playedUci,
          predictedUci,
          predictedProbability,
          latencyMs,
        });
        done += 1;
        if (done % 250 === 0) {
          process.stdout.write(`  ${done}/${positions.length} (${failures} failures)\n`);
        }
      }
      outcomes.set(key, list);
    }
  } finally {
    if (engine instanceof MaiaEngine) engine.close();
    else engine.stop();
  }

  const sliceInputs = [...groupBySlice(positions).entries()]
    .sort()
    .map(([key, group]) => {
      const band = ratingBandFor(group.bandLow)!;
      return {
        slice: { provider: group.provider, speed: group.speed, band },
        outcomes: outcomes.get(key) ?? [],
      };
    });

  const verdict = evaluatePromotion({
    slices: sliceInputs,
    dataset: {
      accountDisjoint: rules.accountDisjoint,
      chronologicalSplit: rules.chronologicalSplit,
      // The licence review is recorded in the database, not asserted here. The
      // benchmark reports what it measured; `models:promote` reads the review
      // and refuses without it.
      licenceCleared: true,
    },
  });

  const report: BenchmarkReport = {
    corpus: {
      path: args.corpus,
      positions: positions.length,
      accounts: new Set(positions.map((p) => p.moverAccountKey)).size,
      games: new Set(positions.map((p) => p.gameKey)).size,
      manifestSha256: hash,
      samplingPolicy: DEFAULT_SAMPLING_POLICY.version,
      accountDisjoint: rules.accountDisjoint,
      chronologicalSplit: rules.chronologicalSplit,
      earliestPlayedAt: rules.earliestPlayedAt,
    },
    model: {
      family: args.adapter,
      networks: await Promise.all(
        networks.map(async (n) => ({
          band: n.band,
          sha256: await fileSha256(n.weightsPath),
          byteSize: (await stat(n.weightsPath)).size,
        })),
      ),
      engineSha256: await fileSha256(args.enginePath),
      engineByteSize: (await stat(args.enginePath)).size,
      checkpoint: args.adapter === "maia3"
        ? {
            sha256: await fileSha256(args.checkpointPath),
            byteSize: (await stat(args.checkpointPath)).size,
          }
        : undefined,
      bridge: args.adapter === "maia3"
        ? {
            sha256: await fileSha256(args.bridgePath),
            byteSize: (await stat(args.bridgePath)).size,
          }
        : undefined,
    },
    verdict,
    thresholds: PROMOTION_THRESHOLDS,
    outputChecksum: "",
  };
  report.outputChecksum = createHash("sha256")
    .update(JSON.stringify({ ...report, outputChecksum: "" }))
    .digest("hex");

  await writeFile(args.out, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log("");
  console.log(describeVerdict(verdict));
  console.log("");
  console.log(
    `  ${"slice".padEnd(28)}${"n".padStart(6)}${"acct".padStart(6)}${"top1".padStart(8)}` +
      `${"ece".padStart(8)}${"brier".padStart(8)}${"p95ms".padStart(7)}  verdict`,
  );
  for (const slice of verdict.slices) {
    const m = slice.metrics;
    console.log(
      `  ${`${slice.slice.provider}:${slice.slice.speed}:${slice.slice.band.low}`.padEnd(28)}` +
        `${String(m.sampleSize).padStart(6)}${String(m.distinctAccounts).padStart(6)}` +
        `${fmt(m.top1Accuracy).padStart(8)}${fmt(m.expectedCalibrationError).padStart(8)}` +
        `${fmt(m.brierScore).padStart(8)}${String(m.latencyP95Ms ?? "-").padStart(7)}  ` +
        (slice.supported ? "supported" : slice.reasons.join("; ")),
    );
  }
  console.log("");
  console.log(`written to ${args.out}`);
  if (!verdict.promote) {
    console.log("");
    console.log("This is a result, not a failure. E14 completes with practical context");
    console.log("unavailable for every slice that did not pass.");
  }
}

function fmt(value: number | null): string {
  return value === null ? "-" : value.toFixed(3);
}

if (process.argv[1]?.endsWith("benchmark.ts")) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
