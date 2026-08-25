/**
 * Planning the analysis of games that have arrived.
 *
 * The gap this fills is the one between "a sync landed forty games" and "the
 * report has something to read". E12 has the screening, deepening and
 * assessment handlers; E11 has the runs they belong to; nothing created a work
 * item for any of it. A synced game sat in the canonical tables and was never
 * looked at.
 *
 * It lives on the ops side rather than in a worker on purpose. E04 grants
 * `insert` on the ledger to `forma_api` and `forma_ops` only, so a worker
 * cannot create follow-on work — a real safety property, because a worker that
 * can create work can create unbounded work. The consequence is that "what
 * happens next" is decided by something with a wider view than one item, which
 * is what this sweep is.
 */

import type { Sql } from "postgres";
import { createWorkflow } from "../ops/ledger.js";
import { planGameAnalysis } from "../engine/plan.js";
import { withActor } from "../db/actor.js";
import { MATERIALIZE_TASK } from "../positions/worker.js";

export interface PlanPendingInput {
  /** Narrow to one subject, or sweep every subject with pending games. */
  subjectId?: string | null;
  /** A bound, so one sweep cannot enqueue a year of backlog at once. */
  limit?: number;
}

export interface PlanPendingResult {
  planned: number;
  skipped: number;
  reason?: "no_promoted_recipe";
}

interface PendingRow {
  subject_game_id: string;
  subject_id: string;
  owner_user_id: string | null;
}

/**
 * Plan a game analysis for every materialized game that has none.
 *
 * The planning itself is E12's `planGameAnalysis`, which already knows what a
 * game needs: the promoted recipe, the published materialization, the engine
 * and calibration versions the recipe pins, and the four items — screen, deepen,
 * assess, and E14's practical layer — in dependency order. This is the sweep in
 * front of it, and nothing more.
 *
 * `planGameAnalysis` is idempotent per run, so a sweep overlapping with a user
 * asking for the same game converges on one analysis rather than two.
 */
export async function planPendingGameAnalyses(
  sql: Sql,
  input: PlanPendingInput = {},
): Promise<PlanPendingResult> {
  const limit = Math.min(Math.max(1, Math.floor(input.limit ?? 50)), 500);

  const pending = await sql<PendingRow[]>`
    select sg.id as subject_game_id,
           sg.subject_id,
           s.owner_user_id
    from chess.subject_games sg
    join app.analysis_subjects s on s.id = sg.subject_id
    join chess.materialization_runs m
      on m.replay_revision_id = sg.latest_replay_revision_id and m.state = 'published'
    where sg.status = 'included'
      and sg.latest_replay_revision_id is not null
      and s.owner_user_id is not null
      -- Only games some frozen snapshot actually reads.
      --
      -- This swept every game the subject owned, and a baseline reads the
      -- cohort's newest two hundred. On the archive that measured it, three
      -- hundred and thirty three games were analysed so a report could read two
      -- hundred: a third of the engine time, the transitions, the concepts and
      -- the practical context all spent on games nothing would ever open. The
      -- work is not wasted for ever -- a later snapshot that includes them
      -- plans them then -- but it is not work the first report should wait on.
      and exists (
        select 1 from analysis.subject_data_snapshot_games sdg
        where sdg.subject_game_id = sg.id
      )
      and (${input.subjectId ?? null}::uuid is null or sg.subject_id = ${input.subjectId ?? null}::uuid)
      and not exists (
        select 1 from analysis.runs r
        where r.subject_game_id = sg.id
          and r.run_type = 'game_analysis'
          and r.status in ('planned', 'running', 'succeeded')
      )
    order by sg.id
    limit ${limit}
  `;

  let planned = 0;
  let skipped = 0;
  for (const game of pending) {
    // Bound to the owner of the game being planned, one at a time. The survey
    // above is deliberately cross-subject -- that is the question a sweep asks
    // -- but writing an `analysis.runs` row is an act on one subject, and its
    // policy resolves ownership through `private.current_actor_id()`. Unbound,
    // the insert is refused and the sweep reports `db_permission_denied` for
    // work it had correctly identified. The owner is already selected above for
    // exactly this purpose and was being passed as an argument while the
    // connection stayed anonymous.
    const outcome = await withActor(sql, game.owner_user_id!, (tx) =>
      planGameAnalysis(tx, {
        subjectGameId: game.subject_game_id,
        ownerProfileId: game.owner_user_id!,
        trigger: "scheduled",
      }),
    );
    if (outcome?.state === "scheduled") planned += 1;
    else if (outcome?.state === "unavailable" && outcome.reason === "no_promoted_recipe") {
      // Nothing is analysable without a promoted method, and every remaining
      // game will say the same thing. Stopping is honest; grinding through the
      // batch to fail identically is noise.
      return { planned, skipped, reason: "no_promoted_recipe" };
    } else skipped += 1;
  }

  return { planned, skipped };
}

/**
 * How many of a subject's games have not been analysed.
 *
 * Used by onboarding to decide whether to wait: freezing a snapshot over games
 * nothing has looked at produces a report that says the person is a beginner at
 * everything, which is not a truthful "we do not know yet" — it is a wrong
 * answer with a confident face.
 *
 * It used to inner-join a *published* materialization run, which quietly
 * excluded the one case the wait exists for. A game that has just been synced
 * has no materialization run at all, so it was not counted, so the count read
 * zero the instant a sync finished and the snapshot froze before the
 * materializer had touched a single new game. A hundred and thirty-seven games
 * arrived and the baseline was built from the ninety-eight that happened to be
 * ready — silently, because a report over a third of an archive looks exactly
 * like a report over all of it.
 *
 * A game with no materialization run is the clearest possible case of one
 * nothing has looked at, so it counts. What does not count is a game whose
 * materialization has permanently failed: that will never produce an analysis,
 * and blocking on it would trade a partial report for no report at all. Those
 * are excluded by name rather than by omission, so the reason is visible.
 */
