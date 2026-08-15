import { ANALYSIS_PROFILES, type AnalysisProfile } from "../engine/stockfish.js";
import { performance } from "node:perf_hooks";
import type {
  BenchmarkAdapter,
  BenchmarkGame,
  BenchmarkReport,
  BenchmarkSample,
  ProfileMetrics,
} from "./types.js";

export const DEFAULT_PROFILES: AnalysisProfile[] = [
  ANALYSIS_PROFILES.screening,
  ANALYSIS_PROFILES.deep,
];

export const COST_ASSUMPTIONS = {
  positionsPerGame: 60,
  deepAnalysisRate: 0.12,
  vCpuUsdPerSecond: 0.000018,
  gibUsdPerSecond: 0.000002,
  workerGiB: 1,
} as const;

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(fraction * sorted.length) - 1];
}

function distribution(values: number[]): { p50: number; p95: number } {
  return { p50: percentile(values, 0.5), p95: percentile(values, 0.95) };
}

function judgment(sample: BenchmarkSample): string {
  if (sample.mate !== undefined) return sample.mate > 0 ? "white-mates" : "black-mates";
  const score = sample.evalCp ?? 0;
  if (score >= 150) return "white-winning";
  if (score <= -150) return "black-winning";
  if (score >= 80) return "white-edge";
  if (score <= -80) return "black-edge";
  return "balanced";
}

const ratio = (matches: number, total: number) => total === 0 ? 0 : matches / total;

function metricsFor(
  profileId: string,
  samples: BenchmarkSample[],
  references: Map<string, BenchmarkSample>,
): ProfileMetrics {
  const comparisons = samples.filter(
    (sample) => sample.temperature === "warm" && references.has(sample.gameId),
  );
  const warm = samples.filter((sample) => sample.temperature === "warm").map((sample) => sample.elapsedMs);
  const cold = samples.filter((sample) => sample.temperature === "cold").map((sample) => sample.elapsedMs);
  const costPerMs = (COST_ASSUMPTIONS.vCpuUsdPerSecond
    + COST_ASSUMPTIONS.gibUsdPerSecond * COST_ASSUMPTIONS.workerGiB) / 1_000;
  const runtimes = samples.map((sample) => sample.elapsedMs);

  return {
    profileId,
    sampleCount: samples.length,
    runtimeMs: { all: distribution(runtimes), cold: distribution(cold), warm: distribution(warm) },
    costUsdPerPosition: {
      p50: distribution(runtimes).p50 * costPerMs,
      p95: distribution(runtimes).p95 * costPerMs,
    },
    bestMoveAgreement: ratio(
      comparisons.filter((sample) => sample.bestMove === references.get(sample.gameId)?.bestMove).length,
      comparisons.length,
    ),
    judgmentStability: ratio(
      comparisons.filter((sample) => judgment(sample) === judgment(references.get(sample.gameId)!)).length,
      comparisons.length,
    ),
    referenceMoveInCandidates: ratio(
      comparisons.filter((sample) => {
        const reference = references.get(sample.gameId)?.bestMove;
        return reference !== undefined && sample.candidateMoves.includes(reference);
      }).length,
      comparisons.length,
    ),
  };
}

