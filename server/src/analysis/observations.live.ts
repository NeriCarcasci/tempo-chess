/**
 * `npm run analysis:live` — the same invariants, enforced by the database.
 *
 * The pure functions in `observations.ts` are what a detector calls. These
 * checks prove the constraints hold even when nobody calls them, by attempting
 * each violation directly. A detector is rewritten every time a version is
 * promoted; a check constraint is not.
 *
 * Needs `DATABASE_URL`. Every row it creates is removed at the end.
 */

import { strict as assert } from "node:assert";
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
let passed = 0;
const failures: string[] = [];

async function check(name: string, body: () => Promise<string>): Promise<void> {
  try {
    console.log(`ok   ${name} — ${await body()}`);
    passed += 1;
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    console.log(`FAIL ${name}`);
  }
}

async function refused(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

const STAMP = Date.now();
const OWNER = "00000000-0000-4000-8000-00000000e131";
const HASH = (n: number) => `${n}`.padStart(64, "0").replace(/[^0-9a-f]/g, "0");

// Fixture: a subject, a game, a materialization run to hang events off.
await sql`delete from app.profiles where user_id = ${OWNER}`;
await sql`insert into app.profiles (user_id) values (${OWNER})`;
const [subject] = await sql<{ id: string }[]>`
  insert into app.analysis_subjects (kind, owner_user_id, display_label)
  values ('personal', ${OWNER}, 'e13 probe') returning id
`;
const [game] = await sql<{ id: string }[]>`
  insert into chess.provider_games (provider_id, provider_game_id)
  values (2, ${`e13-probe-${STAMP}`}) returning id
`;
const [revision] = await sql<{ id: string }[]>`
  insert into chess.game_replay_revisions (
    provider_game_id, revision_no, normalizer_component_version_id, normalized_replay,
    normalized_sha256, played_at, result, ply_count, revision_reason
  ) values (${game.id}, 1, 'norm-v1', '{"moves":[]}'::jsonb, ${HASH(1)}, now(), 'white', 40, 'first_seen')
  returning id
`;
const [subjectGame] = await sql<{ id: string }[]>`
  insert into chess.subject_games (subject_id, provider_game_id, subject_color, status)
  values (${subject.id}, ${game.id}, 'white', 'included') returning id
`;
const [run] = await sql<{ id: string }[]>`
  insert into chess.materialization_runs (
    replay_revision_id, materializer_version, checksum, state, occurrence_count, transition_count
  ) values (${revision.id}, 'core-1', ${HASH(2)}, 'building', 1, 0) returning id
`;
const [concept] = await sql<{ id: string }[]>`
  insert into analysis.concepts (slug, family, category, display_name)
  values (${`probe-fork-${STAMP}`}, 'tactics', 'tactical', 'Fork') returning id
`;
const [version] = await sql<{ id: string }[]>`
  insert into analysis.concept_versions (
    concept_id, version_no, human_definition, detector_contract, supported_roles, version_hash
  ) values (${concept.id}, 1, 'A fork', '{}'::jsonb, array['recognize','execute'], ${HASH(3)})
  returning id
`;
const [event] = await sql<{ id: string }[]>`
  insert into analysis.chess_events (
    run_id, replay_revision_id, subject_game_id, event_type,
    start_ply, focal_ply, end_ply, facts, completeness
  ) values (${run.id}, ${revision.id}, ${subjectGame.id}, 'tactical_execution',
            18, 20, 22, '{}'::jsonb, 'complete') returning id
`;

const base = {
  run_id: run.id,
  subject_id: subject.id,
  subject_game_id: subjectGame.id,
  event_id: event.id,
  concept_version_id: version.id,
};

async function insertOpportunity(over: Record<string, unknown>): Promise<void> {
  const row = {
    ...base,
    role: "execute",
    opportunity_ply: 20,
    response_ply: 21,
    response_observed: true,
    censored_reason: null,
    success: false,
    score: null,
    rubric_component_version_id: null,
    evidence_source_kind: "deterministic",
    occurred_at: new Date(),
    ...over,
  };
  await sql`insert into analysis.concept_opportunities ${sql(row as never)}`;
}

console.log("cd server && npm run analysis:live\n");

await check("a censored opportunity cannot record success or failure", async () => {
  const failed = await refused(() =>
    insertOpportunity({ response_observed: false, response_ply: null, censored_reason: "opponent_resigned", success: false }),
  );
  const succeeded = await refused(() =>
    insertOpportunity({ response_observed: false, response_ply: null, censored_reason: "game_ended", success: true }),
  );
  if (!failed || !succeeded) throw new Error(`false refused=${failed}, true refused=${succeeded}`);
  return "both success=false and success=true refused when unobserved";
});

await check("a censored opportunity must state a reason", async () => {
  const noReason = await refused(() =>
    insertOpportunity({ response_observed: false, response_ply: null, censored_reason: null, success: null }),
  );
  if (!noReason) throw new Error("a censored row with no reason was accepted");
  return "refused";
});

await check("an observed opportunity must record an outcome", async () => {
  const noSuccess = await refused(() => insertOpportunity({ success: null }));
  const noPly = await refused(() => insertOpportunity({ response_ply: null }));
  if (!noSuccess || !noPly) throw new Error(`success refused=${noSuccess}, ply refused=${noPly}`);
  return "null success and missing response ply both refused";
});

await check("a score cannot exist without its rubric", async () => {
  const bare = await refused(() => insertOpportunity({ score: 0.6, rubric_component_version_id: null }));
  const [ok] = await sql<{ id: string }[]>`
    insert into analysis.concept_opportunities (
      run_id, subject_id, subject_game_id, event_id, concept_version_id, role,
      opportunity_ply, response_ply, response_observed, success, score,
      rubric_component_version_id, evidence_source_kind, occurred_at
    ) values (
      ${run.id}, ${subject.id}, ${subjectGame.id}, ${event.id}, ${version.id}, 'execute',
      20, 21, true, true, 0.6, ${version.id}, 'deterministic', now()
    ) returning id
  `;
  await sql`delete from analysis.concept_opportunities where id = ${ok.id}`;
  if (!bare) throw new Error("a score without a rubric was accepted");
  return "0.6 alone refused; 0.6 with a rubric version accepted";
});

await check("recognition and execution are two rows, not one blended score", async () => {
  const [a] = await sql<{ id: string }[]>`
    insert into analysis.concept_opportunities (
      run_id, subject_id, subject_game_id, event_id, concept_version_id, role,
      opportunity_ply, response_ply, response_observed, success, evidence_source_kind, occurred_at
    ) values (${run.id}, ${subject.id}, ${subjectGame.id}, ${event.id}, ${version.id}, 'recognize',
              20, 21, true, true, 'deterministic', now()) returning id
  `;
  const [b] = await sql<{ id: string }[]>`
    insert into analysis.concept_opportunities (
      run_id, subject_id, subject_game_id, event_id, concept_version_id, role,
      opportunity_ply, response_ply, response_observed, success, evidence_source_kind, occurred_at
    ) values (${run.id}, ${subject.id}, ${subjectGame.id}, ${event.id}, ${version.id}, 'execute',
              20, 21, true, false, 'deterministic', now()) returning id
  `;
  const rows = await sql<{ role: string; success: boolean }[]>`
    select role, success from analysis.concept_opportunities
    where event_id = ${event.id} order by role
  `;
  await sql`delete from analysis.concept_opportunities where id in (${a.id}, ${b.id})`;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => `${r.role}=${r.success}`), ["execute=false", "recognize=true"]);
  return "same event, two roles, opposite outcomes, both retained";
});