export async function pendingAnalysisCount(sql: Sql, subjectId: string): Promise<number> {
  const [row] = await sql<{ count: string }[]>`
    select count(*)::text as count
    from chess.subject_games sg
    where sg.subject_id = ${subjectId}
      and sg.status = 'included'
      and not exists (
        select 1 from analysis.runs r
        where r.subject_game_id = sg.id
          and r.run_type = 'game_analysis'
          and r.status = 'succeeded'
      )
      and not exists (
        select 1 from chess.materialization_runs m
        where m.replay_revision_id = sg.latest_replay_revision_id
          and m.state = 'failed'
      )
  `;
  return Number(row?.count ?? 0);
}

/**
 * Plan materialization for replay revisions that have none.
 *
 * The step before analysis, and the reason a sweep runs it first: a game that
 * has not been turned into positions cannot be screened, so planning its
 * analysis would only produce an item that fails.
 */
/**
 * How many of a subject's games have not been turned into positions yet.
 *
 * `prepare` waits on this rather than on analysis. Freezing a snapshot needs a
 * published materialization per game -- `freezeSubjectSnapshot` joins one -- but
 * it does not need a single move to have been through the engine. Waiting for
 * analysis before freezing was what forced the whole archive to be analysed:
 * with no snapshot in existence there was nothing to scope the sweep to, so it
 * swept everything, and the run then waited for all of it.
 *
 * Freezing first inverts that. The snapshot names the cohort, the sweep plans
 * analysis for the cohort, and the report waits for the cohort -- so the games
 * outside it are never in anybody's way.
 */
export async function pendingMaterializationCount(sql: Sql, subjectId: string): Promise<number> {
  const [row] = await sql<{ count: string }[]>`
    select count(*)::text as count
    from chess.subject_games sg
    where sg.subject_id = ${subjectId}
      and sg.status = 'included'
      and sg.latest_replay_revision_id is not null
      and not exists (
        select 1 from chess.materialization_runs m
        where m.replay_revision_id = sg.latest_replay_revision_id
          and m.state = 'published'
      )
      -- A revision whose materialization has permanently failed will never
      -- produce one, and blocking on it would trade a partial baseline for no
      -- baseline at all.
      and not exists (
        select 1 from chess.materialization_runs m
        where m.replay_revision_id = sg.latest_replay_revision_id
          and m.state = 'failed'
      )
  `;
  return Number(row?.count ?? 0);
}

/**
 * How many of a snapshot's games still have no successful analysis.
 *
 * Scoped to the snapshot rather than to the subject, which is the whole point
 * of freezing first: the report waits for the cohort it will actually read and
 * not for every game the archive happens to contain.
 */
export async function snapshotAnalysisPending(sql: Sql, snapshotId: string): Promise<number> {
  const [row] = await sql<{ count: string }[]>`
    select count(*)::text as count
    from analysis.subject_data_snapshot_games sdg
    where sdg.snapshot_id = ${snapshotId}
      and not exists (
        select 1 from analysis.runs r
        where r.subject_game_id = sdg.subject_game_id
          and r.run_type = 'game_analysis'
          and r.status = 'succeeded'
      )
  `;
  return Number(row?.count ?? 0);
}

export async function planPendingMaterializations(
  sql: Sql,
  input: PlanPendingInput = {},
): Promise<{ planned: number }> {
  const limit = Math.min(Math.max(1, Math.floor(input.limit ?? 50)), 500);
  const pending = await sql<
    { replay_revision_id: string; subject_id: string; owner_user_id: string | null }[]
  >`
    select distinct sg.latest_replay_revision_id as replay_revision_id,
           sg.subject_id, s.owner_user_id
    from chess.subject_games sg
    join app.analysis_subjects s on s.id = sg.subject_id
    where sg.status = 'included'
      and sg.latest_replay_revision_id is not null
      and (${input.subjectId ?? null}::uuid is null or sg.subject_id = ${input.subjectId ?? null}::uuid)
      and not exists (
        select 1 from chess.materialization_runs m
        where m.replay_revision_id = sg.latest_replay_revision_id and m.state = 'published'
      )
    limit ${limit}
  `;
  if (pending.length === 0) return { planned: 0 };

  await createWorkflow({
    kind: "game_import",
    ownerProfileId: pending[0]!.owner_user_id,
    resource: { type: "subject", id: pending[0]!.subject_id },
    items: [...pending].map((row) => ({
      taskType: MATERIALIZE_TASK,
      resourceClass: "aggregation" as const,
      payload: { replayRevisionId: row.replay_revision_id },
      // Keyed by the revision, so two sweeps overlapping do not materialize the
      // same replay twice and the ledger refuses the duplicate rather than the
      // handler discovering it.
      idempotencyKey: `materialize:${row.replay_revision_id}`,
      queue: "analysis" as const,
    })),
  });
  return { planned: pending.length };
}

/**
 * One sweep: materialize what has not been materialized, then analyse what has
 * not been analysed.
 *
 * Ordered rather than concurrent, and bounded, because the second half depends
 * on the first. A sweep that finds nothing to do is the normal case.
 */
export async function planPendingWork(
  sql: Sql,
  input: PlanPendingInput = {},
): Promise<{ materializations: number; analyses: number; skipped: number }> {
  const materializations = await planPendingMaterializations(sql, input);
  const analyses = await planPendingGameAnalyses(sql, input);
  return {
    materializations: materializations.planned,
    analyses: analyses.planned,
    skipped: analyses.skipped,
  };
}
