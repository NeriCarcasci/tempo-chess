/**
 * `npm run analysis:integration` — E11 against a real database.
 *
 * What this proves that a unit test cannot: that the dependency DAG really
 * refuses a cycle at insert, that a partial run really cannot be published,
 * that publication really is one atomic pointer move with history behind it,
 * that a rollback really restores the earlier run without deleting anything,
 * that a baseline really stays pinned while the live pointer advances, and that
 * the immutability triggers really refuse a rewrite rather than documenting one.
 *
 * These are database claims. A stub of `on conflict` or of a `before update`
 * trigger is a stub of the exact behaviour the design rests on, so everything
 * here runs against a disposable cluster created for the command and destroyed
 * when it ends.
 */

import { strict as assert } from "node:assert";
import { GateReport, startAnalysisHarness } from "./harness.js";
import {
  recordGoldenManifest,
  seedGoldenVersions,
  seedSubject,
  REQUIRED_ARTIFACTS,
  SHA,
} from "../fixtures.js";
import { registerComponent, registerComponentVersion, registerRecipeVersion, validateRecipe } from "../versions.js";
import { freezeSubjectSnapshot, registerCohortVersion, verifySnapshotHash } from "../snapshots.js";
import { GOLDEN_COHORT } from "../fixtures.js";
import { cancelRun, completeRun, failRun, planReuse, planRun, readRun, recordArtifact, startRun } from "../runs.js";
import {
  publishSubjectGame,
  publishSubjectLive,
  rollbackSubjectLive,
  subjectLiveHistory,
  subjectLiveVersionBlock,
} from "../publication.js";
import {
  currentLifecycleState,
  promoteRecipe,
  promotionHistory,
  recordLifecycleTransition,
  recordValidationRun,
  registerValidationDataset,
  rollbackRecipePromotion,
} from "../validation.js";
import { materializationHistory, publishRun, rollbackMaterialization } from "../../positions/materialize.js";
import { setAnalysisEventSink } from "../telemetry.js";

const report = new GateReport("E11 analysis versioning integration gate");
const harness = await startAnalysisHarness();
const sql = harness.sql;

const events: string[] = [];
setAnalysisEventSink((line) => events.push(line));

const SUFFIX = `g${Date.now().toString(36)}`;
const golden = await seedGoldenVersions(sql, SUFFIX);
const subject = await seedSubject(sql, { games: 3 });
const other = await seedSubject(sql, { games: 1 });
const CUTOFF = new Date().toISOString();
const SYSTEM = { kind: "system" as const };

