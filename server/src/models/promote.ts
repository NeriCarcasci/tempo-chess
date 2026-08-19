import { readFile } from "node:fs/promises";

import postgres from "postgres";

import { SupabaseArtifactStore } from "../artifacts/store.js";
import { storeArtifact } from "../artifacts/lifecycle.js";

import { describeVerdict } from "./calibration.js";
import type { BenchmarkReport } from "./benchmark.js";
import { recordLifecycle, recordValidation, registerHumanModel, resolvePromotedHumanModel } from "./store.js";

/**
 * Turn a benchmark report into the record of a decision.
 *
 * `npm run models:promote -- --report=benchmark-result.json [--apply]`
 *
 * Without `--apply` it prints what it would write and exits. With it, the
 * registration, the evidence and the lifecycle move are written in the order
 * the schema requires: licence review, model, assets, profile, dataset,
 * validation run, metrics, calibration slices, and only then the pointer.
 *
 * The pointer moves only when the verdict says so. A refused candidate still
 * gets its evidence and a `shadow` event naming the blockers, because the
 * difference between "measured and did not qualify" and "nobody looked" is the
 * whole value of keeping the record.
 */

const MAIA_LICENCE = {
  spdx: "GPL-3.0",
  sourceUrl: "https://github.com/CSSLab/maia-chess",
  obligations:
    "Copyleft. Forma runs the published networks through an unmodified Lc0 binary as a separate process over UCI and does not link against either, so no combined work is created. Nothing is redistributed; if Forma ever ships the binary or the weights, the corresponding source must be offered under the same licence. Attribution to CSSLab is kept with the asset records.",
  distributionPosture: "server_side_only" as const,
  reviewer: "forma-platform",
  decision: "cleared" as const,
  note: "Maia-family weights, licence-reviewed as platform spec 12.1 requires before promotion.",
};

