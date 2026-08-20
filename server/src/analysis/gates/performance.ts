/**
 * `npm run analysis:performance` — the budgets in `contract.ts`, measured.
 *
 * Two paths in this epic have a plausible cost, and neither is guessable.
 *
 * The publication switch holds a lock every reader of that subject queues
 * behind, so its cost is contention and not just latency. It is measured under
 * a concurrent reader, because a switch that is fast on an idle database and
 * slow under load is the one that matters.
 *
 * Freezing a snapshot walks every eligible game of a subject and writes a
 * manifest row for each. Database architecture §34 asks for a 1,000-game
 * subject, so that is what this builds — in bulk SQL rather than through the
 * fixture seeder, because 1,000 games at six round trips each would measure the
 * seeder rather than the freeze.
 *
 * Every number is printed with its budget. A regression is a failed command,
 * and the recorded value is the threshold the next run is compared against.
 */

import { strict as assert } from "node:assert";
import postgres from "postgres";
import { GateReport, startAnalysisHarness } from "./harness.js";
import { BUDGETS } from "../contract.js";
import { GOLDEN_COHORT, recordGoldenManifest, seedGoldenVersions, SHA } from "../fixtures.js";
import { freezeSubjectSnapshot, readSnapshotManifest, registerCohortVersion } from "../snapshots.js";
import { completeRun, planRun, startRun } from "../runs.js";
import { publishSubjectLive, subjectLiveVersionBlock } from "../publication.js";
import { validateRecipe, recipeRoles } from "../versions.js";
import { setAnalysisEventSink } from "../telemetry.js";

const report = new GateReport("E11 analysis versioning performance gate");
const harness = await startAnalysisHarness();
const sql = harness.sql;
setAnalysisEventSink(() => {});

const GAMES = Number(process.env.FORMA_PERF_GAMES ?? 1_000);
const SWITCHES = 12;

