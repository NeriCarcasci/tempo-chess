/**
 * Turning a player's own mistakes into practice.
 *
 * E18 shipped the scheduler, the transfer matcher and the tables, and nothing
 * created an assignment. The practice queue was permanently empty, so the
 * schedule never advanced and transfer had nothing to match against.
 *
 * This is the selector, and the shape of it is the product's central claim: a
 * drill is a position **from this person's own game** where the engine says
 * they had a better move and they did not play it. Not a themed puzzle set, not
 * a generic tactics stream — the decision they actually got wrong, put back in
 * front of them.
 *
 * That is also why every item minted here is `player_evidence` and
 * `subject_owned`: it is made of somebody's games, so it belongs to them and is
 * deleted with them. The database refuses any other combination.
 */

import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import { registerComponent, registerComponentVersion } from "../analysis/versions.js";
import { QUEUE_POLICY, SCHEDULER_POLICY } from "./contract.js";
import { shouldAssignMore } from "./scheduler.js";

export const PRACTICE_COMPONENT_KEY = "practice_selector";

/**
 * How a drill is chosen, versioned.
 *
 * An assignment records which version selected it, so "why was I given this"
 * has an answer that survives the rule changing.
 */
export const SELECTOR_POLICY = Object.freeze({
  version: "practice_selector_v1",
  /** Below this decision loss, the move was a shade rather than a mistake. */
  minDecisionLoss: 0.08,
  /** One drill per position: the same mistake twice is not two lessons. */
  perCycleLimit: QUEUE_POLICY.maxOutstanding,
  /** Days a fresh assignment is given before it expires unattempted. */
  dueInDays: SCHEDULER_POLICY.firstIntervalDays,
});

export async function registerPracticeComponents(sql: Sql): Promise<{ selectorVersionId: string }> {
  await registerComponent(sql, {
    componentKey: PRACTICE_COMPONENT_KEY,
    category: "projection",
    description:
      "Chooses practice from the decisions a player got wrong in their own games, ranked by what it cost them.",
    inputContract: "transition_assessment.v1",
    outputContract: "learning_assignment.v1",
  });
  const version = await registerComponentVersion(sql, {
    componentKey: PRACTICE_COMPONENT_KEY,
    version: SELECTOR_POLICY.version,
    implementationSha256: createHash("sha256")
      .update(`practice:${JSON.stringify(SELECTOR_POLICY)}`)
      .digest("hex"),
    configuration: SELECTOR_POLICY,
    deterministic: true,
  });
  return { selectorVersionId: version.id };
}

interface MistakeRow {
  core_position_id: string;
  fen: string;
  best_move_uci: string;
  played_move_uci: string;
  decision_loss: string;
  criticality: string | null;
  phase: string | null;
  subject_game_id: string;
}

export interface SelectionResult {
  assigned: number;
  outstanding: number;
  /** Set when nothing was assigned and it was not for want of mistakes. */
  reason?: "queue_full" | "no_material";
}

/**
 * Assign practice for one cycle.
 *
 * Refuses to add to a backlog: `shouldAssignMore` is the rule that a person
 * with a pile of outstanding work needs it cleared, not extended. A coaching
 * product that keeps assigning is a source of guilt.
 */
