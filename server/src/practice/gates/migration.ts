/**
 * `npm run practice:migration` — 0031 from empty, from prior state, and twice.
 *
 * The checks that matter are the four constraints that make "practice is not
 * improvement" a mechanism rather than a sentence: a player-derived item is
 * owned by that player, an intervention has to address something, a revealed
 * answer is never a solve, and an incomparable transfer match cannot claim a
 * direction.
 */

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { GateReport } from "../../v1/gates/harness.js";
import { createDisposableDatabase } from "../../platform/harness/postgres.js";
import { applyMigrations, MIGRATIONS_FOLDER } from "../../platform/harness/migrations.js";
import { jsonParam } from "../../db/json.js";

const report = new GateReport("E18 practice migration gate");

const MIGRATION_TAG = "0031_e18_practice_transfer";
const MIGRATION_SQL = readFileSync(join(MIGRATIONS_FOLDER, `${MIGRATION_TAG}.sql`), "utf8");

async function apply0031(url: string): Promise<void> {
  const client = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    await client.begin(async (tx) => {
      for (const statement of MIGRATION_SQL.split("--> statement-breakpoint")) {
        const trimmed = statement.trim();
        if (trimmed.length > 0) await tx.unsafe(trimmed);
      }
    });
  } finally {
    await client.end({ timeout: 5 });
  }
}

const NEW_TABLES = [
  "interventions",
  "learning_assignments",
  "practice_attempts",
  "review_schedules",
  "training_item_versions",
  "training_items",
  "transfer_matches",
];

report.section("from an empty database");

