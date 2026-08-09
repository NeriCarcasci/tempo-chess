import { client } from "../db/client.js";

/**
 * Repertoire selection, training results, and lesson progress — the data behind
 * the account page. Everything is keyed to a user's profile id, resolved from the
 * chess username the client holds in its session.
 */

type Color = "white" | "black";

// Profile ids are immutable, so username -> id resolves once and stays valid; this
// saves a DB round-trip on every account/training/lessons request.
const userIdCache = new Map<string, string>();

async function resolveUserId(username: string): Promise<string> {
  const key = username.trim().toLowerCase();
  const cached = userIdCache.get(key);
  if (cached) return cached;
  const rows = await client`
    select p.id as user_id
    from linked_accounts a join profiles p on p.id = a.user_id
    where a.normalized_username = ${key}
    order by a.created_at asc limit 1`;
  if (!rows[0]) throw new Error(`No imported account found for "${username}"`);
  const userId = String(rows[0].user_id);
  userIdCache.set(key, userId);
  return userId;
}

export interface RepertoireSummary {
  openings: Array<{ color: Color; family: string; addedAt: string }>;
  stats: Array<{
    color: Color;
    family: string;
    sessions: number;
    correct: number;
    total: number;
    reveals: number;
    accuracy: number | null;
    lastPracticed: string | null;
  }>;
}

export async function listRepertoire(username: string): Promise<RepertoireSummary> {
  const userId = await resolveUserId(username);
  const [openings, stats] = await Promise.all([
    client`
      select color, family, created_at
      from repertoire_openings where user_id = ${userId}
      order by created_at asc`,
    client`
      select color, family,
        count(*)::int as sessions,
        coalesce(sum(moves_correct), 0)::int as correct,
        coalesce(sum(moves_total), 0)::int as total,
        coalesce(sum(reveals), 0)::int as reveals,
        max(completed_at) as last_practiced
      from opening_training_results
      where user_id = ${userId} and family is not null
      group by color, family`,
  ]);
  return {
    openings: openings.map((r) => ({
      color: r.color as Color,
      family: String(r.family),
      addedAt: new Date(r.created_at as string).toISOString(),
    })),
    stats: stats.map((r) => {
      const total = Number(r.total);
      const correct = Number(r.correct);
      return {
        color: r.color as Color,
        family: String(r.family),
        sessions: Number(r.sessions),
        correct,
        total,
        reveals: Number(r.reveals),
        accuracy: total ? correct / total : null,
        lastPracticed: r.last_practiced ? new Date(r.last_practiced as string).toISOString() : null,
      };
    }),
  };
}

export async function setRepertoireOpening(
  username: string,
  color: Color,
  family: string,
  enabled: boolean,
): Promise<{ color: Color; family: string; enabled: boolean }> {
  const userId = await resolveUserId(username);
  if (enabled) {
    await client`
      insert into repertoire_openings (user_id, color, family)
      values (${userId}, ${color}, ${family})
      on conflict (user_id, color, family) do nothing`;
  } else {
    await client`
      delete from repertoire_openings
      where user_id = ${userId} and color = ${color} and family = ${family}`;
  }
  return { color, family, enabled };
}

export async function recordTrainingResult(
  username: string,
  input: { color: Color; family: string | null; lineUci: string; correct: number; total: number; reveals: number },
): Promise<{ id: string; completedAt: string }> {
  const userId = await resolveUserId(username);
  const rows = await client`
    insert into opening_training_results
      (user_id, color, family, line_uci, moves_correct, moves_total, reveals)
    values (${userId}, ${input.color}, ${input.family ?? null}, ${input.lineUci},
      ${input.correct}, ${input.total}, ${input.reveals})
    returning id, completed_at`;
  return { id: String(rows[0]!.id), completedAt: new Date(rows[0]!.completed_at as string).toISOString() };
}

export interface PracticeActivity {
  streak: number;
  practicedToday: boolean;
  activeDays30: number;
  totalSessions: number;
}

