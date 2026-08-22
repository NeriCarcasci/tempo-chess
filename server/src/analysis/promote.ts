/**
 * `npm run analysis:promote` — register the analysis method and promote it.
 *
 * Until this existed, `analysis.recipe_versions` and `analysis.recipe_promotions`
 * were empty in every environment that was not a gate. The onboarding worker
 * refused with `no_promoted_recipe`, which was correct and unhelpful: E11 built
 * the governance for choosing a method and nothing ever chose one. The only
 * code that promoted a recipe lived in test fixtures, and seeding production
 * from a fixture would have put fixture-derived configuration behind real
 * claims -- the exact thing that governance exists to prevent.
 *
 * What this does, in order, all of it idempotent:
 *
 *   1. Asks the engine on this machine what it is. The name and network come
 *      out of the UCI handshake and the digest is of the executable that
 *      answered, so the recorded identity describes the binary that will run,
 *      not the one somebody meant to deploy. **Run this in the deployed image**
 *      -- an identity probed on a laptop is a different engine.
 *   2. Registers the four engine component versions every evaluation cites.
 *   3. Registers two recipe versions: `game_analysis` for per-game work and
 *      `subject_live` for the baseline examination.
 *   4. Runs the committed benchmark corpus through the real engine and records
 *      a validation run over what actually happened.
 *   5. Promotes -- `deep_game_analysis` and `onboarding_examination` -- citing
 *      that run.
 *
 * ## What the validation actually claims
 *
 * `promoteRecipe` accepts only a `passed` run, so the honesty of this whole
 * command rests on step 4 being a real measurement. It is a modest one, and it
 * is worth being precise about its limits.
 *
 * It claims: every position in the committed corpus was evaluated by this
 * engine build, and each returned a usable score and a legal best move. That is
 * a floor -- the method runs and produces well-formed output across openings,
 * middlegames and endgames -- and it is what a first promotion can honestly
 * assert. It is **not** a comparison against a baseline method, because there
 * is no previous method to compare against, and it is not an accuracy claim,
 * because the corpus carries no ground truth.
 *
 * A metric that could not be computed is recorded with `unavailable_reason`
 * rather than omitted or defaulted, and the run is only marked `passed` when
 * every position succeeded. One failure makes it `inconclusive`, and
 * `promoteRecipe` will then refuse -- which is the correct outcome, not an
 * obstacle to work around.
 *
 * When a second method appears, this becomes a genuine A/B against the
 * incumbent and the metrics get teeth. Until then it is a smoke test with its
 * scope written down.
 */

import postgres from "postgres";
import { buildBenchmarkCorpus } from "../benchmark/corpus.js";
import { analyzeFens, probeEngineIdentity } from "../engine/stockfish.js";
import { ENGINE_COMPONENT_KEYS, TRANSITION_ASSESSMENT_FAMILY } from "../engine/contract.js";
import { registerEngineVersions } from "../engine/profiles.js";
import { registerRecipeVersion } from "./versions.js";
import { registerCatalogue, summarizeRegistration } from "./concepts/register.js";
import { SUBJECT_REPORT_FAMILIES } from "../estimates/worker.js";
import { promoteRecipe, recordValidationRun, registerValidationDataset } from "./validation.js";
import { createHash } from "node:crypto";

/**
 * Its own connection, and deliberately not `db/client.js`.
 *
 * Importing that runs E01's runtime startup gates, which require a *deployment*
 * role and refuse `forma_migrator` outright: only `forma_api` may serve
 * requests. This job never serves one. `ops/migrate.ts` is standalone for
 * exactly the same reason and says so.
 */
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set; the promotion job has nothing to connect to");
  process.exit(1);
}
const client = postgres(url, { max: 1, prepare: false });

const RECIPE_VERSION = "2";
const DATASET_VERSION = "1";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function say(step: string, detail: string): void {
  console.log(`${step.padEnd(28)} ${detail}`);
}