async function main(): Promise<void> {
  const args = new Map(
    process.argv.slice(2).map((arg) => {
      const [key, value = "true"] = arg.replace(/^--/, "").split("=");
      return [key, value] as const;
    }),
  );
  const reportPath = args.get("report") ?? "benchmark-result.json";
  const apply = args.get("apply") === "true";
  const modelVersion = args.get("version") ?? "maia-1.0";
  const datasetKey = args.get("dataset-key") ?? "lichess_public_holdout";
  const datasetVersion = args.get("dataset-version") ?? "1";
  const corpusPath = args.get("corpus") ?? null;

  const report = JSON.parse(await readFile(reportPath, "utf8")) as BenchmarkReport;
  const verdict = report.verdict;

  console.log(describeVerdict(verdict));
  console.log(`corpus     ${report.corpus.positions} positions, ${report.corpus.accounts} accounts`);
  console.log(`manifest   ${report.corpus.manifestSha256}`);
  console.log(`networks   ${report.model.networks.map((n) => n.band).join(", ")}`);
  console.log(`supported  ${verdict.supportedSliceCount} of ${verdict.slices.length} slices`);
  if (!apply) {
    console.log("\nnothing written: pass --apply to record this.");
    return;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const sql = postgres(databaseUrl, { max: 2, prepare: false, onnotice: () => {} });

  try {
    const model = await registerHumanModel(sql, {
      version: modelVersion,
      assets: [
        {
          kind: "binary",
          sha256: report.model.engineSha256,
          byteSize: report.model.engineByteSize,
          sourceUrl: "https://github.com/LeelaChessZero/lc0/releases",
        },
        ...report.model.networks.map((network) => ({
          kind: "weights" as const,
          sha256: network.sha256,
          byteSize: network.byteSize,
          sourceUrl: `https://github.com/CSSLab/maia-chess/raw/master/maia_weights/maia-${network.band}.pb.gz`,
        })),
      ],
      licence: MAIA_LICENCE,
      provenance:
        `CSSLab maia-chess maia_weights (bands ${report.model.networks.map((n) => n.band).join(", ")}), ` +
        "executed through Lc0 at one node with policy softmax temperature 1.0.",
    });
    console.log(`model      ${model.componentVersionId}`);

    // The corpus is not reproducible from a public API: arena games roll off
    // and a manifest hash nobody can check a body against proves nothing. So
    // the body itself is stored, once, addressed by its own digest.
    const artifactId = corpusPath === null ? null : await uploadCorpus(sql, corpusPath);
    if (artifactId) console.log(`corpus     stored as artifact ${artifactId}`);

    await recordLifecycle(sql, {
      componentVersionId: model.componentVersionId,
      fromState: null,
      toState: "draft",
      validationRunId: null,
      reason: `registered from ${reportPath}`,
    }).catch(() => {
      // Already registered by an earlier run. The lifecycle is append-only and
      // a second draft event would be noise, not history.
    });

    const recorded = await recordValidation(
      sql,
      {
        datasetKey,
        datasetVersion,
        manifestSha256: report.corpus.manifestSha256,
        samplingDescription:
          `Public Lichess games sampled by ${report.corpus.samplingPolicy}: rated standard blitz and rapid, ` +
          `plies 10-120, at most 8 positions per game, thinned by hash. ${report.corpus.positions} positions ` +
          `from ${report.corpus.games} games and ${report.corpus.accounts} accounts, earliest ` +
          `${report.corpus.earliestPlayedAt}. Account-disjoint between slices. Chronologically after the ` +
          "published Maia training window; disjointness from Maia's own training accounts is not verifiable " +
          "from a public model and is not claimed.",
        accountDisjoint: report.corpus.accountDisjoint,
        chronologicalSplit: report.corpus.chronologicalSplit,
        licence: "CC0-1.0 (lichess.org game database)",
        governanceClass: "public",
        executionRevision: process.env.GIT_SHA ?? "local",
        outputChecksum: report.outputChecksum,
        modelComponentVersionId: model.componentVersionId,
        calibrationComponentVersionId: model.calibrationVersionId,
        artifactId,
      },
      verdict,
    );
    console.log(`dataset    ${recorded.datasetId}`);
    console.log(`validation ${recorded.validationRunId}`);
    console.log(`slices     ${recorded.supportedSliceIds.length} supported rows written`);

    const alreadyPromoted = await resolvePromotedHumanModel(sql);
    if (verdict.promote) {
      await recordLifecycle(sql, {
        componentVersionId: model.componentVersionId,
        fromState: alreadyPromoted === model.componentVersionId ? "production" : "draft",
        toState: "validated",
        validationRunId: recorded.validationRunId,
        reason: `${verdict.supportedSliceCount} slices passed over ${verdict.totalSampleSize} positions`,
      });
      await recordLifecycle(sql, {
        componentVersionId: model.componentVersionId,
        fromState: "validated",
        toState: "production",
        validationRunId: recorded.validationRunId,
        reason: "promoted: practical context is available on the supported slices only",
      });
      console.log("promoted   pointer moved to production");
    } else {
      await recordLifecycle(sql, {
        componentVersionId: model.componentVersionId,
        fromState: "draft",
        toState: "shadow",
        validationRunId: recorded.validationRunId,
        reason: `not promoted: ${verdict.blockers.join("; ")}`,
      });
      console.log("shadow     not promoted; every slice answers unavailable");
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Store the holdout body in the private system bucket, deduplicated by digest. */
async function uploadCorpus(sql: postgres.Sql, path: string): Promise<string | null> {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    console.warn("corpus     not uploaded: SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are unset");
    return null;
  }
  const body = new Uint8Array(await readFile(path));
  const stored = await storeArtifact(sql, new SupabaseArtifactStore({ url, serviceKey }), {
    retentionClass: "system_immutable",
    body,
    mediaType: "application/x-ndjson",
    extension: "jsonl",
    artifactKind: "validation_holdout",
    sourceReference: "lichess public games, CC0",
  });
  return stored.id;
}

if (process.argv[1]?.endsWith("promote.ts")) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
