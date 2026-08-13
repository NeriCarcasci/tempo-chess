import { client } from "./db/client.js";

export interface UsageSummary {
  gamesStored: number;
  gamesAnalyzed: number;
  positionsAnalyzed: number;
  drillsToday: number;
  drillsAllTime: number;
  lessonsCompleted: number;
  enginePositionsToday: number;
  byAccount: Array<{
    accountId: string;
    platform: "lichess" | "chesscom";
    username: string;
    gamesStored: number;
    gamesAnalyzed: number;
  }>;
}

function count(value: unknown): number {
  return Number(value ?? 0);
}

export async function getDailyDrillUsage(userId: string): Promise<number> {
  const rows = await client`
    select count(*)::int as count from opening_training_results
    where user_id = ${userId} and completed_at >= date_trunc('day', now())`;
  return count(rows[0]?.count);
}

export async function recordUsage(input: {
  userId: string;
  accountId?: string | null;
  kind: "engine_positions" | "engine_play";
  units: number;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await client`
    insert into usage_events (user_id, account_id, kind, units, metadata)
    values (${input.userId}, coalesce(${input.accountId ?? null}::uuid,
      (select id from linked_accounts where user_id = ${input.userId} order by created_at asc limit 1)),
      ${input.kind}, ${input.units},
      ${JSON.stringify(input.metadata ?? {})}::jsonb)`;
}

export async function getUsageSummary(userId: string): Promise<UsageSummary> {
  const [totals, training, engine, accounts] = await Promise.all([
    client`
      select
        (select count(*)::int from games where user_id = ${userId}) as games_stored,
        (select count(distinct t.game_id)::int from analysis_tasks t
          join games g on g.id = t.game_id
          where g.user_id = ${userId} and t.status = 'completed' and t.pass = 'screening') as games_analyzed,
        (select coalesce(sum(analyzed_positions), 0)::int from analysis_imports
          where user_id = ${userId}) as positions_analyzed`,
    client`
      select count(*)::int as drills_all_time,
        count(*) filter (where completed_at >= date_trunc('day', now()))::int as drills_today,
        (select count(*)::int from lesson_progress
          where user_id = ${userId} and completed_at is not null) as lessons_completed
      from opening_training_results where user_id = ${userId}`,
    client`
      select coalesce(sum(units), 0)::int as units from usage_events
      where user_id = ${userId} and kind = 'engine_positions'
        and created_at >= date_trunc('day', now())`,
    client`
      select a.id, a.platform, a.username,
        count(distinct g.id)::int as games_stored,
        count(distinct g.id) filter (where t.status = 'completed' and t.pass = 'screening')::int as games_analyzed
      from linked_accounts a
      left join games g on g.account_id = a.id
      left join analysis_tasks t on t.game_id = g.id
      where a.user_id = ${userId}
      group by a.id, a.platform, a.username
      order by min(a.created_at)`,
  ]);
  return {
    gamesStored: count(totals[0]?.games_stored),
    gamesAnalyzed: count(totals[0]?.games_analyzed),
    positionsAnalyzed: count(totals[0]?.positions_analyzed),
    drillsToday: count(training[0]?.drills_today),
    drillsAllTime: count(training[0]?.drills_all_time),
    lessonsCompleted: count(training[0]?.lessons_completed),
    enginePositionsToday: count(engine[0]?.units),
    byAccount: accounts.map((row) => ({
      accountId: String(row.id),
      platform: row.platform as "lichess" | "chesscom",
      username: String(row.username),
      gamesStored: count(row.games_stored),
      gamesAnalyzed: count(row.games_analyzed),
    })),
  };
}
