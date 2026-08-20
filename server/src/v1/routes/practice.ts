import { z } from "zod";
import { withActorContext } from "../auth/context.js";
import { client } from "../../db/client.js";
import { isoOf, requiredIso } from "../../db/timestamps.js";
import { ProblemError } from "../problem.js";
import { POLICIES } from "../rate-limit.js";
import type { RouteDefinition } from "../registry.js";
import { QUEUE_POLICY } from "../../practice/contract.js";
import { buildQueue, nextReview } from "../../practice/scheduler.js";
import { assignPractice, registerPracticeComponents } from "../../practice/select.js";

/**
 * The practice surface.
 *
 * E18 built the scheduler, the transfer matcher and the tables and mounted no
 * routes, so none of it was reachable. These three are the smallest surface
 * that makes the loop real: see what is due, attempt it, and have the schedule
 * move.
 *
 * Two things are deliberate and worth stating.
 *
 * The queue **never returns the solution**. A drill that ships its own answer
 * is a rendering of the answer. The expected moves are compared server-side and
 * come back in the attempt's response, after the person has committed.
 *
 * An attempt is idempotent on a client-supplied id, and the schedule advances
 * inside the same transaction. A retried submission on a flaky connection must
 * not count twice — spaced repetition where a double-tap doubles the interval
 * is a schedule that quietly stops meaning anything.
 */

const queueItemSchema = z.object({
  assignmentId: z.string(),
  fen: z.string(),
  prompt: z.string(),
  reason: z.string(),
  priority: z.number().int(),
  dueAt: z.string().nullable(),
  /** Set once the item has been attempted before and is coming back around. */
  reviewNumber: z.number().int(),
});

const queueSchema = z.object({
  items: z.array(queueItemSchema),
  remaining: z.number().int(),
  overdue: z.number().int(),
  /** Why the queue is empty, when it is. Never a bare empty list. */
  emptyReason: z.enum(["none", "nothing_due", "no_material", "queue_full"]).nullable(),
});

const queueRoute: RouteDefinition<never, never, z.infer<typeof queueSchema>> = {
  method: "GET",
  path: "/v1/practice/queue",
  operationId: "getPracticeQueue",
  summary: "What to practise now, and why",
  description:
    "Overdue work first, capped so a queue is never only a backlog. Each item says which of your own games it came from. The expected move is never in this response.",
  kind: "read",
  auth: "required",
  envelope: "resource",
  successStatus: 200,
  dataSchema: queueSchema,
  cacheControl: "private, max-age=0, must-revalidate",
  rateLimits: [{ policy: POLICIES.onboardingRead, source: "actor" }],
  async handler({ auth }) {
    if (!auth) throw new ProblemError("AUTH_REQUIRED");
    const subjectId = auth.subjects[0];
    if (!subjectId) throw new ProblemError("NOT_FOUND", { detail: "No subject." });

    return withActorContext(auth.profileId, async (sql) => {
      const rows = await sql<
        {
          assignment_id: string;
          training_item_version_id: string;
          fen: string;
          prompt: string;
          reason: string;
          priority: number;
          due_at: string | Date | null;
          assigned_at: string | Date;
          attempts: number;
        }[]
      >`
        select la.id as assignment_id, la.training_item_version_id, tv.fen, tv.prompt,
               la.reason, la.priority,
               coalesce(rs.due_at, la.due_at) as due_at,
               la.assigned_at,
               (select count(*)::int from coaching.practice_attempts a
                 where a.assignment_id = la.id) as attempts
        from coaching.learning_assignments la
        join coaching.training_item_versions tv on tv.id = la.training_item_version_id
        left join coaching.review_schedules rs
          on rs.subject_id = la.subject_id
         and rs.training_item_version_id = la.training_item_version_id
        where la.subject_id = ${subjectId} and la.status in ('assigned', 'in_progress')
        order by la.priority desc, la.assigned_at
        limit ${QUEUE_POLICY.maxOutstanding}
      `;

      const now = new Date();
      const queue = buildQueue(
        [...rows].map((row) => ({
          assignmentId: row.assignment_id,
          trainingItemVersionId: row.training_item_version_id,
          priority: row.priority,
          dueAt: row.due_at === null ? null : new Date(row.due_at),
          assignedAt: new Date(row.assigned_at),
        })),
        now,
      );
      const byId = new Map([...rows].map((row) => [row.assignment_id, row]));

      // A queue with outstanding work that is not yet due is a different answer
      // from one with no work at all, and the client should say so rather than
      // showing the same empty state for both.
      const emptyReason =
        queue.items.length > 0
          ? null
          : rows.length > 0
            ? ("nothing_due" as const)
            : ("no_material" as const);

      return {
        data: {
          items: queue.items.map((item) => {
            const row = byId.get(item.assignmentId)!;
            return {
              assignmentId: item.assignmentId,
              fen: row.fen,
              prompt: row.prompt,
              reason: row.reason,
              priority: row.priority,
              dueAt: isoOf(row.due_at),
              reviewNumber: row.attempts,
            };
          }),
          remaining: queue.remaining,
          overdue: queue.overdue,
          emptyReason,
        },
      };
    });
  },
};

