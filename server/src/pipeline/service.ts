import { randomUUID } from "node:crypto";
import { client } from "../db/client.js";
import { classifyGamePhases } from "../analysis/phase.js";
import { ANALYSIS_PROFILES, Engine, type AnalysisProfile, type PositionEval } from "../engine/stockfish.js";
import { selectCriticalPositions, type CriticalPositionCandidate, type MoveJudgment } from "../engine/critical-position.js";
import { fetchLichessGames } from "../ingest/lichess.js";
import { normalizeProviderUsername } from "../ingest/canonical.js";
import type { NormalizedGame, NormalizedMove } from "../ingest/types.js";
import { classifyTaskFailure } from "./state.js";
import { DEFAULT_ANALYSIS_BUDGET, type AnalysisTaskRecord, type ImportProgress } from "./types.js";
import { buildPlayerOpeningGraph } from "../openings/service.js";

const DEMO_EMAIL = "local@tempo.chess";
const workerId = `local-${process.pid}-${randomUUID().slice(0, 8)}`;

type Json = Record<string, unknown>;
type StoredMove = NormalizedMove & { gameId: string };

function number(value: unknown): number {
  return Number(value ?? 0);
}

function mapImport(row: Record<string, unknown>): ImportProgress {
  return {
    id: String(row.id),
    username: String(row.username),
    platform: row.platform as "lichess" | "chesscom",
    status: row.status as ImportProgress["status"],
    requestedGames: number(row.requested_games),
    discoveredGames: number(row.discovered_games),
    queuedTasks: number(row.queued_tasks),
    runningTasks: number(row.running_tasks),
    completedTasks: number(row.completed_tasks),
    failedTasks: number(row.failed_tasks),
    totalPositions: number(row.total_positions),
    analyzedPositions: number(row.analyzed_positions),
    cacheHits: number(row.cache_hits),
    deepPositions: number(row.deep_positions),
    maxPositions: number(row.max_positions),
    estimatedCostUsd: number(row.estimated_cost_usd),
    actualCostUsd: number(row.actual_cost_usd),
    cancelRequested: Boolean(row.cancel_requested),
    error: row.error == null ? null : String(row.error),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

const IMPORT_SELECT = `
  select i.*, a.username, a.platform
  from analysis_imports i
  join linked_accounts a on a.id = i.account_id`;

export async function listImports(userId: string, limit = 20): Promise<ImportProgress[]> {
  const rows = await client.unsafe(`${IMPORT_SELECT} where i.user_id = $1 order by i.created_at desc limit $2`, [userId, limit]);
  return rows.map((row) => mapImport(row as Record<string, unknown>));
}

export async function getImport(id: string, userId?: string): Promise<ImportProgress | null> {
  const rows = userId
    ? await client.unsafe(`${IMPORT_SELECT} where i.id = $1 and i.user_id = $2`, [id, userId])
    : await client.unsafe(`${IMPORT_SELECT} where i.id = $1`, [id]);
  return rows[0] ? mapImport(rows[0] as Record<string, unknown>) : null;
}

export interface PlayerCoverage {
  username: string;
  availableGames: number;
  importedGames: number;
  analyzedGames: number;
  activeImport: ImportProgress | null;
  historyComplete: boolean;
  skippedGames: number;
  importLimit: number;
}

async function ensureAccount(username: string, ownerId?: string): Promise<{ userId: string; accountId: string }> {
  const normalized = normalizeProviderUsername(username);
  if (ownerId) {
    const rows = await client`
      select id from linked_accounts
      where user_id = ${ownerId} and platform = 'lichess' and normalized_username = ${normalized}
      limit 1`;
    if (!rows[0]) throw new Error(`"${username}" is not linked to this account`);
    return { userId: ownerId, accountId: String(rows[0].id) };
  }
  return client.begin(async (sql) => {
    let profiles = await sql`select id from profiles where email = ${DEMO_EMAIL} limit 1`;
    if (!profiles[0]) {
      profiles = await sql`insert into profiles (id, email, display_name) values (${randomUUID()}, ${DEMO_EMAIL}, 'Local analyst') returning id`;
    }
    const userId = String(profiles[0]!.id);
    let accounts = await sql`select id from linked_accounts where user_id = ${userId} and platform = 'lichess' and normalized_username = ${normalized} limit 1`;
    if (!accounts[0]) {
      accounts = await sql`insert into linked_accounts (user_id, platform, username, normalized_username)
        values (${userId}, 'lichess', ${username}, ${normalized}) returning id`;
    }
    return { userId, accountId: String(accounts[0]!.id) };
  });
}

const LICHESS_COUNT_TTL_MS = 5 * 60_000;
const LICHESS_COUNT_TIMEOUT_MS = 2500;
const lichessCountCache = new Map<string, { value: number; at: number }>();

/**
 * The player's total game count from Lichess. Lichess rate-limits bursts and can
 * hang, so this must never block a request: we time out fast, cache the result for
 * a few minutes, and serve the last known value (or `null`) on any failure. This
 * keeps `/coverage` and `POST /imports/lichess` off Lichess's critical path.
 */
async function getLichessAvailableGames(username: string): Promise<number | null> {
  const key = username.toLowerCase();
  const cached = lichessCountCache.get(key);
  const now = Date.now();
  if (cached && now - cached.at < LICHESS_COUNT_TTL_MS) return cached.value;
  try {
    const response = await fetch(`https://lichess.org/api/user/${encodeURIComponent(username)}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(LICHESS_COUNT_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Lichess profile returned ${response.status} for "${username}"`);
    const profile = await response.json() as { count?: { all?: number } };
    const value = Number(profile.count?.all ?? 0);
    lichessCountCache.set(key, { value, at: now });
    return value;
  } catch {
    return cached ? cached.value : null; // serve stale on failure, else "unknown"
  }
}

export async function getLichessCoverage(username: string, ownerId?: string): Promise<PlayerCoverage> {
  const { userId, accountId } = await ensureAccount(username, ownerId);
  const [availableGamesRaw, storedRows, analyzedRows, activeRows, latestRows] = await Promise.all([
    getLichessAvailableGames(username),
    client`select count(*)::int as count from games
      where user_id = ${userId} and account_id = ${accountId}`,
    client`select count(distinct t.game_id)::int as count
      from analysis_tasks t
      join games g on g.id = t.game_id
      where g.user_id = ${userId} and g.account_id = ${accountId}
        and t.pass = 'screening' and t.status = 'completed'`,
    client.unsafe(`${IMPORT_SELECT} where i.account_id = $1
      and i.status in ('queued', 'ingesting', 'analyzing')
      order by i.created_at desc limit 1`, [accountId]),
    client.unsafe(`${IMPORT_SELECT} where i.account_id = $1
      order by i.created_at desc limit 1`, [accountId]),
  ]);
  const importedGames = number(storedRows[0]?.count);
  // Lichess is best-effort here; if its count is unknown, fall back to what we've
  // already imported rather than showing a bogus "sync N games" prompt.
  const availableGames = availableGamesRaw ?? importedGames;
  const activeImport = activeRows[0]
    ? mapImport(activeRows[0] as Record<string, unknown>)
    : null;
  const latestImport = latestRows[0]
    ? mapImport(latestRows[0] as Record<string, unknown>)
    : null;
  const historyComplete = activeImport == null
    && latestImport?.status === "completed"
    && latestImport.requestedGames >= Math.min(availableGames, 500);
  const skippedGames = historyComplete
    ? Math.max(0, Math.min(availableGames, 500) - latestImport.discoveredGames)
    : 0;
  return {
    username,
    availableGames,
    importedGames,
    analyzedGames: number(analyzedRows[0]?.count),
    activeImport,
    historyComplete,
    skippedGames,
    importLimit: 500,
  };
}

export async function createLichessImport(username: string, requestedGames: number, ownerId?: string): Promise<ImportProgress> {
  const { userId, accountId } = await ensureAccount(username, ownerId);
  const active = await client.unsafe(`${IMPORT_SELECT} where i.account_id = $1
    and i.status in ('queued', 'ingesting', 'analyzing')
    order by i.created_at desc limit 1`, [accountId]);
  if (active[0]) return mapImport(active[0] as Record<string, unknown>);
  const maxPositions = Math.min(
    50_000,
    Math.max(DEFAULT_ANALYSIS_BUDGET.maxPositions, requestedGames * 100),
  );
  const rows = await client`
    insert into analysis_imports (user_id, account_id, requested_games, max_positions, estimated_cost_usd)
    values (${userId}, ${accountId}, ${requestedGames}, ${maxPositions},
      ${requestedGames * 70 * DEFAULT_ANALYSIS_BUDGET.estimatedScreeningCostPerPositionUsd})
    returning id`;
  const id = String(rows[0]!.id);
  void ingestImport(id, userId, accountId, username, requestedGames).catch((error) => failImport(id, error));
  return (await getImport(id))!;
}

export async function cancelImport(id: string, userId?: string): Promise<ImportProgress | null> {
  await client`update analysis_imports set cancel_requested = true, updated_at = now()
    where id = ${id} and (${userId ?? null}::uuid is null or user_id = ${userId ?? null})
      and status in ('queued', 'ingesting', 'analyzing')`;
  await client`update analysis_tasks set status = 'cancelled', completed_at = now(), updated_at = now()
    where import_id = ${id} and status = 'queued'
      and exists (select 1 from analysis_imports i where i.id = ${id}
        and (${userId ?? null}::uuid is null or i.user_id = ${userId ?? null}))`;
  await refreshImport(id);
  return getImport(id, userId);
}

async function failImport(id: string, error: unknown): Promise<void> {
  console.error("analysis import failed", error);
  const message = error instanceof Error ? error.message : String(error);
  await client`update analysis_imports set status = 'failed', error = ${message.slice(0, 1000)}, completed_at = now(), updated_at = now()
    where id = ${id} and status not in ('completed', 'cancelled')`;
}

async function upsertGame(userId: string, accountId: string, game: NormalizedGame): Promise<string> {
  return client.begin(async (sql) => {
    const rows = await sql`
      insert into games (user_id, account_id, platform, platform_game_id, normalized_schema_version,
        canonical_game_id, pgn_fingerprint, provenance, players, provider_accuracy, url, played_at,
        color, result, termination, speed, time_control, user_rating, opponent_username,
        opponent_rating, eco, opening_name, ply_count)
      values (${userId}, ${accountId}, ${game.platform}, ${game.platformGameId}, ${game.schemaVersion},
        ${game.canonicalGameId}, ${game.pgnFingerprint}, ${JSON.stringify(game.provenance)}::jsonb,
        ${JSON.stringify(game.players)}::jsonb, ${game.providerAccuracy ? JSON.stringify(game.providerAccuracy) : null}::jsonb,
        ${game.url}, ${game.playedAt?.toISOString() ?? null}, ${game.color}, ${game.result}, ${game.termination}, ${game.speed},
        ${game.timeControl}, ${game.userRating}, ${game.opponentUsername}, ${game.opponentRating},
        ${game.eco}, ${game.openingName}, ${game.plyCount})
      on conflict (user_id, platform, platform_game_id) do update set
        account_id = excluded.account_id, provenance = excluded.provenance, players = excluded.players,
        provider_accuracy = excluded.provider_accuracy, played_at = excluded.played_at,
        pgn_fingerprint = excluded.pgn_fingerprint, ply_count = excluded.ply_count
      returning id`;
    const gameId = String(rows[0]!.id);
    await sql`insert into game_sources (game_id, account_id, platform, platform_game_id, account_username,
      account_provider_id, source_url, fetched_at)
      values (${gameId}, ${accountId}, ${game.platform}, ${game.platformGameId}, ${game.provenance.accountUsername},
        ${game.provenance.accountProviderId}, ${game.provenance.sourceUrl}, ${game.provenance.fetchedAt.toISOString()})
      on conflict (account_id, platform, platform_game_id) do update set fetched_at = excluded.fetched_at`;
    await sql`delete from canonical_moves where game_id = ${gameId}`;
    for (const move of game.moves) {
      await sql`insert into canonical_moves (game_id, ply, move_number, color, uci, san, fen_before, fen_after,
        clock_ms, think_time_ms, provider_evaluation, annotations)
        values (${gameId}, ${move.ply}, ${move.moveNumber}, ${move.color}, ${move.uci}, ${move.san},
          ${move.fenBefore}, ${move.fenAfter}, ${move.clockMs}, ${move.thinkTimeMs},
          ${move.providerEvaluation ? JSON.stringify(move.providerEvaluation) : null}::jsonb, ${JSON.stringify(move.annotations)}::jsonb)`;
    }
    return gameId;
  });
}

async function ingestImport(id: string, userId: string, accountId: string, username: string, max: number): Promise<void> {
  await client`update analysis_imports set status = 'ingesting', started_at = now(), updated_at = now() where id = ${id}`;
  for await (const game of fetchLichessGames(username, { max })) {
    const cancelled = await client`select cancel_requested from analysis_imports where id = ${id}`;
    if (cancelled[0]?.cancel_requested) break;
    const gameId = await upsertGame(userId, accountId, game);
    const positions = game.moves.length + 1;
    const taskKey = `${id}:${gameId}:screening:v1`;
    const existing = await client`select id from analysis_tasks where idempotency_key = ${taskKey}`;
    if (existing.length) continue;
    const budget = await client`select total_positions, max_positions from analysis_imports where id = ${id}`;
    if (number(budget[0]?.total_positions) + positions > number(budget[0]?.max_positions)) {
      throw new Error(`Position budget exceeded (${budget[0]?.max_positions})`);
    }
    const enqueued = await client`insert into analysis_tasks (import_id, game_id, pass, idempotency_key, payload)
      values (${id}, ${gameId}, 'screening', ${taskKey}, '{}'::jsonb)
      on conflict (idempotency_key) do nothing returning id`;
    if (enqueued.length) {
      await client`update analysis_imports set discovered_games = discovered_games + 1,
        total_positions = total_positions + ${positions}, updated_at = now() where id = ${id}`;
    }
  }
  const row = await client`select cancel_requested from analysis_imports where id = ${id}`;
  if (row[0]?.cancel_requested) {
    await client`update analysis_imports set status = 'cancelled', completed_at = now(), updated_at = now() where id = ${id}`;
    return;
  }
  await client`update analysis_imports set status = 'analyzing', updated_at = now() where id = ${id}`;
  await refreshImport(id);
  kickWorker();
}

let workerRunning = false;
let engine: Engine | null = null;
const cacheKeys = new Map<string, string>();

export function kickWorker(): void {
  if (workerRunning) return;
  workerRunning = true;
  void workerLoop().finally(() => { workerRunning = false; });
}

async function claimTask(): Promise<AnalysisTaskRecord | null> {
  const rows = await client.begin(async (sql) => sql.unsafe(`
    with candidate as (
      select t.id from analysis_tasks t join analysis_imports i on i.id = t.import_id
      where t.status = 'queued' and i.cancel_requested = false
      order by t.priority desc, t.created_at asc for update skip locked limit 1
    )
    update analysis_tasks t set status = 'running', attempts = attempts + 1, worker_id = $1,
      locked_at = now(), started_at = coalesce(started_at, now()), updated_at = now()
    from candidate where t.id = candidate.id returning t.*`, [workerId]));
  if (!rows[0]) return null;
  const row = rows[0];
  return {
    id: String(row.id), importId: String(row.import_id), gameId: String(row.game_id),
    pass: row.pass, status: row.status, priority: number(row.priority),
    idempotencyKey: String(row.idempotency_key), attempts: number(row.attempts),
    maxAttempts: number(row.max_attempts), payload: (row.payload ?? {}) as Json,
  };
}

async function workerLoop(): Promise<void> {
  for (;;) {
    const task = await claimTask();
    if (!task) return;
    await refreshImport(task.importId);
    try {
      const result = task.pass === "screening" ? await screenGame(task) : await deepenGame(task);
      await client`update analysis_tasks set status = 'completed', result = ${JSON.stringify(result)}::jsonb, error = null,
        completed_at = now(), updated_at = now() where id = ${task.id} and status = 'running'`;
    } catch (error) {
      engine?.quit(); engine = null;
      const next = classifyTaskFailure(task.attempts, task.maxAttempts);
      const message = error instanceof Error ? error.message : String(error);
      await client`update analysis_tasks set status = ${next}, error = ${message.slice(0, 1000)},
        worker_id = null, locked_at = null, completed_at = ${next === "failed" ? new Date().toISOString() : null}, updated_at = now()
        where id = ${task.id}`;
    }
    const status = await refreshImport(task.importId);
    if (status === "completed") {
      const account = await client`
        select a.username
        from analysis_imports i
        join linked_accounts a on a.id = i.account_id
        where i.id = ${task.importId}`;
      if (account[0]?.username) {
        await buildPlayerOpeningGraph(String(account[0].username));
      }
    }
  }
}

async function movesForGame(gameId: string): Promise<StoredMove[]> {
  const rows = await client`select game_id, ply, move_number, color, uci, san, fen_before, fen_after,
    clock_ms, think_time_ms, provider_evaluation, annotations from canonical_moves where game_id = ${gameId} order by ply`;
  return rows.map((row) => ({
    gameId: String(row.game_id), ply: number(row.ply), moveNumber: number(row.move_number), color: row.color,
    uci: String(row.uci), san: String(row.san), fenBefore: String(row.fen_before), fenAfter: String(row.fen_after),
    clockMs: row.clock_ms == null ? null : number(row.clock_ms), thinkTimeMs: row.think_time_ms == null ? null : number(row.think_time_ms),
    providerEvaluation: row.provider_evaluation, annotations: row.annotations,
  })) as StoredMove[];
}

async function evaluate(fen: string, profile: AnalysisProfile): Promise<{ evaluation: PositionEval; hit: boolean }> {
  const knownKey = cacheKeys.get(profile.id);
  if (knownKey) {
    const rows = await client`select * from position_eval where fen = ${fen} and cache_key = ${knownKey}`;
    if (rows[0]) return { evaluation: rowToEval(rows[0]), hit: true };
  }
  engine ??= new Engine();
  const evaluation = await engine.analyze(fen, profile);
  cacheKeys.set(profile.id, evaluation.cacheKey);
  await saveEvaluation(evaluation);
  return { evaluation, hit: false };
}

function rowToEval(row: Record<string, any>): PositionEval {
  return {
    fen: row.fen, cacheKey: row.cache_key, depth: number(row.depth), evalCp: row.eval_cp == null ? undefined : number(row.eval_cp),
    mate: row.mate == null ? undefined : number(row.mate), wdl: row.wdl_win == null ? undefined : [number(row.wdl_win), number(row.wdl_draw), number(row.wdl_loss)],
    best: row.best_move_uci ?? undefined, candidates: row.candidates ?? [], nodes: row.nodes == null ? undefined : number(row.nodes),
    nps: row.nps == null ? undefined : number(row.nps), engineTimeMs: row.engine_time_ms == null ? undefined : number(row.engine_time_ms),
    elapsedMs: number(row.elapsed_ms), provenance: {
      engine: "stockfish", engineName: row.engine, engineVersion: row.engine_version ?? undefined,
      binarySha256: row.binary_sha256 ?? undefined, network: row.network ?? undefined, networkHash: row.network_hash ?? undefined,
      profileId: row.profile_id, profileVersion: number(row.profile_version), limit: { type: row.limit_type, value: number(row.limit_value) },
      multiPv: number(row.multi_pv), threads: number(row.threads), hashMb: number(row.hash_mb),
      workerRevision: row.worker_revision, cacheProvenance: row.cache_provenance,
    },
  };
}

async function saveEvaluation(value: PositionEval): Promise<void> {
  const p = value.provenance;
  await client`insert into position_eval (fen, cache_key, depth, eval_cp, mate, wdl_win, wdl_draw, wdl_loss,
    best_move_uci, pv, candidates, engine, engine_version, binary_sha256, network, network_hash, profile_id,
    profile_version, limit_type, limit_value, multi_pv, threads, hash_mb, nodes, nps, engine_time_ms,
    elapsed_ms, worker_revision, cache_provenance)
    values (${value.fen}, ${value.cacheKey}, ${value.depth}, ${value.evalCp ?? null}, ${value.mate ?? null},
      ${value.wdl?.[0] ?? null}, ${value.wdl?.[1] ?? null}, ${value.wdl?.[2] ?? null}, ${value.best ?? null},
      ${value.candidates[0]?.pv.join(" ") ?? null}, ${JSON.stringify(value.candidates)}::jsonb, ${p.engine}, ${p.engineVersion ?? null},
      ${p.binarySha256 ?? null}, ${p.network ?? null}, ${p.networkHash ?? null}, ${p.profileId}, ${p.profileVersion},
      ${p.limit.type}, ${p.limit.value}, ${p.multiPv}, ${p.threads}, ${p.hashMb}, ${value.nodes ?? null}, ${value.nps ?? null},
      ${value.engineTimeMs ?? null}, ${value.elapsedMs}, ${p.workerRevision}, ${p.cacheProvenance})
    on conflict (fen, cache_key) do nothing`;
}

function judgment(loss: number): MoveJudgment {
  return loss >= 300 ? "blunder" : loss >= 150 ? "mistake" : loss >= 90 ? "inaccuracy" : "good";
}

async function screenGame(task: AnalysisTaskRecord): Promise<Json> {
  const moves = await movesForGame(task.gameId);
  if (!moves.length) throw new Error("Game has no canonical moves");
  const fens = [moves[0]!.fenBefore, ...moves.map((move) => move.fenAfter)];
  const evaluated: PositionEval[] = [];
  let hits = 0;
  for (const fen of fens) {
    const result = await evaluate(fen, ANALYSIS_PROFILES.screening);
    evaluated.push(result.evaluation); if (result.hit) hits += 1;
    await client`update analysis_imports set analyzed_positions = analyzed_positions + 1,
      cache_hits = cache_hits + ${result.hit ? 1 : 0}, actual_cost_usd = actual_cost_usd + ${result.hit ? 0 : DEFAULT_ANALYSIS_BUDGET.estimatedScreeningCostPerPositionUsd},
      updated_at = now() where id = ${task.importId}`;
  }
  const phases = classifyGamePhases({ positions: fens.map((fen, ply) => ({ fen, ply })) });
  const candidates: CriticalPositionCandidate[] = moves.map((move, index) => {
    const before = evaluated[index]!.evalCp ?? 0;
    const after = evaluated[index + 1]!.evalCp ?? before;
    const loss = Math.max(0, move.color === "white" ? before - after : after - before);
    return {
      gameId: task.gameId, ply: move.ply, judgment: judgment(loss), evaluationLossCp: loss,
      thinkTimeSeconds: move.thinkTimeMs == null ? undefined : move.thinkTimeMs / 1000,
      remainingTimeSeconds: move.clockMs == null ? undefined : move.clockMs / 1000,
      phaseBefore: phases.byPly.get(index), phaseAfter: phases.byPly.get(index + 1),
    };
  });
  const selection = selectCriticalPositions(candidates, { maxPositionsPerGame: DEFAULT_ANALYSIS_BUDGET.maxDeepPositionsPerGame });
  const selected = selection.selected.map((item) => ({
    ply: item.candidate.ply, fen: moves[item.candidate.ply - 1]!.fenBefore,
    reasons: item.reasons.map((reason) => reason.code), priorityScore: item.priorityScore,
    evaluationLossCp: item.candidate.evaluationLossCp ?? null,
  }));
  if (selected.length) {
    await client`insert into analysis_tasks (import_id, game_id, pass, priority, idempotency_key, payload)
      values (${task.importId}, ${task.gameId}, 'deep', 10, ${`${task.importId}:${task.gameId}:deep:v1`}, ${JSON.stringify({ positions: selected })}::jsonb)
      on conflict (idempotency_key) do nothing`;
    await client`update analysis_imports set deep_positions = deep_positions + ${selected.length},
      estimated_cost_usd = estimated_cost_usd + ${selected.length * DEFAULT_ANALYSIS_BUDGET.estimatedDeepCostPerPositionUsd}, updated_at = now()
      where id = ${task.importId}`;
  }
  return { positions: fens.length, cacheHits: hits, criticalPositions: selected };
}

async function deepenGame(task: AnalysisTaskRecord): Promise<Json> {
  const positions = Array.isArray(task.payload.positions) ? task.payload.positions as Array<{ ply: number; fen: string; reasons: string[] }> : [];
  let hits = 0;
  const results = [];
  for (const position of positions) {
    const result = await evaluate(position.fen, ANALYSIS_PROFILES.deep);
    if (result.hit) hits += 1;
    await client`update analysis_imports set analyzed_positions = analyzed_positions + 1,
      cache_hits = cache_hits + ${result.hit ? 1 : 0}, actual_cost_usd = actual_cost_usd + ${result.hit ? 0 : DEFAULT_ANALYSIS_BUDGET.estimatedDeepCostPerPositionUsd}, updated_at = now()
      where id = ${task.importId}`;
    results.push({ ply: position.ply, reasons: position.reasons, evaluation: result.evaluation });
  }
  return { positions: results, cacheHits: hits };
}

async function refreshImport(importId: string): Promise<ImportProgress["status"] | null> {
  const rows = await client.unsafe(`
    update analysis_imports i set
      queued_tasks = s.queued, running_tasks = s.running, completed_tasks = s.completed, failed_tasks = s.failed,
      status = case
        when i.cancel_requested and s.running = 0 then 'cancelled'::analysis_import_status
        when s.failed > 0 and s.queued = 0 and s.running = 0 then 'failed'::analysis_import_status
        when i.status = 'analyzing' and s.queued = 0 and s.running = 0 and s.completed > 0 then 'completed'::analysis_import_status
        else i.status end,
      completed_at = case when (i.cancel_requested or (i.status = 'analyzing' and s.queued = 0 and s.running = 0 and s.completed > 0)) and s.running = 0 then now() else i.completed_at end,
      updated_at = now()
    from (select count(*) filter (where status = 'queued')::int queued,
      count(*) filter (where status = 'running')::int running,
      count(*) filter (where status = 'completed')::int completed,
      count(*) filter (where status = 'failed')::int failed
      from analysis_tasks where import_id = $1) s where i.id = $1
      returning i.status`, [importId]);
  return rows[0]?.status as ImportProgress["status"] | undefined ?? null;
}

export async function recoverPipeline(): Promise<void> {
  await client`update analysis_tasks set status = case when attempts < max_attempts then 'queued'::analysis_task_status else 'failed'::analysis_task_status end,
    worker_id = null, locked_at = null, updated_at = now() where status = 'running' and locked_at < now() - interval '10 minutes'`;
  const interrupted = await client`
    select i.id, i.user_id, i.account_id, i.requested_games, a.username
    from analysis_imports i join linked_accounts a on a.id = i.account_id
    where i.status in ('queued', 'ingesting') and i.cancel_requested = false`;
  for (const row of interrupted) {
    void ingestImport(String(row.id), String(row.user_id), String(row.account_id), String(row.username), number(row.requested_games))
      .catch((error) => failImport(String(row.id), error));
  }
  const imports = await client`select id from analysis_imports where status = 'analyzing'`;
  for (const row of imports) await refreshImport(String(row.id));
  kickWorker();
}