{
  const db = await createDisposableDatabase();
  try {
    await applyMigrations(db.adminUrl);
    const sql = postgres(db.adminUrl, { max: 1, prepare: false, onnotice: () => {} });
    try {
      await report.check("every table this epic claims exists", async () => {
        const rows = await sql<{ table_name: string }[]>`
          select table_name from information_schema.tables
          where table_schema = 'coaching' and table_name = any(${NEW_TABLES})
          order by table_name
        `;
        assert.deepEqual(rows.map((row) => row.table_name), NEW_TABLES);
      });

      const seeded = await seedPractice(sql);

      await report.check("a player-derived item without an owner is refused", async () => {
        await assert.rejects(
          () => sql`
            insert into coaching.training_items (source_kind, provenance, retention_class)
            values ('player_evidence', 'derived from a game of theirs', 'shared')
          `,
          /training_items_player_derived_is_owned/,
        );
      });

      await report.check("nor can editorial content claim an owner", async () => {
        await assert.rejects(
          () => sql`
            insert into coaching.training_items (
              source_kind, owner_subject_id, provenance, retention_class
            ) values (
              'editorial', ${seeded.subjectId}, 'written by the editorial team', 'subject_owned'
            )
          `,
          /training_items_player_derived_is_owned/,
        );
      });

      await report.check("an intervention that addresses nothing is refused", async () => {
        await assert.rejects(
          () => sql`
            insert into coaching.interventions (
              subject_id, intervention_type, channel
            ) values (${seeded.subjectId}, 'recommendation', 'in_app')
          `,
          /interventions_addresses_something/,
        );
      });

      await report.check("a drill must name the content it delivered", async () => {
        await assert.rejects(
          () => sql`
            insert into coaching.interventions (
              subject_id, finding_id, intervention_type, channel
            ) values (${seeded.subjectId}, ${seeded.findingId}, 'drill', 'in_app')
          `,
          /interventions_content_when_needed/,
        );
      });

      await report.check("an assignment must say why it was assigned", async () => {
        await assert.rejects(
          () => sql`
            insert into coaching.learning_assignments (
              subject_id, training_item_version_id, reason, selection_component_version_id,
              priority
            ) values (
              ${seeded.subjectId}, ${seeded.itemVersionId}, 'because', ${seeded.componentVersionId}, 50
            )
          `,
          /assignments_reason_present/,
        );
      });

      await report.check("a revealed answer cannot be recorded as a solve", async () => {
        await assert.rejects(
          () => sql`
            insert into coaching.practice_attempts (
              assignment_id, training_item_version_id, client_attempt_id, submitted_uci,
              revealed, success, rubric_component_version_id
            ) values (
              ${seeded.assignmentId}, ${seeded.itemVersionId}, 'revealed-solve-1',
              array['e2e4']::text[], true, true, ${seeded.componentVersionId}
            )
          `,
          /practice_attempts_revealed_is_not_success/,
        );
      });

      await report.check("a retried submit is one attempt, not two", async () => {
        await sql`
          insert into coaching.practice_attempts (
            assignment_id, training_item_version_id, client_attempt_id, submitted_uci,
            success, rubric_component_version_id
          ) values (
            ${seeded.assignmentId}, ${seeded.itemVersionId}, 'client-attempt-01',
            array['e2e4']::text[], true, ${seeded.componentVersionId}
          )
        `;
        await assert.rejects(
          () => sql`
            insert into coaching.practice_attempts (
              assignment_id, training_item_version_id, client_attempt_id, submitted_uci,
              success, rubric_component_version_id
            ) values (
              ${seeded.assignmentId}, ${seeded.itemVersionId}, 'client-attempt-01',
              array['d2d4']::text[], false, ${seeded.componentVersionId}
            )
          `,
          /practice_attempts_idempotent/,
        );
      });

      await report.check("an attempt is never rewritten", async () => {
        await assert.rejects(
          () => sql`update coaching.practice_attempts set success = false`,
          /immutable|refuse/i,
        );
      });

      await report.check("an incomparable transfer match cannot claim a direction", async () => {
        await assert.rejects(
          () => sql`
            insert into coaching.transfer_matches (
              subject_id, assignment_id, opportunity_id, match_component_version_id,
              comparable_context, incomparable_reason, outcome, confidence
            ) values (
              ${seeded.subjectId}, ${seeded.assignmentId}, ${seeded.opportunityId},
              ${seeded.componentVersionId}, false, 'different_concept', 'negative', 0.9
            )
          `,
          /transfer_matches_incomparable_is_inconclusive/,
        );
      });

      await report.check("an incomparable match must explain itself", async () => {
        await assert.rejects(
          () => sql`
            insert into coaching.transfer_matches (
              subject_id, assignment_id, opportunity_id, match_component_version_id,
              comparable_context, outcome, confidence
            ) values (
              ${seeded.subjectId}, ${seeded.assignmentId}, ${seeded.opportunityId},
              ${seeded.componentVersionId}, false, 'inconclusive', 0
            )
          `,
          /transfer_matches_incomparable_explained/,
        );
      });

      await report.check("a comparable match records its outcome and similarity", async () => {
        await sql`
          insert into coaching.transfer_matches (
            subject_id, assignment_id, opportunity_id, match_component_version_id,
            structural_similarity, comparable_context, outcome, confidence
          ) values (
            ${seeded.subjectId}, ${seeded.assignmentId}, ${seeded.opportunityId},
            ${seeded.componentVersionId}, 0.9, true, 'negative', 0.8
          )
        `;
        const [row] = await sql<{ outcome: string }[]>`
          select outcome from coaching.transfer_matches
          where opportunity_id = ${seeded.opportunityId}
        `;
        assert.equal(row?.outcome, "negative", "a failed transfer could not be recorded");
      });

      await report.check("a transfer match points at a real-game opportunity", async () => {
        const [row] = await sql<{ column_name: string }[]>`
          select column_name from information_schema.columns
          where table_schema = 'coaching' and table_name = 'transfer_matches'
            and column_name like '%practice%'
        `;
        assert.equal(row, undefined, "a practice attempt could stand in for a real game");
        const [opportunity] = await sql<{ column_name: string }[]>`
          select column_name from information_schema.columns
          where table_schema = 'coaching' and table_name = 'transfer_matches'
            and column_name = 'opportunity_id'
        `;
        assert.ok(opportunity, "the match does not name a real-game opportunity");
      });

      await report.check("the same exercise cannot be registered twice", async () => {
        await assert.rejects(
          () => sql`
            insert into coaching.training_item_versions (
              item_id, version, fen, prompt, solution_uci, generation_method, content_sha256
            ) values (
              ${seeded.itemId}, 2, 'fen', 'Find the strongest continuation here.',
              array['e2e4']::text[], 'gate_fixture',
              (select content_sha256 from coaching.training_item_versions
                where id = ${seeded.itemVersionId})
            )
          `,
          /training_item_versions_content_unique/,
        );
      });

      await report.check("no browser role reaches any of it", async () => {
        const rows = await sql<{ table_name: string }[]>`
          select table_name from information_schema.role_table_grants
          where table_schema = 'coaching' and table_name = any(${NEW_TABLES})
            and grantee in ('anon', 'authenticated', 'public', 'PUBLIC')
        `;
        assert.deepEqual([...rows], []);
      });

      await report.check("the API cannot assign work to itself", async () => {
        const rows = await sql<{ privilege_type: string }[]>`
          select privilege_type from information_schema.role_table_grants
          where table_schema = 'coaching' and table_name = 'learning_assignments'
            and grantee = 'forma_api' and privilege_type = 'INSERT'
        `;
        assert.deepEqual([...rows], [], "the API can create its own assignments");
      });

      await report.check("re-applying 0031 changes nothing", async () => {
        const before = await fingerprint(sql);
        await apply0031(db.adminUrl);
        assert.deepEqual(await fingerprint(sql), before);
      });
    } finally {
      await sql.end({ timeout: 5 });
    }
  } finally {
    await db.destroy();
  }
}