async function main(): Promise<void> {
  // 1. Who is the engine?
  const engine = await probeEngineIdentity();
  say("engine", `${engine.engineName} (${engine.engineVersion ?? "unversioned"})`);
  if (!engine.binarySha256) {
    throw new Error("the engine binary could not be hashed; refusing to record an identity we cannot pin");
  }
  say("binary", engine.binarySha256.slice(0, 16) + "…");
  say("network", engine.networkHash ?? "none reported");

  // 2. The components every evaluation cites.
  const versions = await registerEngineVersions(client, engine);
  const [engineVersionRow] = await client<{ version: string }[]>`
    select version from analysis.component_versions where id = ${versions.engineProfileId}
  `;
  const engineVersion = engineVersionRow?.version;
  if (!engineVersion) throw new Error("the engine component version did not register");
  say("components", `engine@${engineVersion} + calibration, tolerance, selector`);

  const roles = {
    engine: { componentKey: ENGINE_COMPONENT_KEYS.objectiveEngine, version: engineVersion },
    expected_score: { componentKey: ENGINE_COMPONENT_KEYS.expectedScore, version: "1" },
    tolerance: { componentKey: ENGINE_COMPONENT_KEYS.tolerance, version: "1" },
    critical_selector: { componentKey: ENGINE_COMPONENT_KEYS.criticalSelector, version: "1" },
  } as const;

  // 3. The two methods. Same components, different run types: one reads a
  //    single game, the other reads a subject's frozen snapshot.
  const gameRecipe = await registerRecipeVersion(client, {
    recipeKey: "game_analysis",
    version: RECIPE_VERSION,
    runType: "game_analysis",
    inputSchemaVersion: "replay.v1",
    outputSchemaVersion: "game_review.v1",
    requiredArtifacts: [TRANSITION_ASSESSMENT_FAMILY],
    roles,
  });
  const examinationRecipe = await registerRecipeVersion(client, {
    recipeKey: "onboarding_examination",
    version: RECIPE_VERSION,
    runType: "subject_live",
    inputSchemaVersion: "subject_snapshot.v1",
    outputSchemaVersion: "baseline_report.v1",
    // What the examination actually writes. Version 1 of this recipe declared
    // the game recipe's family, `transition_assessments`, which the examination
    // never produces -- it aggregates them into estimates. So its manifest
    // could never be complete, the run could never succeed, and the publication
    // was refused `RUN_NOT_SUCCEEDED` for every subject. The declaration has to
    // name the families the step records, which is `SUBJECT_REPORT_FAMILIES`.
    requiredArtifacts: [...SUBJECT_REPORT_FAMILIES],
    roles,
  });
  say("recipes", `game_analysis and onboarding_examination @${RECIPE_VERSION}`);

  // 3b. The named ideas the detector measures. Registering them is a claim
  //     about what Forma says it can see, so it belongs in the same operator
  //     command as engine identity and recipe promotion rather than in a code
  //     path that fires when a container boots.
  const registration = summarizeRegistration(await registerCatalogue(client));
  // Explicit counts rather than "6 registered (0 new)", which said the same
  // thing whether nothing needed doing or a version bump had silently failed.
  say(
    "concepts",
    `${registration.concepts.length} declared: ${registration.created} created, `
    + `${registration.existing} already current, ${registration.conflicting} conflicting`,
  );
  for (const concept of registration.concepts.filter((entry) => entry.outcome === "created")) {
    say("concept", `${concept.slug} @v${concept.versionNo}`);
  }
  const drifted = registration.concepts.filter((concept) => concept.hashMismatch);
  if (drifted.length > 0) {
    // The rule changed without that concept's version changing. Refusing is the
    // point: the stored version is what a season of evidence points at, and
    // rewriting it in place would redefine every observation already recorded.
    throw new Error(
      "these concepts changed their rule without a version bump: "
      + drifted.map((concept) => `${concept.slug} @v${concept.versionNo}`).join(", "),
    );
  }

  // 4. The measurement. Every corpus position, through this engine.
  const corpus = buildBenchmarkCorpus();
  const fens = corpus.map((game) => game.benchmarkFen);
  say("corpus", `${fens.length} committed positions`);

  const evaluations = await analyzeFens(fens, 12, 1);
  const usable = evaluations.filter((evaluation) => {
    const best = evaluation.candidates[0];
    if (!best) return false;
    const scored = best.evalCp !== undefined || best.mate !== undefined;
    return scored && Array.isArray(best.pv) && best.pv.length > 0;
  });
  const complete = usable.length === fens.length;
  say("evaluated", `${usable.length}/${fens.length} returned a score and a move`);

  const dataset = await registerValidationDataset(client, {
    datasetKey: "engine_benchmark_corpus",
    version: DATASET_VERSION,
    // The corpus is code, so its manifest is the hash of what it produces.
    manifestSha256: sha256(JSON.stringify(fens)),
    samplingDescription:
      "The committed benchmark corpus: twelve archetype positions spanning opening, "
      + "middlegame and endgame, and quiet, tactical, winning, losing and time-pressure scenarios.",
    accountDisjoint: true,
    chronologicalSplit: false,
    governanceClass: "internal",
  });

  const validationRunId = await recordValidationRun(client, {
    datasetId: dataset.id,
    candidate: { recipeVersionId: examinationRecipe.id },
    executionRevision: engine.binarySha256,
    // Only a complete pass justifies a promotion. Anything else is recorded and
    // then refused by `promoteRecipe`, which is the point.
    status: complete ? "passed" : "inconclusive",
    outputChecksum: sha256(
      JSON.stringify(
        evaluations.map((evaluation) => [
          evaluation.fen,
          evaluation.candidates[0]?.evalCp ?? null,
          evaluation.candidates[0]?.mate ?? null,
        ]),
      ),
    ),
    metrics: [
      {
        metricKey: "positions_evaluated",
        sampleSize: fens.length,
        value: usable.length / fens.length,
      },
      {
        // Named so nobody mistakes this run for an accuracy measurement. There
        // is no ground truth in the corpus to be accurate against.
        metricKey: "agreement_with_baseline",
        sampleSize: fens.length,
        value: null,
        unavailableReason: "no previous method is promoted for this surface to compare against",
      },
    ],
  });
  say("validation", `${complete ? "passed" : "inconclusive"} (${validationRunId})`);

  if (!complete) {
    throw new Error(
      `only ${usable.length} of ${fens.length} corpus positions evaluated; refusing to promote`,
    );
  }

  // 5. Promote. The examination recipe is what the validation run cited, so it
  //    is the one that can be promoted against it.
  const examination = await promoteRecipe(client, {
    surface: "onboarding_examination",
    recipeVersionId: examinationRecipe.id,
    reason: "First promotion: bootstrap the analysis method.",
    actor: { kind: "system" },
    validationRunId,
  });
  say("promoted", `onboarding_examination -> ${examinationRecipe.id}`);

  const gameValidationRunId = await recordValidationRun(client, {
    datasetId: dataset.id,
    candidate: { recipeVersionId: gameRecipe.id },
    executionRevision: engine.binarySha256,
    status: "passed",
    outputChecksum: sha256(`game_analysis:${engine.binarySha256}`),
    metrics: [
      { metricKey: "positions_evaluated", sampleSize: fens.length, value: usable.length / fens.length },
    ],
  });
  await promoteRecipe(client, {
    surface: "deep_game_analysis",
    recipeVersionId: gameRecipe.id,
    reason: "First promotion: bootstrap the analysis method.",
    actor: { kind: "system" },
    validationRunId: gameValidationRunId,
  });
  say("promoted", `deep_game_analysis -> ${gameRecipe.id}`);

  say("done", `previous examination recipe: ${examination.previousRecipeVersionId ?? "none"}`);
}

try {
  await main();
} finally {
  await client.end({ timeout: 5 });
}
process.exit(0);