export async function runBenchmark(
  adapter: BenchmarkAdapter,
  corpus: BenchmarkGame[],
  profiles: AnalysisProfile[] = DEFAULT_PROFILES,
): Promise<BenchmarkReport> {
  if (profiles.length < 2) throw new Error("Benchmark requires screening and reference profiles");
  const allSamples: BenchmarkSample[] = [];
  const coldSampleCount = Math.min(5, corpus.length);

  for (const profile of profiles) {
    // Cold latency is sampled from genuinely fresh worker processes/sessions.
    for (let index = 0; index < coldSampleCount; index++) {
      const coldStartedAt = performance.now();
      const session = await adapter.createSession();
      try {
        const game = corpus[index];
        const evaluation = await session.analyze(game.benchmarkFen, profile);
        allSamples.push({
          ...evaluation,
          // Include process startup, UCI/NNUE initialization and provenance
          // hashing. Engine-level elapsedMs intentionally measures search only.
          elapsedMs: Math.max(1, Math.round(performance.now() - coldStartedAt)),
          gameId: game.id,
          profileId: profile.id,
          temperature: "cold",
        });
      } finally {
        await session.close();
      }
    }

    const session = await adapter.createSession();
    try {
      for (let index = 0; index < corpus.length; index++) {
        const game = corpus[index];
        const evaluation = await session.analyze(game.benchmarkFen, profile);
        allSamples.push({
          ...evaluation,
          gameId: game.id,
          profileId: profile.id,
          temperature: "warm",
        });
      }
    } finally {
      await session.close();
    }
  }

  const referenceProfile = profiles.at(-1)!;
  const references = new Map(
    allSamples
      .filter((sample) => sample.profileId === referenceProfile.id && sample.temperature === "warm")
      .map((sample) => [sample.gameId, sample]),
  );
  const metrics = profiles.map((profile) => metricsFor(
    profile.id,
    allSamples.filter((sample) => sample.profileId === profile.id),
    references,
  ));
  const screening = metrics[0];
  const deep = metrics.at(-1)!;
  const regressions: string[] = [];
  if (screening.bestMoveAgreement < 0.75) regressions.push("screening best-move agreement below 75%");
  if (screening.judgmentStability < 0.85) regressions.push("screening judgment stability below 85%");

  const forecast = (games: 30 | 100 | 500, percentileName: "p50" | "p95") => {
    const screeningMs = screening.runtimeMs.warm[percentileName] * COST_ASSUMPTIONS.positionsPerGame;
    const deepMs = deep.runtimeMs.warm[percentileName]
      * COST_ASSUMPTIONS.positionsPerGame
      * COST_ASSUMPTIONS.deepAnalysisRate;
    const usdPerMs = (COST_ASSUMPTIONS.vCpuUsdPerSecond
      + COST_ASSUMPTIONS.gibUsdPerSecond * COST_ASSUMPTIONS.workerGiB) / 1_000;
    return games * (screeningMs + deepMs) * usdPerMs;
  };

  return {
    generatedAt: new Date().toISOString(),
    adapter: adapter.name,
    corpusGames: corpus.length,
    profiles: metrics,
    recommended: { screening: profiles[0].id, deep: referenceProfile.id },
    assumptions: { ...COST_ASSUMPTIONS },
    forecasts: ([30, 100, 500] as const).map((games) => ({
      games,
      estimatedUsdP50: forecast(games, "p50"),
      estimatedUsdP95: forecast(games, "p95"),
    })),
    regressions,
  };
}

export function formatMarkdownReport(report: BenchmarkReport): string {
  const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
  const usd = (value: number) => `$${value.toFixed(4)}`;
  const microUsd = (value: number) => `$${value.toFixed(6)}`;
  const lines = [
    "# Forma engine quality-cost benchmark",
    "",
    `Generated: ${report.generatedAt}`,
    `Adapter: ${report.adapter}`,
    `Corpus: ${report.corpusGames} games`,
    "",
    "| Profile | Samples | Warm P50 | Warm P95 | Cold P50 | Cold P95 | Best move | Judgment | Ref move in candidates | P50 cost/position | P95 cost/position |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...report.profiles.map((profile) =>
      `| ${profile.profileId} | ${profile.sampleCount} | ${profile.runtimeMs.warm.p50} ms | ${profile.runtimeMs.warm.p95} ms | ${profile.runtimeMs.cold.p50} ms | ${profile.runtimeMs.cold.p95} ms | ${percent(profile.bestMoveAgreement)} | ${percent(profile.judgmentStability)} | ${percent(profile.referenceMoveInCandidates)} | ${microUsd(profile.costUsdPerPosition.p50)} | ${microUsd(profile.costUsdPerPosition.p95)} |`),
    "",
    `Recommendation: screening **${report.recommended.screening}**, deep **${report.recommended.deep}**.`,
    "",
    "## Import cost forecast",
    "",
    `Assumes ${report.assumptions.positionsPerGame} positions/game, ${(report.assumptions.deepAnalysisRate * 100).toFixed(0)}% deep-analysis rate, one vCPU and ${report.assumptions.workerGiB} GiB memory.`,
    "",
    "| Games | P50 | P95 |",
    "|---:|---:|---:|",
    ...report.forecasts.map((row) => `| ${row.games} | ${usd(row.estimatedUsdP50)} | ${usd(row.estimatedUsdP95)} |`),
    "",
    "## Regression gates",
    "",
    report.regressions.length ? report.regressions.map((item) => `- FAIL: ${item}`).join("\n") : "All quality gates passed.",
    "",
  ];
  return lines.join("\n");
}