report.section("from a database that stopped at 0030");

{
  const db = await createDisposableDatabase();
  try {
    await applyMigrations(db.adminUrl, "0030_e17_goals_cycles");
    const sql = postgres(db.adminUrl, { max: 1, prepare: false, onnotice: () => {} });
    try {
      await report.check("E17's tables are there and E18's are not", async () => {
        const [goals] = await sql<{ count: string }[]>`
          select count(*)::text as count from information_schema.tables
          where table_schema = 'coaching' and table_name = 'goals'
        `;
        assert.equal(goals?.count, "1");
        const [practice] = await sql<{ count: string }[]>`
          select count(*)::text as count from information_schema.tables
          where table_schema = 'coaching' and table_name = 'practice_attempts'
        `;
        assert.equal(practice?.count, "0");
      });

      await report.check("0031 applies to it", async () => {
        await apply0031(db.adminUrl);
        const [row] = await sql<{ count: string }[]>`
          select count(*)::text as count from information_schema.tables
          where table_schema = 'coaching' and table_name = any(${NEW_TABLES})
        `;
        assert.equal(row?.count, String(NEW_TABLES.length));
      });
    } finally {
      await sql.end({ timeout: 5 });
    }
  } finally {
    await db.destroy();
  }
}

report.finish();

// ---------------------------------------------------------------------------

async function fingerprint(sql: postgres.Sql): Promise<unknown[]> {
  const rows = await sql<
    { table_name: string; column_name: string; data_type: string; is_nullable: string }[]
  >`
    select table_name, column_name, data_type, is_nullable
    from information_schema.columns
    where table_schema = 'coaching' and table_name = any(${NEW_TABLES})
    order by table_name, column_name
  `;
  return [...rows];
}

interface Seeded {
  subjectId: string;
  findingId: string;
  itemId: string;
  itemVersionId: string;
  assignmentId: string;
  opportunityId: string;
  componentVersionId: string;
}

function hex(): string {
  return (randomUUID() + randomUUID()).replace(/-/g, "");
}