const attemptBody = z.object({
  assignmentId: z.uuid(),
  /** The client's own id for this attempt, so a retry is not a second attempt. */
  clientAttemptId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
  moves: z.array(z.string().min(2).max(6)).min(1).max(8),
  responseTimeMs: z.number().int().min(0).max(3_600_000).optional(),
  hintsUsed: z.number().int().min(0).max(3).optional(),
  retries: z.number().int().min(0).max(20).optional(),
  revealed: z.boolean().optional(),
});

const attemptSchema = z.object({
  attemptId: z.string(),
  success: z.boolean(),
  /** Shown only now, after the person has committed to an answer. */
  expected: z.array(z.string()),
  nextDueAt: z.string(),
  intervalDays: z.number(),
  /** True when this attempt was a replay of one already recorded. */
  duplicate: z.boolean(),
});

const attemptRoute: RouteDefinition<never, z.infer<typeof attemptBody>, z.infer<typeof attemptSchema>> = {
  method: "POST",
  path: "/v1/practice/attempts",
  operationId: "recordPracticeAttempt",
  summary: "Record one practice attempt and advance the schedule",
  description:
    "Idempotent on `clientAttemptId`. The expected moves come back in this response and never before it. A revealed answer is never a success, whatever was submitted afterwards.",
  kind: "command",
  auth: "required",
  idempotency: "key",
  envelope: "resource",
  successStatus: 201,
  bodySchema: attemptBody,
  dataSchema: attemptSchema,
  rateLimits: [{ policy: POLICIES.onboardingCommand, source: "actor" }],
  async handler({ auth, body }) {
    if (!auth) throw new ProblemError("AUTH_REQUIRED");
    const subjectId = auth.subjects[0];
    if (!subjectId) throw new ProblemError("NOT_FOUND", { detail: "No subject." });

    const { selectorVersionId } = await registerPracticeComponents(client);

    return withActorContext(auth.profileId, async (sql) => {
      const [assignment] = await sql<
        { id: string; training_item_version_id: string; solution_uci: string[]; status: string }[]
      >`
        select la.id, la.training_item_version_id, tv.solution_uci, la.status
        from coaching.learning_assignments la
        join coaching.training_item_versions tv on tv.id = la.training_item_version_id
        where la.id = ${body.assignmentId} and la.subject_id = ${subjectId}
      `;
      if (!assignment) throw new ProblemError("NOT_FOUND", { detail: "No such assignment." });

      const expected = assignment.solution_uci;
      // A revealed answer is not a success even when the move that follows is
      // right: the point of the record is what the person could do unaided.
      const revealed = body.revealed ?? false;
      const success = !revealed && body.moves[0] === expected[0];

      const [existing] = await sql<{ id: string }[]>`
        select id from coaching.practice_attempts
        where assignment_id = ${body.assignmentId}
          and client_attempt_id = ${body.clientAttemptId}
      `;

      const result = await sql.begin(async (tx) => {
        if (existing) {
          const [schedule] = await tx<{ due_at: string | Date; interval_days: string }[]>`
            select due_at, interval_days from coaching.review_schedules
            where subject_id = ${subjectId}
              and training_item_version_id = ${assignment.training_item_version_id}
          `;
          return {
            attemptId: existing.id,
            duplicate: true,
            dueAt: schedule ? requiredIso(schedule.due_at, "review_schedules.due_at") : null,
            intervalDays: schedule ? Number(schedule.interval_days) : 0,
          };
        }

        const [attempt] = await tx<{ id: string }[]>`
          insert into coaching.practice_attempts (
            assignment_id, training_item_version_id, client_attempt_id, submitted_uci,
            response_time_ms, hints_used, retries, revealed, success, score,
            rubric_component_version_id
          ) values (
            ${body.assignmentId}, ${assignment.training_item_version_id},
            ${body.clientAttemptId}, ${body.moves},
            ${body.responseTimeMs ?? null}, ${body.hintsUsed ?? 0}, ${body.retries ?? 0},
            ${revealed}, ${success}, ${success ? 1 : 0}, ${selectorVersionId}
          )
          returning id
        `;

        const [current] = await tx<
          { interval_days: string; stability: string | null; difficulty: string | null }[]
        >`
          select interval_days, stability, difficulty from coaching.review_schedules
          where subject_id = ${subjectId}
            and training_item_version_id = ${assignment.training_item_version_id}
        `;
        const next = nextReview(
          current
            ? {
                intervalDays: Number(current.interval_days),
                stability: current.stability === null ? null : Number(current.stability),
                difficulty: current.difficulty === null ? null : Number(current.difficulty),
              }
            : null,
          {
            success,
            hintsUsed: body.hintsUsed ?? 0,
            revealed,
            retries: body.retries ?? 0,
          },
          new Date(),
        );

        await tx`
          insert into coaching.review_schedules (
            subject_id, training_item_version_id, scheduler_component_version_id,
            due_at, interval_days, stability, difficulty, last_attempt_id
          ) values (
            ${subjectId}, ${assignment.training_item_version_id}, ${selectorVersionId},
            ${next.dueAt}, ${next.intervalDays}, ${next.stability}, ${next.difficulty},
            ${attempt!.id}
          )
          on conflict (subject_id, training_item_version_id) do update
            set due_at = excluded.due_at,
                interval_days = excluded.interval_days,
                stability = excluded.stability,
                difficulty = excluded.difficulty,
                last_attempt_id = excluded.last_attempt_id,
                updated_at = now()
        `;

        // A successful first pass closes the assignment; the item lives on in
        // the review schedule, which is where repetition belongs. A failure
        // leaves it open, because it is still work to do.
        if (success) {
          await tx`
            update coaching.learning_assignments
            set status = 'completed', completed_at = now()
            where id = ${body.assignmentId} and status in ('assigned', 'in_progress')
          `;
        } else {
          await tx`
            update coaching.learning_assignments
            set status = 'in_progress'
            where id = ${body.assignmentId} and status = 'assigned'
          `;
        }

        return {
          attemptId: attempt!.id,
          duplicate: false,
          dueAt: next.dueAt.toISOString(),
          intervalDays: next.intervalDays,
        };
      });

      return {
        status: result.duplicate ? 200 : 201,
        data: {
          attemptId: String(result.attemptId),
          success,
          expected: [...expected],
          nextDueAt: result.dueAt ?? new Date().toISOString(),
          intervalDays: result.intervalDays,
          duplicate: result.duplicate,
        },
      };
    });
  },
};