try {
  // --- the version graph ----------------------------------------------------

  report.section("component and recipe versions");

  await report.check("registering the same component twice is one row", async () => {
    const first = await registerComponent(sql, {
      componentKey: `dup_${SUFFIX}`,
      category: "renderer",
      description: "Explanation renderer",
      inputContract: "finding.v1",
      outputContract: "prose.v1",
    });
    const second = await registerComponent(sql, {
      componentKey: `dup_${SUFFIX}`,
      category: "renderer",
      description: "Explanation renderer",
      inputContract: "finding.v1",
      outputContract: "prose.v1",
    });
    assert.equal(first, second);
  });

  await report.check("a component's meaning cannot be edited under a run that cited it", async () => {
    await assert.rejects(
      registerComponent(sql, {
        componentKey: `dup_${SUFFIX}`,
        category: "renderer",
        description: "Explanation renderer",
        inputContract: "finding.v1",
        outputContract: "prose.v2",
      }),
      /different attributes/,
    );
    await assert.rejects(
      sql`update analysis.components set description = 'edited' where component_key = ${`dup_${SUFFIX}`}`,
      /immutable/,
    );
  });

  await report.check("re-registering identical version content returns the same row", async () => {
    const again = await registerComponentVersion(sql, {
      componentKey: `estimator_${SUFFIX}`,
      version: "1",
      implementationSha256: SHA(`estimator_${SUFFIX}-1`),
      configuration: { halfLifeDays: 90 },
      deterministic: true,
      dependencies: [{ componentKey: `engine_${SUFFIX}`, version: "1", requiredContract: "position_evaluation.v1" }],
    });
    assert.equal(again.alreadyRegistered, true);
    assert.equal(again.id, golden.estimatorV1Id);
  });

  await report.check("the same version number with different content is refused", async () => {
    await assert.rejects(
      registerComponentVersion(sql, {
        componentKey: `estimator_${SUFFIX}`,
        version: "1",
        implementationSha256: SHA("something else entirely"),
        deterministic: true,
      }),
      /already exists with different content/,
    );
  });

  await report.check("model weights without a licence cannot be registered", async () => {
    await assert.rejects(
      registerComponentVersion(sql, {
        componentKey: `estimator_${SUFFIX}`,
        version: "unlicensed",
        implementationSha256: SHA("weights"),
        modelIdentity: { family: "maia", revision: "1900" },
        deterministic: false,
      }),
      /must declare a licence/,
    );
    // And the database refuses it too, so bypassing the helper does not help.
    await assert.rejects(
      sql`
        insert into analysis.component_versions (
          component_id, version, implementation_sha256, configuration_hash, content_hash,
          model_identity, deterministic
        ) select id, 'raw', ${SHA("a")}, ${SHA("b")}, ${SHA("c")}, '{"family":"maia"}'::jsonb, false
        from analysis.components where component_key = ${`estimator_${SUFFIX}`}
      `,
      /component_versions_model_needs_licence/,
    );
  });

  await report.check("a dependency cycle is refused at insert", async () => {
    await assert.rejects(
      sql`
        insert into analysis.component_version_dependencies (
          dependent_version_id, dependency_version_id, required_contract
        ) values (
          (select cv.id from analysis.component_versions cv
             join analysis.components c on c.id = cv.component_id
            where c.component_key = ${`engine_${SUFFIX}`} and cv.version = '1'),
          ${golden.estimatorV1Id}, 'skill_estimate.v1'
        )
      `,
      /cycle/,
    );
  });

  await report.check("a self-dependency is refused", async () => {
    await assert.rejects(
      sql`
        insert into analysis.component_version_dependencies (
          dependent_version_id, dependency_version_id, required_contract
        ) values (${golden.estimatorV1Id}, ${golden.estimatorV1Id}, 'skill_estimate.v1')
      `,
      /component_dependencies_no_self/,
    );
  });

  await report.check("an incompatible dependency contract rejects the recipe", async () => {
    await registerComponent(sql, {
      componentKey: `bad_${SUFFIX}`,
      category: "estimator",
      description: "Estimator expecting a contract the engine does not emit",
      inputContract: "position_evaluation.v2",
      outputContract: "skill_estimate.v1",
    });
    const bad = await registerComponentVersion(sql, {
      componentKey: `bad_${SUFFIX}`,
      version: "1",
      implementationSha256: SHA(`bad_${SUFFIX}`),
      deterministic: true,
      dependencies: [
        { componentKey: `engine_${SUFFIX}`, version: "1", requiredContract: "position_evaluation.v2" },
      ],
    });
    const validation = await validateRecipe(sql, { estimator: bad.id });
    assert.equal(validation.valid, false);
    assert.match(validation.problems[0], /requires position_evaluation\.v2 but .* emits position_evaluation\.v1/);

    await assert.rejects(
      registerRecipeVersion(sql, {
        recipeKey: `broken_${SUFFIX}`,
        version: "1",
        runType: "subject_live",
        inputSchemaVersion: "subject_snapshot.v1",
        outputSchemaVersion: "subject_live.v1",
        requiredArtifacts: ["skill_estimates"],
        roles: { estimator: { componentKey: `bad_${SUFFIX}`, version: "1" } },
      }),
      /is invalid/,
    );
    const [written] = await sql<{ count: string }[]>`
      select count(*)::text as count from analysis.recipe_versions where recipe_key = ${`broken_${SUFFIX}`}
    `;
    assert.equal(written.count, "0", "a rejected recipe must not exist");
  });

  await report.check("registering the same recipe pins twice is one manifest", async () => {
    const again = await registerRecipeVersion(sql, {
      recipeKey: `live_${SUFFIX}`,
      version: "1",
      runType: "subject_live",
      inputSchemaVersion: "subject_snapshot.v1",
      outputSchemaVersion: "subject_live.v1",
      requiredArtifacts: REQUIRED_ARTIFACTS,
      roles: {
        normalizer: { componentKey: `norm_${SUFFIX}`, version: "1" },
        engine: { componentKey: `engine_${SUFFIX}`, version: "1" },
        estimator: { componentKey: `estimator_${SUFFIX}`, version: "1" },
      },
    });
    assert.equal(again.alreadyRegistered, true);
    assert.equal(again.id, golden.baselineRecipeId);
  });

  // --- snapshots ------------------------------------------------------------

  report.section("frozen subject snapshots");

  let snapshotId = "";

  await report.check("freezing pins every game's revision and materialization run", async () => {
    const frozen = await freezeSubjectSnapshot(sql, {
      subjectId: subject.subjectId,
      cohortVersionId: golden.cohortVersionId,
      cutoff: CUTOFF,
    });
    snapshotId = frozen.id;
    assert.equal(frozen.gameCount, 3);
    assert.equal(frozen.underCovered, false);
    const pinned = await sql<{ replay_revision_id: string; materialization_run_id: string }[]>`
      select replay_revision_id, materialization_run_id
      from analysis.subject_data_snapshot_games where snapshot_id = ${frozen.id}
      order by subject_game_id
    `;
    assert.equal(pinned.length, 3);
    assert.ok(pinned.every((row) => row.materialization_run_id));
  });

  await report.check("freezing the same cohort and cutoff again is the same snapshot", async () => {
    const again = await freezeSubjectSnapshot(sql, {
      subjectId: subject.subjectId,
      cohortVersionId: golden.cohortVersionId,
      cutoff: CUTOFF,
    });
    assert.equal(again.alreadyFrozen, true);
    assert.equal(again.id, snapshotId);
  });

  await report.check("a stored snapshot hash recomputes from its own manifest", async () => {
    const verification = await verifySnapshotHash(sql, snapshotId);
    assert.equal(verification.matches, true, verification.recomputed);
  });

  await report.check("a frozen manifest cannot be edited", async () => {
    await assert.rejects(
      sql`delete from analysis.subject_data_snapshot_games where snapshot_id = ${snapshotId}`,
      /immutable/,
    );
    await assert.rejects(
      sql`update analysis.subject_data_snapshots set game_count = 99 where id = ${snapshotId}`,
      /immutable/,
    );
  });

  await report.check("unknown rated is not treated as rated", async () => {
    const unknown = await seedSubject(sql, { games: 2, rated: null });
    const frozen = await freezeSubjectSnapshot(sql, {
      subjectId: unknown.subjectId,
      cohortVersionId: golden.cohortVersionId,
      cutoff: CUTOFF,
    });
    assert.equal(frozen.gameCount, 0, "a null rated flag must not satisfy rated: 'rated'");
    assert.equal(frozen.underCovered, true, "an empty snapshot below the floor is under-covered");
  });

  await report.check("a game with no published materialization is not analysable", async () => {
    const unpublished = await seedSubject(sql, { games: 2, publishMaterialization: false });
    const frozen = await freezeSubjectSnapshot(sql, {
      subjectId: unpublished.subjectId,
      cohortVersionId: golden.cohortVersionId,
      cutoff: CUTOFF,
    });
    assert.equal(frozen.gameCount, 0, "an unpublished chain is not evidence");
  });

  await report.check("a bot opponent is excluded unless the cohort asks for one", async () => {
    const bots = await seedSubject(sql, { games: 2, isBot: true });
    const permissive = await registerCohortVersion(sql, {
      cohortKey: `bots_${SUFFIX}`,
      version: "1",
      definition: { ...GOLDEN_COHORT, includeBotOpponents: true, minGames: 0 },
    });
    const strict = await freezeSubjectSnapshot(sql, {
      subjectId: bots.subjectId,
      cohortVersionId: golden.cohortVersionId,
      cutoff: CUTOFF,
    });
    assert.equal(strict.gameCount, 0);
    const loose = await freezeSubjectSnapshot(sql, {
      subjectId: bots.subjectId,
      cohortVersionId: permissive.id,
      cutoff: CUTOFF,
    });
    assert.equal(loose.gameCount, 2);
  });

  // --- runs -----------------------------------------------------------------

  report.section("runs and manifest validation");

  let firstRunId = "";

  await report.check("planning identical inputs twice yields one run", async () => {
    const planned = await planRun(sql, {
      recipeVersionId: golden.baselineRecipeId,
      scope: { subjectId: subject.subjectId, subjectDataSnapshotId: snapshotId },
      trigger: "scheduled",
      actor: SYSTEM,
    });
    firstRunId = planned.id;
    assert.equal(planned.alreadyPlanned, false);

    const again = await planRun(sql, {
      recipeVersionId: golden.baselineRecipeId,
      scope: { subjectId: subject.subjectId, subjectDataSnapshotId: snapshotId },
      trigger: "scheduled",
      actor: SYSTEM,
    });
    assert.equal(again.alreadyPlanned, true);
    assert.equal(again.id, firstRunId);
  });

  await report.check("concurrent planners produce one run, not two", async () => {
    const concurrentSnapshot = await freezeSubjectSnapshot(sql, {
      subjectId: other.subjectId,
      cohortVersionId: golden.cohortVersionId,
      cutoff: CUTOFF,
    });
    const plans = await Promise.all(
      [0, 1, 2, 3].map(() =>
        planRun(sql, {
          recipeVersionId: golden.baselineRecipeId,
          scope: { subjectId: other.subjectId, subjectDataSnapshotId: concurrentSnapshot.id },
          trigger: "scheduled",
          actor: SYSTEM,
        }),
      ),
    );
    assert.equal(new Set(plans.map((plan) => plan.id)).size, 1);
  });

  await report.check("a run cannot cite another subject's game", async () => {
    await assert.rejects(
      planRun(sql, {
        recipeVersionId: golden.baselineRecipeId,
        scope: { subjectId: subject.subjectId, subjectDataSnapshotId: snapshotId, subjectGameId: other.games[0].subjectGameId },
        trigger: "scheduled",
        actor: SYSTEM,
      }),
      /must not set subject_game_id/,
    );
    // And the foreign key refuses it even when the scope rule is bypassed.
    await assert.rejects(
      sql`
        insert into analysis.runs (
          run_type, recipe_version_id, subject_id, subject_game_id, replay_revision_id,
          status, input_manifest_hash, trigger_kind, actor_kind
        ) values (
          'game_analysis', ${golden.baselineRecipeId}, ${subject.subjectId},
          ${other.games[0].subjectGameId}, ${other.games[0].replayRevisionId},
          'planned', ${SHA("cross-subject")}, 'scheduled', 'system'
        )
      `,
      /runs_game_belongs_to_subject/,
    );
  });

  await report.check("an incomplete manifest does not succeed", async () => {
    await startRun(sql, firstRunId);
    await recordArtifact(sql, firstRunId, {
      family: "transition_assessments",
      count: 4,
      checksum: SHA(`${firstRunId}-transition_assessments`),
    });
    const attempt = await completeRun(sql, firstRunId);
    assert.equal(attempt.status, "running");
    assert.deepEqual(attempt.missing, ["skill_estimates"]);
    assert.equal(attempt.outputManifestHash, null);
  });

  await report.check("a partial run publishes nothing", async () => {
    const refusal = await publishSubjectLive(sql, { runId: firstRunId, reason: "new_run", actor: SYSTEM });
    assert.equal(refusal.published, false);
    assert.equal(refusal.refusedCode, "RUN_NOT_SUCCEEDED");
    const [current] = await sql<{ count: string }[]>`
      select count(*)::text as count from analysis.subject_live_publications
      where subject_id = ${subject.subjectId}
    `;
    assert.equal(current.count, "0");
  });

  await report.check("an undeclared output family is not the run that was planned", async () => {
    await recordArtifact(sql, firstRunId, {
      family: "findings",
      count: 1,
      checksum: SHA(`${firstRunId}-findings`),
    });
    await recordArtifact(sql, firstRunId, {
      family: "skill_estimates",
      count: 9,
      checksum: SHA(`${firstRunId}-skill_estimates`),
    });
    const attempt = await completeRun(sql, firstRunId);
    assert.equal(attempt.status, "running");
    assert.deepEqual(attempt.undeclared, ["findings"]);
  });

  await report.check("an artifact manifest entry cannot be rewritten", async () => {
    await assert.rejects(
      recordArtifact(sql, firstRunId, {
        family: "skill_estimates",
        count: 11,
        checksum: SHA("different"),
      }),
      /already recorded a different/,
    );
    await assert.rejects(
      sql`update analysis.run_artifacts set row_count = 0 where run_id = ${firstRunId}`,
      /immutable/,
    );
  });

  let goodRunId = "";

  await report.check("a complete manifest succeeds and hashes its output", async () => {
    await failRun(sql, firstRunId, "invalid_input");
    const planned = await planRun(sql, {
      recipeVersionId: golden.baselineRecipeId,
      scope: { subjectId: subject.subjectId, subjectDataSnapshotId: snapshotId },
      trigger: "scheduled",
      actor: SYSTEM,
    });
    assert.equal(planned.alreadyPlanned, false, "a failed run frees its inputs for a genuine retry");
    goodRunId = planned.id;
    await startRun(sql, goodRunId);
    await recordGoldenManifest(sql, goodRunId);
    const completion = await completeRun(sql, goodRunId);
    assert.equal(completion.status, "succeeded");
    assert.match(completion.outputManifestHash!, /^[0-9a-f]{64}$/);
  });

  await report.check("a terminal run cannot be reopened or rewritten", async () => {
    await assert.rejects(sql`update analysis.runs set status = 'running' where id = ${goodRunId}`, /terminal/);
    await assert.rejects(
      sql`update analysis.runs set output_manifest_hash = ${SHA("forged")} where id = ${goodRunId}`,
      /written once/,
    );
    await assert.rejects(sql`delete from analysis.runs where id = ${goodRunId}`, /append-only/);
    await assert.rejects(startRun(sql, goodRunId), /cannot be started/);
    await assert.rejects(cancelRun(sql, goodRunId), /only a planned or running run/);
  });

  // --- publication ----------------------------------------------------------

  report.section("atomic publication, history and rollback");

  let firstPublicationId = "";

  await report.check("publishing a succeeded run installs a pointer and a history row", async () => {
    const published = await publishSubjectLive(sql, {
      runId: goodRunId,
      reason: "new_run",
      actor: SYSTEM,
    });
    assert.equal(published.published, true);
    firstPublicationId = published.publicationId!;
    const history = await subjectLiveHistory(sql, subject.subjectId);
    assert.equal(history.length, 1);
    assert.equal(history[0].reason, "first_publication");
    assert.equal(history[0].previousRunId, null);
  });

  await report.check("publishing the same run again is refused, not duplicated", async () => {
    const again = await publishSubjectLive(sql, { runId: goodRunId, reason: "new_run", actor: SYSTEM });
    assert.equal(again.published, false);
    assert.equal(again.refusedCode, "ALREADY_PUBLISHED");
    assert.equal((await subjectLiveHistory(sql, subject.subjectId)).length, 1);
  });

  await report.check("a game analysis run cannot become a subject live publication", async () => {
    const gameRecipe = await registerRecipeVersion(sql, {
      recipeKey: `game_${SUFFIX}`,
      version: "1",
      runType: "game_analysis",
      inputSchemaVersion: "replay.v1",
      outputSchemaVersion: "game_review.v1",
      requiredArtifacts: ["transition_assessments"],
      roles: {
        engine: { componentKey: `engine_${SUFFIX}`, version: "1" },
      },
    });
    const gameRun = await planRun(sql, {
      recipeVersionId: gameRecipe.id,
      scope: {
        subjectId: subject.subjectId,
        subjectGameId: subject.games[0].subjectGameId,
        replayRevisionId: subject.games[0].replayRevisionId,
      },
      trigger: "user_request",
      actor: SYSTEM,
    });
    await startRun(sql, gameRun.id);
    await recordArtifact(sql, gameRun.id, {
      family: "transition_assessments",
      count: 4,
      checksum: SHA(`${gameRun.id}-t`),
    });
    await completeRun(sql, gameRun.id);

    const wrongTarget = await publishSubjectLive(sql, {
      runId: gameRun.id,
      reason: "new_run",
      actor: SYSTEM,
    });
    assert.equal(wrongTarget.refusedCode, "RUN_TYPE_MISMATCH");

    const rightTarget = await publishSubjectGame(sql, {
      runId: gameRun.id,
      reason: "new_run",
      actor: SYSTEM,
    });
    assert.equal(rightTarget.published, true);
  });

  await report.check("a run that lost its artifacts cannot be published", async () => {
    const stripped = await seedSubject(sql, { games: 2 });
    const snap = await freezeSubjectSnapshot(sql, {
      subjectId: stripped.subjectId,
      cohortVersionId: golden.cohortVersionId,
      cutoff: CUTOFF,
    });
    const run = await planRun(sql, {
      recipeVersionId: golden.baselineRecipeId,
      scope: { subjectId: stripped.subjectId, subjectDataSnapshotId: snap.id },
      trigger: "scheduled",
      actor: SYSTEM,
    });
    await startRun(sql, run.id);
    await recordGoldenManifest(sql, run.id);
    await completeRun(sql, run.id);
    // Simulate the manifest and the outputs disagreeing. The trigger refuses
    // a delete, so the only way to reach this state is to add a family the
    // recipe never declared -- which publication must also catch.
    await sql`
      insert into analysis.run_artifacts (run_id, family, row_count, checksum)
      values (${run.id}, 'unexpected_family', 1, ${SHA("x")})
    `;
    const refusal = await publishSubjectLive(sql, { runId: run.id, reason: "new_run", actor: SYSTEM });
    assert.equal(refusal.refusedCode, "MANIFEST_INCOMPLETE");
    assert.match(refusal.detail!, /unexpected_family/);
  });

  let secondRunId = "";

  await report.check("a method-only rerun reuses the unchanged roles", async () => {
    const reuse = await planReuse(sql, {
      subjectDataSnapshotId: snapshotId,
      newRecipeVersionId: golden.estimatorBumpRecipeId,
    });
    assert.deepEqual(
      reuse.map((entry) => entry.reusedRole).sort(),
      ["engine", "normalizer"],
      "only the estimator changed, so only the estimator is recomputed",
    );
    assert.ok(reuse.every((entry) => entry.upstreamRunId === goodRunId));

    const planned = await planRun(sql, {
      recipeVersionId: golden.estimatorBumpRecipeId,
      scope: { subjectId: subject.subjectId, subjectDataSnapshotId: snapshotId },
      trigger: "promotion",
      actor: SYSTEM,
      dependencies: reuse,
    });
    secondRunId = planned.id;
    const recorded = await sql<{ reused_role: string }[]>`
      select reused_role from analysis.run_dependencies where run_id = ${secondRunId} order by reused_role
    `;
    assert.deepEqual(recorded.map((row) => row.reused_role), ["engine", "normalizer"]);
  });

  await report.check("the pointer switch is atomic under a concurrent reader", async () => {
    await startRun(sql, secondRunId);
    await recordGoldenManifest(sql, secondRunId);
    await completeRun(sql, secondRunId);

    const reads: string[] = [];
    const reader = (async () => {
      for (let index = 0; index < 40; index += 1) {
        const [row] = await sql<{ run_id: string; publication_id: string }[]>`
          select p.run_id, p.publication_id
          from analysis.subject_live_publications p
          join analysis.runs r on r.id = p.run_id
          join analysis.run_artifacts a on a.run_id = r.id
          where p.subject_id = ${subject.subjectId}
          group by p.run_id, p.publication_id
          having count(a.family) = ${REQUIRED_ARTIFACTS.length}
        `;
        if (row) reads.push(row.run_id);
      }
    })();
    const published = await publishSubjectLive(sql, {
      runId: secondRunId,
      reason: "recipe_promotion",
      actor: SYSTEM,
    });
    await reader;
    assert.equal(published.published, true);
    assert.equal(published.previousRunId, goodRunId);
    assert.ok(reads.length > 0, "the reader saw a publication");
    assert.ok(
      reads.every((runId) => runId === goodRunId || runId === secondRunId),
      "a reader only ever saw a complete run",
    );
  });

  await report.check("the superseded run is still complete and readable", async () => {
    const previous = await readRun(sql, goodRunId);
    assert.equal(previous!.status, "succeeded");
    const [artifacts] = await sql<{ count: string }[]>`
      select count(*)::text as count from analysis.run_artifacts where run_id = ${goodRunId}
    `;
    assert.equal(artifacts.count, String(REQUIRED_ARTIFACTS.length));
  });

  await report.check("rollback restores the prior pointer by appending, never deleting", async () => {
    const rolled = await rollbackSubjectLive(sql, { subjectId: subject.subjectId, actor: SYSTEM });
    assert.equal(rolled.published, true);
    const [current] = await sql<{ run_id: string }[]>`
      select run_id from analysis.subject_live_publications where subject_id = ${subject.subjectId}
    `;
    assert.equal(current.run_id, goodRunId);
    const history = await subjectLiveHistory(sql, subject.subjectId);
    assert.equal(history.length, 3, "first publication, promotion, rollback");
    assert.equal(history[0].reason, "rollback");
    assert.ok(
      history.some((entry) => entry.publicationId === firstPublicationId),
      "the original publication row survives the rollback",
    );
    await assert.rejects(
      sql`delete from analysis.subject_live_publication_history where subject_id = ${subject.subjectId}`,
      /immutable/,
    );
  });

  await report.check("a baseline stays pinned while the live pointer moves", async () => {
    const baselineRecipe = await registerRecipeVersion(sql, {
      recipeKey: `baseline_${SUFFIX}`,
      version: "1",
      runType: "subject_baseline",
      inputSchemaVersion: "subject_snapshot.v1",
      outputSchemaVersion: "baseline.v1",
      requiredArtifacts: REQUIRED_ARTIFACTS,
      roles: {
        normalizer: { componentKey: `norm_${SUFFIX}`, version: "1" },
        engine: { componentKey: `engine_${SUFFIX}`, version: "1" },
        estimator: { componentKey: `estimator_${SUFFIX}`, version: "1" },
      },
    });
    const baseline = await planRun(sql, {
      recipeVersionId: baselineRecipe.id,
      scope: { subjectId: subject.subjectId, subjectDataSnapshotId: snapshotId },
      trigger: "user_request",
      actor: SYSTEM,
    });
    await startRun(sql, baseline.id);
    await recordGoldenManifest(sql, baseline.id);
    const completed = await completeRun(sql, baseline.id);

    // Move the live pointer forward again, twice, and re-read the baseline.
    await publishSubjectLive(sql, { runId: secondRunId, reason: "new_run", actor: SYSTEM });
    await rollbackSubjectLive(sql, { subjectId: subject.subjectId, actor: SYSTEM });

    const after = await readRun(sql, baseline.id);
    assert.equal(after!.outputManifestHash, completed.outputManifestHash);
    assert.equal(after!.subjectDataSnapshotId, snapshotId);
    const verification = await verifySnapshotHash(sql, snapshotId);
    assert.equal(verification.matches, true, "the snapshot the baseline pins did not move");
  });

  await report.check("the version block names the exact methods behind the claim", async () => {
    const block = await subjectLiveVersionBlock(sql, subject.subjectId);
    assert.ok(block);
    assert.equal(block!.subjectSnapshotId, snapshotId);
    assert.deepEqual(Object.keys(block!.policyVersions).sort(), ["engine", "estimator", "normalizer"]);
    assert.equal(block!.policyVersions.estimator, `estimator_${SUFFIX}@1`);
    assert.match(block!.generatedAt, /^\d{4}-\d\d-\d\dT/);
  });

  await report.check("a subject with no publication has no version block", async () => {
    const block = await subjectLiveVersionBlock(sql, other.subjectId);
    assert.equal(block, null, "no publication means no claim, not a half-filled block");
  });

  // --- materialization publication -----------------------------------------

  report.section("replay materialization publication history");

  await report.check("a materialization switch records history and rolls back", async () => {
    const revision = subject.games[0].replayRevisionId;
    const [rebuild] = await sql<{ id: string }[]>`
      insert into chess.materialization_runs (
        replay_revision_id, materializer_version, checksum, state, occurrence_count, transition_count
      ) values (${revision}, 'core-key-v2', ${SHA(`rebuild-${revision}`)}, 'building', 5, 4)
      returning id
    `;
    const switched = await publishRun(sql, rebuild.id, { reason: "new_run", actor: { kind: "system" } });
    assert.equal(switched.published, true);
    assert.equal(switched.supersededRunId, subject.games[0].materializationRunId);
    assert.ok(switched.publicationId);

    const rolled = await rollbackMaterialization(sql, revision);
    assert.equal(rolled.published, true);
    const [current] = await sql<{ id: string }[]>`
      select id from chess.materialization_runs
      where replay_revision_id = ${revision} and state = 'published'
    `;
    assert.equal(current.id, subject.games[0].materializationRunId);
    const history = await materializationHistory(sql, revision);
    assert.equal(history.length, 3);
    assert.equal(history[0].reason, "rollback");
  });

  // --- validation, lifecycle, promotion ------------------------------------

  report.section("validation evidence and promotion");

  let datasetId = "";
  let passingRunId = "";

  await report.check("a validation run records its metrics in the same transaction", async () => {
    const dataset = await registerValidationDataset(sql, {
      datasetKey: `holdout_${SUFFIX}`,
      version: "1",
      manifestSha256: SHA(`holdout_${SUFFIX}`),
      samplingDescription: "account-disjoint chronological holdout",
      accountDisjoint: true,
      chronologicalSplit: true,
      governanceClass: "internal",
    });
    datasetId = dataset.id;
    passingRunId = await recordValidationRun(sql, {
      datasetId,
      candidate: { recipeVersionId: golden.estimatorBumpRecipeId },
      baseline: { recipeVersionId: golden.baselineRecipeId },
      executionRevision: "gate",
      status: "passed",
      outputChecksum: SHA("validation-output"),
      metrics: [
        { metricKey: "coverage", slice: { speed: "blitz" }, sampleSize: 120, value: 0.94 },
        {
          metricKey: "coverage",
          slice: { speed: "bullet" },
          sampleSize: 0,
          unavailableReason: "no evidence in slice",
        },
      ],
    });
    const metrics = await sql<{ metric_key: string; value: number | null; unavailable_reason: string | null }[]>`
      select metric_key, value, unavailable_reason from analysis.validation_metrics
      where validation_run_id = ${passingRunId} order by unavailable_reason nulls first
    `;
    assert.equal(metrics.length, 2);
    assert.equal(metrics[1].value, null);
    assert.equal(metrics[1].unavailable_reason, "no evidence in slice");
  });

  await report.check("an unmeasurable slice cannot also carry a value", async () => {
    await assert.rejects(
      sql`
        insert into analysis.validation_metrics (
          validation_run_id, metric_key, sample_size, value, unavailable_reason
        ) values (${passingRunId}, 'coverage', 3, 0.5, 'both')
      `,
      /validation_metrics_value_or_reason/,
    );
  });

  await report.check("promotion to a production surface requires cited evidence", async () => {
    await assert.rejects(
      promoteRecipe(sql, {
        surface: "live_player_profile",
        recipeVersionId: golden.estimatorBumpRecipeId,
        reason: "no evidence",
        actor: SYSTEM,
      }),
      /requires the validation run/,
    );
    const failing = await recordValidationRun(sql, {
      datasetId,
      candidate: { recipeVersionId: golden.baselineRecipeId },
      executionRevision: "gate",
      status: "failed",
      outputChecksum: SHA("failing"),
    });
    await assert.rejects(
      promoteRecipe(sql, {
        surface: "live_player_profile",
        recipeVersionId: golden.baselineRecipeId,
        reason: "citing a failure",
        actor: SYSTEM,
        validationRunId: failing,
      }),
      /only a passing run justifies promotion/,
    );
    await assert.rejects(
      promoteRecipe(sql, {
        surface: "live_player_profile",
        recipeVersionId: golden.baselineRecipeId,
        reason: "citing someone else's evidence",
        actor: SYSTEM,
        validationRunId: passingRunId,
      }),
      /evaluated a different recipe version/,
    );
  });

  await report.check("a shadow surface is the one place a candidate needs no evidence", async () => {
    const promoted = await promoteRecipe(sql, {
      surface: "research_shadow",
      recipeVersionId: golden.estimatorBumpRecipeId,
      reason: "acquire evidence",
      actor: SYSTEM,
    });
    assert.ok(promoted.promotionId);
  });

  await report.check("promotion moves what new runs use and rolls back by appending", async () => {
    const baselineEvidence = await recordValidationRun(sql, {
      datasetId,
      candidate: { recipeVersionId: golden.baselineRecipeId },
      executionRevision: "gate",
      status: "passed",
      outputChecksum: SHA("baseline-evidence"),
    });
    await promoteRecipe(sql, {
      surface: "live_player_profile",
      recipeVersionId: golden.baselineRecipeId,
      reason: "initial",
      actor: SYSTEM,
      validationRunId: baselineEvidence,
    });
    await promoteRecipe(sql, {
      surface: "live_player_profile",
      recipeVersionId: golden.estimatorBumpRecipeId,
      reason: "new estimator",
      actor: SYSTEM,
      validationRunId: passingRunId,
    });
    const rolled = await rollbackRecipePromotion(sql, {
      surface: "live_player_profile",
      reason: "regression",
      actor: SYSTEM,
    });
    assert.equal(rolled.recipeVersionId, golden.baselineRecipeId);
    const history = await promotionHistory(sql, "live_player_profile");
    assert.equal(history.length, 3);
    assert.equal(history[0].reason, "regression");
    await assert.rejects(
      sql`delete from analysis.recipe_promotions where surface = 'live_player_profile'`,
      /immutable/,
    );
  });

  await report.check("a promotion never reaches an existing run or publication", async () => {
    const published = await readRun(sql, goodRunId);
    assert.equal(published!.recipeVersionId, golden.baselineRecipeId);
    const [pointer] = await sql<{ recipe_version_id: string }[]>`
      select recipe_version_id from analysis.subject_live_publications where subject_id = ${subject.subjectId}
    `;
    assert.equal(pointer.recipe_version_id, golden.baselineRecipeId);
  });

  await report.check("a component version cannot skip its lifecycle", async () => {
    await assert.rejects(
      recordLifecycleTransition(sql, {
        componentVersionId: golden.estimatorV2Id,
        to: "production",
        reason: "straight to production",
        actor: SYSTEM,
      }),
      /enters its lifecycle at draft/,
    );
    await recordLifecycleTransition(sql, {
      componentVersionId: golden.estimatorV2Id,
      to: "draft",
      reason: "registered",
      actor: SYSTEM,
    });
    await assert.rejects(
      recordLifecycleTransition(sql, {
        componentVersionId: golden.estimatorV2Id,
        to: "production",
        reason: "skip shadow",
        actor: SYSTEM,
      }),
      /cannot move from draft to production/,
    );
  });

  await report.check("reaching validated requires evidence about that version", async () => {
    await recordLifecycleTransition(sql, {
      componentVersionId: golden.estimatorV2Id,
      to: "shadow",
      reason: "shadow evaluation",
      actor: SYSTEM,
    });
    await assert.rejects(
      recordLifecycleTransition(sql, {
        componentVersionId: golden.estimatorV2Id,
        to: "validated",
        reason: "no evidence",
        actor: SYSTEM,
      }),
      /requires the validation run/,
    );
    const componentEvidence = await recordValidationRun(sql, {
      datasetId,
      candidate: { componentVersionId: golden.estimatorV2Id },
      baseline: { componentVersionId: golden.estimatorV1Id },
      executionRevision: "gate",
      status: "passed",
      outputChecksum: SHA("component-evidence"),
    });
    await recordLifecycleTransition(sql, {
      componentVersionId: golden.estimatorV2Id,
      to: "validated",
      reason: "holdout passed",
      actor: SYSTEM,
      validationRunId: componentEvidence,
    });
    await recordLifecycleTransition(sql, {
      componentVersionId: golden.estimatorV2Id,
      to: "production",
      reason: "promote",
      actor: SYSTEM,
      validationRunId: componentEvidence,
    });
    assert.equal(await currentLifecycleState(sql, golden.estimatorV2Id), "production");
    await assert.rejects(
      sql`delete from analysis.component_lifecycle_events where component_version_id = ${golden.estimatorV2Id}`,
      /immutable/,
    );
  });

  // --- telemetry ------------------------------------------------------------

  report.section("telemetry");

  await report.check("publication events carry no subject, game or manifest", async () => {
    const switches = events.map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.ok(switches.length > 0);
    const serialized = JSON.stringify(switches);
    assert.ok(!serialized.includes(subject.subjectId), "no subject id in telemetry");
    assert.ok(!serialized.includes(subject.games[0].subjectGameId), "no game id in telemetry");
    assert.ok(
      switches.some((event) => event.refusedCode === "RUN_NOT_SUCCEEDED"),
      "a refusal is observable",
    );
    assert.ok(
      switches.every((event) => typeof event.durationMs === "number"),
      "every switch reports how long it held the lock",
    );
  });
} finally {
  await harness.destroy();
}

report.finish();