function record(name: string, measured: number, budget: number): void {
  const verdict = measured <= budget ? "within" : "OVER";
  console.log(`      ${name}: ${measured.toFixed(0)}ms ${verdict} budget ${budget}ms`);
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

const SUFFIX = `p${Date.now().toString(36)}`;
const golden = await seedGoldenVersions(sql, SUFFIX);
const SYSTEM = { kind: "system" as const };

// The golden cohort caps at 500 games, which is the right default for a product
// baseline and the wrong one for a §34 fixture. This one takes everything, so
// the freeze is measured over the whole 1,000.
const cohort = await registerCohortVersion(sql, {
  cohortKey: `perf_${SUFFIX}`,
  version: "1",
  definition: { ...GOLDEN_COHORT, maxGames: null, minGames: 0 },
});

/**
 * A production-shaped subject, built in five statements rather than 6,000.
 *
 * The shape matters more than the route in: one subject, `GAMES` completed
 * rated blitz games, each with its own provider game, replay revision,
 * participants and published materialization run.
 */
const [{ subject_id: subjectId, owner_user_id: ownerUserId }] = await sql<
  { subject_id: string; owner_user_id: string }[]
>`
  with profile as (
    insert into app.profiles (user_id) values (gen_random_uuid()) returning user_id
  ), subject as (
    insert into app.analysis_subjects (kind, owner_user_id, display_label)
    select 'personal', user_id, 'E11 performance subject' from profile
    returning id, owner_user_id
  )
  select id as subject_id, owner_user_id from subject
`;

const buildStartedAt = Date.now();
const PREFIX = `perf-${SUFFIX}-`;

// Sequential statements rather than one chain of data-modifying CTEs: sibling
// CTEs cannot see each other's inserted rows, so a single statement would build
// provider games and then quietly link nothing to them.
await sql`
  insert into chess.provider_games (provider_id, provider_game_id)
  select 2, ${PREFIX} || n from generate_series(1, ${GAMES}) as n
`;
await sql`
  insert into chess.game_replay_revisions (
    provider_game_id, revision_no, normalizer_component_version_id, normalized_replay,
    normalized_sha256, played_at, rated, speed, result, ply_count, revision_reason
  )
  select pg.id, 1, 'norm-v1', '{"moves":[]}'::jsonb,
         md5(pg.provider_game_id) || md5(pg.provider_game_id),
         now() - (row_number() over (order by pg.id) || ' hours')::interval,
         true, 'blitz', 'white', 60, 'first_seen'
  from chess.provider_games pg
  where pg.provider_game_id like ${`${PREFIX}%`}
`;
await sql`
  update chess.provider_games pg set current_replay_revision_id = rev.id
  from chess.game_replay_revisions rev
  where rev.provider_game_id = pg.id and pg.provider_game_id like ${`${PREFIX}%`}
`;
await sql`
  insert into chess.game_revision_participants (replay_revision_id, color, outcome, is_bot, rating)
  select rev.id, c.color, case when c.color = 'white' then 'win' else 'loss' end, false, 1500
  from chess.game_replay_revisions rev
  join chess.provider_games pg on pg.id = rev.provider_game_id
  cross join (values ('white'), ('black')) as c(color)
  where pg.provider_game_id like ${`${PREFIX}%`}
`;
await sql`
  insert into chess.subject_games (subject_id, provider_game_id, latest_replay_revision_id, subject_color)
  select ${subjectId}, pg.id, pg.current_replay_revision_id, 'white'
  from chess.provider_games pg
  where pg.provider_game_id like ${`${PREFIX}%`}
`;
await sql`
  insert into chess.materialization_runs (
    replay_revision_id, materializer_version, checksum, state, occurrence_count,
    transition_count, published_at
  )
  select rev.id, 'core-key-v1', md5(rev.id::text) || md5(rev.id::text), 'published', 61, 60, now()
  from chess.game_replay_revisions rev
  join chess.provider_games pg on pg.id = rev.provider_game_id
  where pg.provider_game_id like ${`${PREFIX}%`}
`;
console.log(`\nfixture: ${GAMES} games seeded in ${Date.now() - buildStartedAt}ms\n`);

try {
  report.section(`production-shaped subject (${GAMES} games)`);

  let snapshotId = "";

  await report.check("freezing a production-shaped snapshot is within budget", async () => {
    const startedAt = Date.now();
    const frozen = await freezeSubjectSnapshot(sql, {
      subjectId,
      cohortVersionId: cohort.id,
      cutoff: new Date().toISOString(),
    });
    const elapsed = Date.now() - startedAt;
    snapshotId = frozen.id;
    record("snapshot freeze", elapsed, BUDGETS.snapshotBuildMs);
    assert.equal(frozen.gameCount, GAMES);
    assert.ok(elapsed <= BUDGETS.snapshotBuildMs, `${elapsed}ms exceeds ${BUDGETS.snapshotBuildMs}ms`);
  });

  await report.check("recipe validation walks the DAG within budget", async () => {
    const roles = await recipeRoles(sql, golden.baselineRecipeId);
    const startedAt = Date.now();
    const validation = await validateRecipe(sql, roles);
    const elapsed = Date.now() - startedAt;
    record("recipe validation", elapsed, BUDGETS.recipeValidationMs);
    assert.equal(validation.valid, true);
    assert.ok(elapsed <= BUDGETS.recipeValidationMs, `${elapsed}ms exceeds ${BUDGETS.recipeValidationMs}ms`);
  });

  /**
   * `SWITCHES` alternating runs, so every publication after the first is a real
   * pointer move with a predecessor rather than a first publication.
   */
  const runIds: string[] = [];
  for (let index = 0; index < SWITCHES; index += 1) {
    const planned = await planRun(sql, {
      recipeVersionId: index % 2 === 0 ? golden.baselineRecipeId : golden.estimatorBumpRecipeId,
      scope: { subjectId, subjectDataSnapshotId: snapshotId },
      trigger: "scheduled",
      actor: SYSTEM,
      // A distinct dependency hash per iteration, so each is a different run
      // rather than the idempotency index returning the first one.
      dependencies:
        index < 2
          ? []
          : [
              {
                upstreamRunId: runIds[index - 2],
                reusedRole: "engine",
                upstreamOutputHash: SHA(`perf-${index}`),
              },
            ],
    });
    await startRun(sql, planned.id);
    await recordGoldenManifest(sql, planned.id);
    await completeRun(sql, planned.id);
    runIds.push(planned.id);
  }

  /**
   * One commit's cost on this host, so the switch budget can be about the
   * switch.
   *
   * A disposable benchmark server is often a container with `fsync` on, where a
   * bare commit costs upwards of 100ms. Measuring the publication against a raw
   * wall-clock budget on such a host measures the disk; measuring it against
   * this baseline measures the transaction.
   */
  let commitBaselineMs = 0;

  await report.check("a commit baseline is established for this host", async () => {
    await sql`create table if not exists analysis_perf_commit_probe (id bigint generated always as identity primary key)`;
    const samples: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      const startedAt = Date.now();
      await sql.begin(async (tx) => {
        await tx`insert into analysis_perf_commit_probe default values`;
      });
      samples.push(Date.now() - startedAt);
    }
    await sql`drop table analysis_perf_commit_probe`;
    commitBaselineMs = percentile(samples, 0.95);
    console.log(`      one write transaction p95 on this host: ${commitBaselineMs.toFixed(0)}ms`);
    assert.ok(commitBaselineMs >= 0);
  });

  /**
   * The switch, measured twice: alone, and against a live read load.
   *
   * Reporting only the contended number hides whether a regression is in the
   * transaction or in the load around it, and reporting only the quiet number
   * measures a database nobody is using. The delta between them is the
   * contention cost, which is what this lock actually costs.
   *
   * The readers are paced rather than spun. Four clients re-reading one
   * subject's pointer every 20ms is a heavy dashboard load for a single
   * subject; an unpaced loop would saturate the host and measure that instead.
   */
  async function measureSwitches(runIdsToPublish: string[]): Promise<number[]> {
    const durations: number[] = [];
    for (const runId of runIdsToPublish) {
      const startedAt = Date.now();
      const result = await publishSubjectLive(sql, { runId, reason: "new_run", actor: SYSTEM });
      durations.push(Date.now() - startedAt);
      assert.equal(result.published, true, result.detail ?? "publication refused");
    }
    return durations;
  }

  function assertSwitchBudget(label: string, durations: number[]): number {
    const p95 = percentile(durations, 0.95);
    const net = Math.max(0, p95 - commitBaselineMs);
    console.log(
      `      ${label}: ${p95.toFixed(0)}ms total, ${net.toFixed(0)}ms net of commit ` +
        `${net <= BUDGETS.publicationMs ? "within" : "OVER"} budget ${BUDGETS.publicationMs}ms`,
    );
    assert.ok(net <= BUDGETS.publicationMs, `${net}ms net exceeds ${BUDGETS.publicationMs}ms`);
    return net;
  }

  let quietNet = 0;

  await report.check("the publication switch is within budget on a quiet database", async () => {
    quietNet = assertSwitchBudget(
      `publication switch p95 (${SWITCHES / 2} switches, no read load)`,
      await measureSwitches(runIds.slice(0, SWITCHES / 2)),
    );
  });

  await report.check("the publication switch is within budget under a read load", async () => {
    let reading = true;
    let reads = 0;
    // Readers get their own connections: sharing the publisher's pool would
    // measure connection starvation rather than lock contention.
    const readerPool = postgres(harness.db.adminUrl, { max: 4, prepare: false, onnotice: () => {} });
    const readers = Array.from({ length: 4 }, () =>
      (async () => {
        while (reading) {
          await readerPool`
            select run_id from analysis.subject_live_publications where subject_id = ${subjectId}
          `;
          reads += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      })(),
    );
    let durations: number[] = [];
    try {
      durations = await measureSwitches(runIds.slice(SWITCHES / 2));
    } finally {
      reading = false;
      await Promise.all(readers);
      await readerPool.end({ timeout: 5 });
    }
    const net = assertSwitchBudget(
      `publication switch p95 (${durations.length} switches, ${reads} concurrent reads)`,
      durations,
    );
    console.log(`      contention cost: ${(net - quietNet).toFixed(0)}ms over the quiet net p95`);
  });

  await report.check("resolving the version block is within budget", async () => {
    // Warm, then measure: the first call pays for a plan the API would already
    // have cached, and reporting that as the read cost would be misleading.
    await subjectLiveVersionBlock(sql, subjectId);
    const samples: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      const startedAt = Date.now();
      const block = await subjectLiveVersionBlock(sql, subjectId);
      samples.push(Date.now() - startedAt);
      assert.ok(block);
    }
    const p95 = percentile(samples, 0.95);
    record("version block p95", p95, BUDGETS.versionBlockMs);
    assert.ok(p95 <= BUDGETS.versionBlockMs, `${p95}ms exceeds ${BUDGETS.versionBlockMs}ms`);
  });

  report.section("read paths");

  await report.check("the version block read uses indexes, not a scan", async () => {
    const plan = await sql<{ "QUERY PLAN": string }[]>`
      explain (analyze, buffers, format text)
      select p.publication_id, p.published_at, p.subject_data_snapshot_id, p.recipe_version_id
      from analysis.subject_live_publications p
      where p.subject_id = ${subjectId}
    `;
    const text = plan.map((row) => row["QUERY PLAN"]).join("\n");
    assert.ok(!/Seq Scan/.test(text), text);
  });

  await report.check("reading a 1,000-game manifest back is within budget", async () => {
    // Deliberately a latency budget and not a plan shape. At 1,000 rows the
    // planner is right to scan sequentially, and asserting "Index Scan" would
    // encode a preference the data does not support -- it would fail on a small
    // subject and pass on a large one, which is backwards.
    const samples: number[] = [];
    for (let index = 0; index < 10; index += 1) {
      const startedAt = Date.now();
      const rows = await readSnapshotManifest(sql, snapshotId);
      samples.push(Date.now() - startedAt);
      assert.equal(rows.length, GAMES);
    }
    const p95 = percentile(samples, 0.95);
    record("snapshot manifest read p95", p95, BUDGETS.snapshotManifestReadMs);
    assert.ok(p95 <= BUDGETS.snapshotManifestReadMs, `${p95}ms exceeds ${BUDGETS.snapshotManifestReadMs}ms`);
  });

  await report.check("one page of owned games with publication state is within budget", async () => {
    const samples: number[] = [];
    for (let index = 0; index < 10; index += 1) {
      const startedAt = Date.now();
      const rows = await sql`
        select sg.id, pub.run_id, pub.publication_id
        from chess.subject_games sg
        join app.analysis_subjects s on s.id = sg.subject_id
        left join analysis.subject_game_publications pub on pub.subject_game_id = sg.id
        where sg.subject_id = ${subjectId} and s.owner_user_id = ${ownerUserId}
        order by sg.id
        limit 25
      `;
      samples.push(Date.now() - startedAt);
      assert.equal(rows.length, 25);
    }
    const p95 = percentile(samples, 0.95);
    record("owned game page p95", p95, BUDGETS.gamePageMs);
    assert.ok(p95 <= BUDGETS.gamePageMs, `${p95}ms exceeds ${BUDGETS.gamePageMs}ms`);
  });
} finally {
  await harness.destroy();
}

report.finish();