const refillSchema = z.object({
  assigned: z.number().int(),
  outstanding: z.number().int(),
  reason: z.enum(["queue_full", "no_material"]).nullable(),
});

const refillRoute: RouteDefinition<never, Record<string, never>, z.infer<typeof refillSchema>> = {
  method: "POST",
  path: "/v1/practice/refill",
  operationId: "refillPracticeQueue",
  summary: "Assign practice from your own recent mistakes",
  description:
    "Mints drills from positions in your own games where the engine preferred another move. Refuses to add to a backlog: a queue that is already full is left alone, and the reason says so.",
  kind: "command",
  auth: "required",
  idempotency: "key",
  envelope: "resource",
  successStatus: 200,
  bodySchema: z.object({}).strict(),
  dataSchema: refillSchema,
  rateLimits: [{ policy: POLICIES.onboardingCommand, source: "actor" }],
  async handler({ auth }) {
    if (!auth) throw new ProblemError("AUTH_REQUIRED");
    const subjectId = auth.subjects[0];
    if (!subjectId) throw new ProblemError("NOT_FOUND", { detail: "No subject." });

    const [cycle] = await client<{ id: string }[]>`
      select c.id
      from coaching.coaching_cycles c
      join coaching.goals g on g.id = c.goal_id
      where g.subject_id = ${subjectId} and c.status = 'active' and g.status = 'active'
      limit 1
    `;

    const result = await assignPractice(client, {
      subjectId,
      cycleId: cycle?.id ?? null,
    });
    return {
      data: {
        assigned: result.assigned,
        outstanding: result.outstanding,
        reason: result.reason ?? null,
      },
    };
  },
};

export const PRACTICE_ROUTES = [queueRoute, attemptRoute, refillRoute] as const;