async function seedPractice(sql: postgres.Sql): Promise<Seeded> {
  const [profile] = await sql<{ user_id: string }[]>`
    insert into app.profiles (user_id) values (gen_random_uuid()) returning user_id
  `;
  const [subject] = await sql<{ id: string }[]>`
    insert into app.analysis_subjects (kind, owner_user_id, display_label)
    values ('personal', ${profile!.user_id}, 'practice gate') returning id
  `;
  const [component] = await sql<{ id: string }[]>`
    insert into analysis.components (
      component_key, category, description, input_contract, output_contract
    ) values ('gate_practice', 'projection', 'A gate fixture.', 'a.v1', 'b.v1')
    returning id
  `;
  const [version] = await sql<{ id: string }[]>`
    insert into analysis.component_versions (
      component_id, version, implementation_sha256, configuration, configuration_hash,
      content_hash, deterministic
    ) values (${component!.id}, '1', ${hex()}, '{}'::jsonb, ${hex()}, ${hex()}, true)
    returning id
  `;
  const [recipe] = await sql<{ id: string }[]>`
    insert into analysis.recipe_versions (
      recipe_key, version, run_type, input_schema_version, output_schema_version,
      required_artifacts, deterministic, manifest_sha256
    ) values (
      'gate_practice_recipe', '1', 'subject_live', 'a.v1', 'b.v1',
      array['findings']::text[], true, ${hex()}
    )
    returning id
  `;
  const [cohort] = await sql<{ id: string }[]>`
    insert into analysis.cohort_definition_versions (cohort_key, version, definition, definition_hash)
    values ('gate_practice_cohort', '1', '{}'::jsonb, ${hex()})
    returning id
  `;
  const [snapshot] = await sql<{ id: string }[]>`
    insert into analysis.subject_data_snapshots (
      subject_id, cohort_definition_version_id, cutoff, snapshot_hash, game_count, under_covered
    ) values (${subject!.id}, ${cohort!.id}, now(), ${hex()}, 0, true)
    returning id
  `;
  const [run] = await sql<{ id: string }[]>`
    insert into analysis.runs (
      run_type, recipe_version_id, subject_id, subject_data_snapshot_id, status,
      input_manifest_hash, output_manifest_hash, started_at, completed_at,
      trigger_kind, actor_kind
    ) values (
      'subject_live', ${recipe!.id}, ${subject!.id}, ${snapshot!.id}, 'succeeded',
      ${hex()}, ${hex()}, now(), now(), 'scheduled', 'system'
    )
    returning id
  `;
  // The game comes first: a materialization run belongs to a replay revision,
  // and the evidence and the opportunity both hang off it.
  const [providerGame] = await sql<{ id: string }[]>`
    insert into chess.provider_games (provider_id, provider_game_id)
    values (2, ${`gate-${randomUUID()}`})
    returning id
  `;
  const [replay] = await sql<{ id: string }[]>`
    insert into chess.game_replay_revisions (
      provider_game_id, revision_no, normalizer_component_version_id, normalized_replay,
      normalized_sha256, played_at, rated, speed, result, ply_count, revision_reason
    ) values (
      ${providerGame!.id}, 1, 'norm-v1', '{}'::jsonb, ${hex()}, now(), true, 'blitz', 'white',
      10, 'first_seen'
    )
    returning id
  `;
  const [subjectGame] = await sql<{ id: string }[]>`
    insert into chess.subject_games (
      subject_id, provider_game_id, latest_replay_revision_id, subject_color
    ) values (${subject!.id}, ${providerGame!.id}, ${replay!.id}, 'white')
    returning id
  `;
  const [materialization] = await sql<{ id: string }[]>`
    insert into chess.materialization_runs (
      replay_revision_id, materializer_version, checksum, state
    ) values (${replay!.id}, 'gate-materializer', ${hex()}, 'building')
    returning id
  `;
  const [evidence] = await sql<{ id: string }[]>`
    insert into analysis.evidence_items (run_id, evidence_kind, subject_id, occurred_at)
    values (${materialization!.id}, 'opportunity', ${subject!.id}, now())
    returning id
  `;
  const findingId = await sql.begin(async (tx) => {
    const [finding] = await tx<{ id: string }[]>`
      insert into analysis.findings (
        analysis_run_id, subject_id, finding_type, priority, confidence_tier, claim,
        claim_family
      ) values (
        ${run!.id}, ${subject!.id}, 'foundational_miss', 90, 'high',
        ${jsonParam({ dimension: "fork_recognize" })}::jsonb, 'concept_success'
      )
      returning id
    `;
    await tx`
      insert into analysis.finding_evidence (finding_id, evidence_item_id, role, display_rank)
      values (${finding!.id}, ${evidence!.id}, 'supports', 0)
    `;
    return finding!.id;
  });

  const [item] = await sql<{ id: string }[]>`
    insert into coaching.training_items (
      source_kind, owner_subject_id, provenance, retention_class
    ) values (
      'player_evidence', ${subject!.id}, 'derived from one of their own games', 'subject_owned'
    )
    returning id
  `;
  const [itemVersion] = await sql<{ id: string }[]>`
    insert into coaching.training_item_versions (
      item_id, version, fen, prompt, solution_uci, generation_method, content_sha256
    ) values (
      ${item!.id}, 1, 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      'Find the strongest continuation here.', array['e2e4','d2d4']::text[],
      'gate_fixture', ${hex()}
    )
    returning id
  `;
  const [assignment] = await sql<{ id: string }[]>`
    insert into coaching.learning_assignments (
      subject_id, training_item_version_id, finding_id, reason,
      selection_component_version_id, priority
    ) values (
      ${subject!.id}, ${itemVersion!.id}, ${findingId},
      'your report found this pattern costing you material repeatedly',
      ${version!.id}, 80
    )
    returning id
  `;

  // A real-game opportunity for the transfer match to point at.
  const [concept] = await sql<{ id: string }[]>`
    insert into analysis.concepts (slug, family, category, display_name)
    values (${`fork_${randomUUID().slice(0, 8)}`}, 'tactics', 'tactical', 'Fork')
    returning id
  `;
  const [conceptVersion] = await sql<{ id: string }[]>`
    insert into analysis.concept_versions (
      concept_id, version_no, human_definition, detector_contract, supported_roles,
      version_hash
    ) values (
      ${concept!.id}, 1, 'A fork attacks two targets at once.', '{}'::jsonb,
      array['recognize']::text[], ${hex()}
    )
    returning id
  `;
  const [event] = await sql<{ id: string }[]>`
    insert into analysis.chess_events (
      run_id, replay_revision_id, subject_game_id, event_type, start_ply, focal_ply,
      end_ply, actor_color, facts, completeness
    ) values (
      ${materialization!.id}, ${replay!.id}, ${subjectGame!.id}, 'tactical_opportunity',
      4, 4, 4, 'white', '{}'::jsonb, 'complete'
    )
    returning id
  `;
  const [opportunity] = await sql<{ id: string }[]>`
    insert into analysis.concept_opportunities (
      run_id, subject_id, subject_game_id, event_id, concept_version_id, role,
      opportunity_ply, response_ply, response_observed, success, evidence_source_kind,
      occurred_at
    ) values (
      ${materialization!.id}, ${subject!.id}, ${subjectGame!.id}, ${event!.id},
      ${conceptVersion!.id}, 'recognize', 4, 5, true, false, 'deterministic', now()
    )
    returning id
  `;

  return {
    subjectId: subject!.id,
    findingId,
    itemId: item!.id,
    itemVersionId: itemVersion!.id,
    assignmentId: assignment!.id,
    opportunityId: opportunity!.id,
    componentVersionId: version!.id,
  };
}