await check("an event's plies must run forward through its focal moment", async () => {
  const backwards = await refused(() => sql`
    insert into analysis.chess_events (run_id, replay_revision_id, event_type, start_ply, focal_ply, end_ply, facts, completeness)
    values (${run.id}, ${revision.id}, 'threat_sequence', 22, 20, 18, '{}'::jsonb, 'complete')
  `);
  if (!backwards) throw new Error("an event ending before it started was accepted");
  return "start <= focal <= end enforced";
});

await check("a relation cannot point at itself", async () => {
  const self = await refused(() => sql`
    insert into analysis.event_relations (from_event_id, to_event_id, relation_type, run_id, method_version, components)
    values (${event.id}, ${event.id}, 'improved_response', ${run.id}, 'structural-v1', '{}'::jsonb)
  `);
  if (!self) throw new Error("an event was recorded as an improvement on itself");
  return "refused";
});

await check("a concept version must declare known roles", async () => {
  const bogus = await refused(() => sql`
    insert into analysis.concept_versions (concept_id, version_no, human_definition, detector_contract, supported_roles, version_hash)
    values (${concept.id}, 2, 'x', '{}'::jsonb, array['vibes'], ${HASH(4)})
  `);
  const empty = await refused(() => sql`
    insert into analysis.concept_versions (concept_id, version_no, human_definition, detector_contract, supported_roles, version_hash)
    values (${concept.id}, 3, 'x', '{}'::jsonb, array[]::text[], ${HASH(5)})
  `);
  if (!bogus || !empty) throw new Error(`unknown role refused=${bogus}, empty refused=${empty}`);
  return "an invented role and an empty role list both refused";
});

await check("opportunities and episodes are tenant-scoped and forced", async () => {
  const rows = await sql<{ t: string; rls: boolean; forced: boolean }[]>`
    select c.relname as t, c.relrowsecurity as rls, c.relforcerowsecurity as forced
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'analysis'
      and c.relname in ('concept_opportunities','evidence_items','trajectory_episodes')
  `;
  const bad = rows.filter((r) => !r.rls || !r.forced);
  if (bad.length) throw new Error(`${bad.map((b) => b.t).join(", ")} unforced`);
  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from information_schema.role_table_grants
    where table_schema = 'analysis' and grantee in ('anon','authenticated','service_role','PUBLIC')
  `;
  if (n !== 0) throw new Error(`${n} browser grants on analysis`);
  return `${rows.length} tenant tables forced; 0 browser grants`;
});

// Cleanup.
await sql`delete from analysis.concept_opportunities where run_id = ${run.id}`;
await sql`delete from analysis.event_relations where run_id = ${run.id}`;
await sql`delete from analysis.event_concepts where event_id = ${event.id}`;
await sql`delete from analysis.chess_events where run_id = ${run.id}`;
await sql`delete from analysis.concept_versions where concept_id = ${concept.id}`;
await sql`delete from analysis.concepts where id = ${concept.id}`;
await sql`delete from chess.materialization_runs where id = ${run.id}`;
await sql`delete from chess.subject_games where id = ${subjectGame.id}`;
await sql`alter table chess.game_replay_revisions disable trigger replay_revisions_immutable`;
await sql`delete from chess.game_replay_revisions where id = ${revision.id}`;
await sql`alter table chess.game_replay_revisions enable trigger replay_revisions_immutable`;
await sql`delete from chess.provider_games where id = ${game.id}`;
await sql`delete from app.profiles where user_id = ${OWNER}`;
const [{ left }] = await sql<{ left: number }[]>`
  select count(*)::int as left from chess.provider_games where provider_game_id = ${`e13-probe-${STAMP}`}
`;
await sql.end();

console.log(`\n${passed} passed, ${failures.length} failed (rows left behind: ${left})`);
if (failures.length > 0 || left > 0) {
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
}