/** Current daily practice streak + recent activity, from drill and lesson timestamps. */
export async function getPracticeActivity(username: string): Promise<PracticeActivity> {
  const userId = await resolveUserId(username);
  const rows = await client`
    select distinct (d at time zone 'UTC')::date as day from (
      select completed_at as d from opening_training_results where user_id = ${userId} and completed_at is not null
      union all
      select completed_at as d from lesson_progress where user_id = ${userId} and completed_at is not null
    ) t
    order by day desc`;
  const days = rows.map((r) => String(r.day)); // 'YYYY-MM-DD' desc
  const daySet = new Set(days);
  const iso = (dt: Date) => dt.toISOString().slice(0, 10);
  const today = new Date();
  const practicedToday = daySet.has(iso(today));
  // Streak: consecutive days ending today or yesterday.
  let streak = 0;
  const cursor = new Date(today);
  if (!practicedToday) cursor.setUTCDate(cursor.getUTCDate() - 1); // allow "yesterday" to keep a streak alive
  while (daySet.has(iso(cursor))) {
    streak += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  const cutoff = new Date(today);
  cutoff.setUTCDate(cutoff.getUTCDate() - 30);
  const activeDays30 = days.filter((d) => new Date(d) >= cutoff).length;
  return { streak, practicedToday, activeDays30, totalSessions: days.length };
}

export interface MistakeDrill {
  positionKey: string;
  fen: string;
  playedUci: string;
  playedSan: string;
  bestUci: string;
  openingName: string | null;
  ply: number;
  lossCp: number | null;
}

/**
 * The user's worst opening decisions (from real games) that the engine can improve
 * on — deduplicated to the single worst instance per position, ordered by how much
 * eval was lost. The raw material for a "fix your mistakes" drill.
 */
export async function getMistakeDrills(username: string, color: Color, limit = 15): Promise<MistakeDrill[]> {
  const userId = await resolveUserId(username);
  const rows = await client`
    select * from (
      select distinct on (o.position_key)
        o.position_key, p.fen, o.move_uci as played_uci, o.move_san as played_san,
        o.opening_name, o.ply, o.evaluation_loss_cp as loss, pe.best_move_uci as best_uci
      from player_opening_observations o
      join opening_positions p on p.position_key = o.position_key
      left join lateral (
        select best_move_uci from position_eval
        where fen = p.fen and profile_id = 'screening'
        order by computed_at desc limit 1
      ) pe on true
      where o.user_id = ${userId} and o.actor_is_player and o.acceptable = false
        and o.player_color = ${color}
        and pe.best_move_uci is not null and pe.best_move_uci <> o.move_uci
      order by o.position_key, o.evaluation_loss_cp desc nulls last
    ) t
    order by t.loss desc nulls last
    limit ${limit}`;
  return rows.map((r) => ({
    positionKey: String(r.position_key),
    fen: String(r.fen),
    playedUci: String(r.played_uci),
    playedSan: String(r.played_san),
    bestUci: String(r.best_uci),
    openingName: r.opening_name ? String(r.opening_name) : null,
    ply: Number(r.ply),
    lossCp: r.loss == null ? null : Number(r.loss),
  }));
}

export interface LessonProgressRow {
  slug: string;
  completedSteps: number;
  totalSteps: number;
  bestScore: number;
  completedAt: string | null;
}

export async function listLessonProgress(username: string): Promise<LessonProgressRow[]> {
  const userId = await resolveUserId(username);
  const rows = await client`
    select lesson_slug, completed_steps, total_steps, best_score, completed_at
    from lesson_progress where user_id = ${userId}`;
  return rows.map((r) => ({
    slug: String(r.lesson_slug),
    completedSteps: Number(r.completed_steps),
    totalSteps: Number(r.total_steps),
    bestScore: Number(r.best_score),
    completedAt: r.completed_at ? new Date(r.completed_at as string).toISOString() : null,
  }));
}

export async function saveLessonProgress(
  username: string,
  input: { slug: string; completedSteps: number; totalSteps: number; bestScore: number; completed: boolean },
): Promise<{ ok: true }> {
  const userId = await resolveUserId(username);
  const completedAt = input.completed ? new Date().toISOString() : null;
  await client`
    insert into lesson_progress
      (user_id, lesson_slug, completed_steps, total_steps, best_score, completed_at, updated_at)
    values (${userId}, ${input.slug}, ${input.completedSteps}, ${input.totalSteps},
      ${input.bestScore}, ${completedAt}, now())
    on conflict (user_id, lesson_slug) do update set
      completed_steps = greatest(lesson_progress.completed_steps, excluded.completed_steps),
      total_steps = excluded.total_steps,
      best_score = greatest(lesson_progress.best_score, excluded.best_score),
      completed_at = coalesce(lesson_progress.completed_at, excluded.completed_at),
      updated_at = now()`;
  return { ok: true };
}