export async function assignPractice(
  sql: Sql,
  input: { subjectId: string; cycleId: string | null; limit?: number },
): Promise<SelectionResult> {
  const [outstandingRow] = await sql<{ count: string }[]>`
    select count(*)::text as count
    from coaching.learning_assignments
    where subject_id = ${input.subjectId} and status in ('assigned', 'in_progress')
  `;
  const outstanding = Number(outstandingRow?.count ?? 0);
  if (!shouldAssignMore(outstanding)) {
    return { assigned: 0, outstanding, reason: "queue_full" };
  }

  const want = Math.min(
    input.limit ?? QUEUE_POLICY.batchSize,
    QUEUE_POLICY.maxOutstanding - outstanding,
  );

  // The player's own mistakes, worst first, one per position, and only from
  // games this subject owns. `distinct on` keeps the costliest instance of a
  // repeated position rather than an arbitrary one.
  const mistakes = await sql<MistakeRow[]>`
    select distinct on (po.core_position_id)
           po.core_position_id::text as core_position_id,
           po.fen,
           ta.best_move_uci,
           ta.played_move_uci,
           ta.decision_loss::text as decision_loss,
           ta.criticality::text as criticality,
           ta.phase,
           sg.id as subject_game_id
    from analysis.transition_assessments ta
    join chess.position_occurrences po
      on po.run_id = ta.materialization_run_id and po.ply = ta.from_ply
    join analysis.runs r on r.id = ta.analysis_run_id
    join chess.subject_games sg on sg.id = r.subject_game_id
    where sg.subject_id = ${input.subjectId}
      and sg.status = 'included'
      and ta.played_move_acceptable = false
      and ta.best_move_uci is not null
      and ta.best_move_uci <> ta.played_move_uci
      and ta.decision_loss >= ${SELECTOR_POLICY.minDecisionLoss}
      and not exists (
        select 1
        from coaching.learning_assignments la
        join coaching.training_item_versions tv on tv.id = la.training_item_version_id
        where la.subject_id = ${input.subjectId} and tv.core_position_id = po.core_position_id
      )
    order by po.core_position_id, ta.decision_loss desc
    limit ${Math.max(want * 4, want)}
  `;
  if (mistakes.length === 0) return { assigned: 0, outstanding, reason: "no_material" };

  const ranked = [...mistakes]
    .sort((a, b) => Number(b.decision_loss) - Number(a.decision_loss))
    .slice(0, want);

  const { selectorVersionId } = await registerPracticeComponents(sql);
  let assigned = 0;

  for (const [index, mistake] of ranked.entries()) {
    const content = createHash("sha256")
      .update(`${mistake.fen}|${mistake.best_move_uci}|${SELECTOR_POLICY.version}`)
      .digest("hex");

    const written = await sql.begin(async (tx) => {
      const [item] = await tx<{ id: string }[]>`
        insert into coaching.training_items (
          source_kind, owner_subject_id, provenance, retention_class
        ) values (
          'player_evidence', ${input.subjectId},
          ${`A position from this player's own game, where the engine preferred ${mistake.best_move_uci}.`},
          'subject_owned'
        )
        returning id
      `;
      const [version] = await tx<{ id: string }[]>`
        insert into coaching.training_item_versions (
          item_id, version, core_position_id, fen, prompt, solution_uci,
          difficulty, generation_method, content_sha256
        ) values (
          ${item!.id}, 1, ${mistake.core_position_id}::bigint, ${mistake.fen},
          ${"You played " + mistake.played_move_uci + " here. Find the move that keeps more of your advantage."},
          ${[mistake.best_move_uci]},
          ${mistake.criticality === null ? null : Number(mistake.criticality)},
          'player_mistake_v1',
          ${content}
        )
        on conflict (content_sha256) do nothing
        returning id
      `;
      // The same position, already minted for this subject by an earlier pass.
      // Not an error and not work: the `not exists` above usually catches it,
      // and the unique index is what makes that race safe.
      if (!version) return 0;

      const [intervention] = await tx<{ id: string }[]>`
        insert into coaching.interventions (
          subject_id, cycle_id, evidence_item_id, intervention_type,
          training_item_version_id, channel
        )
        select ${input.subjectId}, ${input.cycleId}, e.id, 'drill', ${version.id}, 'in_app'
        from analysis.evidence_items e
        where e.subject_id = ${input.subjectId}
          and e.subject_game_id = ${mistake.subject_game_id}
        order by e.id
        limit 1
        returning id
      `;

      await tx`
        insert into coaching.learning_assignments (
          subject_id, cycle_id, training_item_version_id, intervention_id, reason,
          selection_component_version_id, priority, due_at
        ) values (
          ${input.subjectId}, ${input.cycleId}, ${version.id},
          ${intervention?.id ?? null},
          ${`In one of your games you played ${mistake.played_move_uci} in this position and it cost you ${Number(mistake.decision_loss).toFixed(2)} of expected score${mistake.phase ? ` in the ${mistake.phase}` : ""}.`},
          ${selectorVersionId},
          ${Math.max(0, Math.min(100, 100 - index * 5))},
          now() + make_interval(days => ${SELECTOR_POLICY.dueInDays})
        )
      `;
      return 1;
    });
    assigned += written as number;
  }

  return { assigned, outstanding: outstanding + assigned };
}
