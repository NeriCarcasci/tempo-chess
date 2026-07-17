import { client } from "../db/client.js";
import { ensureOpeningCatalogue } from "./catalogue.js";
import {
  OPENING_CLASSIFIER_VERSION,
  calculateMastery,
  canonicalPositionKey,
  classifyOpeningDecision,
  gameOpeningIdentity,
  splitOpeningName,
  type MasteryMetrics,
} from "./model.js";

const MAX_OPENING_PLIES = 30;

interface GameMoveRow extends Record<string, unknown> {
  user_id: string;
  game_id: string;
  platform: "lichess" | "chesscom";
  speed: string | null;
  played_at: Date | string | null;
  player_color: "white" | "black";
  result: "win" | "loss" | "draw";
  eco: string | null;
  game_opening_name: string | null;
  opponent_username: string | null;
  url: string | null;
  platform_game_id: string;
  ply: number;
  color: "white" | "black";
  uci: string;
  san: string;
  fen_before: string;
  fen_after: string;
}

interface ObservationRow extends Record<string, unknown> {
  user_id: string;
  game_id: string;
  ply: number;
  position_key: string;
  next_position_key: string;
  move_uci: string;
  move_san: string;
  actor_is_player: boolean;
  player_color: "white" | "black";
  platform: "lichess" | "chesscom";
  speed: string | null;
  played_at: string | Date | null;
  result: "win" | "loss" | "draw";
  eco: string | null;
  opening_name: string | null;
  family: string | null;
  acceptable: boolean | null;
  acceptable_reason: string | null;
  evaluation_loss_cp: number | null;
  fen: string;
  node_name: string | null;
  variation: string | null;
  representative_line_san: string | null;
  representative_line_uci: string | null;
  opponent_username: string | null;
  url: string | null;
  best_move_uci: string | null;
}

export interface ExplorerFilters {
  platform?: "all" | "lichess" | "chesscom";
  speed?: "all" | "bullet" | "blitz" | "rapid" | "classical" | "correspondence";
  color?: "all" | "white" | "black";
  since?: string;
  family?: string;
  node?: string;
}

export interface OpeningFinding {
  nodeKey: string;
  name: string;
  family: string;
  variation: string | null;
  fen: string;
  lineSan: string;
  lineUci: string;
  opportunities: number;
  games: number;
  acceptable: number;
  failures: number;
  metrics: MasteryMetrics;
  transposition: boolean;
}

function ageWeight(value: string | Date | null): number {
  if (!value) return 0.55;
  const ageDays = Math.max(0, (Date.now() - new Date(value).getTime()) / 86_400_000);
  return Math.max(0.35, 0.5 ** (ageDays / 180));
}

function isRecent(value: string | Date | null): boolean {
  return value != null && Date.now() - new Date(value).getTime() <= 90 * 86_400_000;
}

function metrics(rows: ObservationRow[], evidenceUnit: "decision" | "game" = "decision"): MasteryMetrics {
  const scored = rows.filter((row) => row.actor_is_player && row.acceptable != null);
  const evidenceRows = evidenceUnit === "game"
    ? [...new Map(scored.map((row) => [row.game_id, row])).values()]
    : scored;
  let weightedOpportunities = 0;
  let weightedAcceptable = 0;
  let acceptableUnits = 0;
  let recentOpportunities = 0;
  let recentAcceptable = 0;
  let historicalOpportunities = 0;
  let historicalAcceptable = 0;
  let loss = 0;
  let lossCount = 0;
  for (const row of evidenceRows) {
    const weight = ageWeight(row.played_at);
    weightedOpportunities += weight;
    const sameUnit = evidenceUnit === "game"
      ? scored.filter((item) => item.game_id === row.game_id)
      : [row];
    const acceptableShare = sameUnit.filter((item) => item.acceptable).length / sameUnit.length;
    acceptableUnits += acceptableShare;
    weightedAcceptable += weight * acceptableShare;
    if (isRecent(row.played_at)) {
      recentOpportunities += 1;
      recentAcceptable += acceptableShare;
    } else {
      historicalOpportunities += 1;
      historicalAcceptable += acceptableShare;
    }
  }
  for (const row of scored) {
    if (row.evaluation_loss_cp == null) continue;
    loss += Number(row.evaluation_loss_cp);
    lossCount += 1;
  }
  return calculateMastery({
    opportunities: evidenceRows.length,
    acceptable: acceptableUnits,
    weightedOpportunities,
    weightedAcceptable,
    recentOpportunities,
    recentAcceptable,
    historicalOpportunities,
    historicalAcceptable,
    averageLossCp: lossCount ? loss / lossCount : null,
  });
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    output.push(items.slice(index, index + size));
  }
  return output;
}

async function findUser(username: string): Promise<{ userId: string; username: string }> {
  const rows = await client`
    select p.id as user_id, a.username
    from linked_accounts a join profiles p on p.id = a.user_id
    where a.normalized_username = ${username.trim().toLowerCase()}
    order by a.created_at asc limit 1`;
  if (!rows[0]) throw new Error(`No imported account found for "${username}"`);
  return { userId: String(rows[0].user_id), username: String(rows[0].username) };
}

export async function buildPlayerOpeningGraph(username: string): Promise<{
  userId: string;
  games: number;
  observations: number;
}> {
  await ensureOpeningCatalogue();
  const account = await findUser(username);
  const [catalogueRows, edgeRows, evaluationRows, repertoireRows, moveRows] = await Promise.all([
    client`select position_key, fen, eco, opening_name, family, variation, ply,
      representative_line_uci, representative_line_san, source_revision, source_license
      from opening_positions where catalogue = true`,
    client`select from_key, move_uci from opening_edges where catalogue = true`,
    client`select distinct on (fen) fen, eval_cp, best_move_uci
      from position_eval where profile_id = 'screening'
      order by fen, computed_at desc`,
    client`select position_key, move_uci from opening_repertoire_moves
      where user_id = ${account.userId}`,
    client`
      select g.user_id, g.id as game_id, g.platform, g.speed, g.played_at,
        g.color as player_color, g.result, g.eco, g.opening_name as game_opening_name,
        g.opponent_username, g.url, m.ply, m.color, m.uci, m.san, m.fen_before, m.fen_after
      from games g join canonical_moves m on m.game_id = g.id
      left join player_opening_observations existing
        on existing.game_id = m.game_id and existing.ply = m.ply
      where g.user_id = ${account.userId} and m.ply <= ${MAX_OPENING_PLIES}
        and (
          existing.game_id is null
          or existing.classifier_version <> ${OPENING_CLASSIFIER_VERSION}
          or (
            existing.actor_is_player = true
            and existing.acceptable is null
            and exists (
              select 1 from position_eval before_eval
              where before_eval.fen = m.fen_before
                and before_eval.profile_id = 'screening'
                and before_eval.computed_at > existing.updated_at
            )
            and exists (
              select 1 from position_eval after_eval
              where after_eval.fen = m.fen_after
                and after_eval.profile_id = 'screening'
                and after_eval.computed_at > existing.updated_at
            )
          )
        )
      order by g.played_at desc nulls last, g.id, m.ply`,
  ]);

  const catalogue = new Map(
    catalogueRows.map((row) => [String(row.position_key), row]),
  );
  const bookMoves = new Set(
    edgeRows.map((row) => `${row.from_key}|${row.move_uci}`),
  );
  const repertoireMoves = new Set(
    repertoireRows.map((row) => `${row.position_key}|${row.move_uci}`),
  );
  const evaluations = new Map(
    evaluationRows.map((row) => [
      String(row.fen),
      { evalCp: row.eval_cp == null ? null : Number(row.eval_cp), best: row.best_move_uci },
    ]),
  );
  const observedNodes = new Map<string, Record<string, unknown>>();
  const observedEdges = new Map<string, Record<string, unknown>>();
  const observations: Record<string, unknown>[] = [];

  for (const raw of moveRows as unknown as GameMoveRow[]) {
    const fromKey = canonicalPositionKey(String(raw.fen_before));
    const toKey = canonicalPositionKey(String(raw.fen_after));
    // Attribute every decision to the game's final provider opening. Shared
    // early positions belong to many openings and cannot safely supply family
    // identity from a single catalogue row.
    const identity = gameOpeningIdentity(raw.eco, raw.game_opening_name);

    const beforeEval = evaluations.get(String(raw.fen_before))?.evalCp;
    const afterEval = evaluations.get(String(raw.fen_after))?.evalCp;
    const actorIsPlayer = raw.color === raw.player_color;
    const evaluationLoss = beforeEval == null || afterEval == null
      ? null
      : Math.max(0, raw.color === "white" ? beforeEval - afterEval : afterEval - beforeEval);
    const bookMove = bookMoves.has(`${fromKey}|${raw.uci}`);
    const repertoireMove = repertoireMoves.has(`${fromKey}|${raw.uci}`);
    const classification = classifyOpeningDecision({
      actorIsPlayer,
      repertoireMove,
      catalogueMove: bookMove,
      evaluationLossCp: evaluationLoss,
    });

    for (const [key, fen, ply] of [
      [fromKey, raw.fen_before, Number(raw.ply) - 1],
      [toKey, raw.fen_after, Number(raw.ply)],
    ] as const) {
      const catalogueNode = catalogue.get(key);
      observedNodes.set(key, {
        position_key: key,
        fen: String(fen),
        eco: catalogueNode?.eco ?? identity.eco,
        opening_name: catalogueNode?.opening_name ?? identity.name,
        family: catalogueNode?.family ?? identity.family,
        variation: catalogueNode?.variation ?? identity.variation,
        ply,
        representative_line_uci: catalogueNode?.representative_line_uci ?? "",
        representative_line_san: catalogueNode?.representative_line_san ?? "",
        source_revision: catalogueNode ? catalogueNode.source_revision : "player-observation-v1",
        source_license: catalogueNode ? catalogueNode.source_license : null,
        catalogue: Boolean(catalogueNode),
      });
    }
    observedEdges.set(`${fromKey}|${raw.uci}|${toKey}`, {
      from_key: fromKey,
      move_uci: String(raw.uci),
      to_key: toKey,
      move_san: String(raw.san),
      catalogue: bookMove,
      source_revision: bookMove ? catalogue.get(toKey)?.source_revision ?? null : "player-observation-v1",
    });
    observations.push({
      user_id: account.userId,
      game_id: String(raw.game_id),
      ply: Number(raw.ply),
      position_key: fromKey,
      next_position_key: toKey,
      move_uci: String(raw.uci),
      move_san: String(raw.san),
      actor_is_player: actorIsPlayer,
      player_color: raw.player_color,
      platform: raw.platform,
      speed: raw.speed,
      played_at: raw.played_at == null ? null : new Date(raw.played_at).toISOString(),
      result: raw.result,
      eco: identity.eco,
      opening_name: identity.name,
      family: identity.family,
      acceptable: classification.acceptable,
      acceptable_reason: classification.reason,
      evaluation_loss_cp: evaluationLoss == null ? null : Math.round(evaluationLoss),
      classifier_version: OPENING_CLASSIFIER_VERSION,
    });
  }

  await client.begin(async (sql) => {
    for (const batch of chunks([...observedNodes.values()], 300)) {
      await sql`
        insert into opening_positions ${sql(
          batch,
          "position_key", "fen", "eco", "opening_name", "family", "variation",
          "ply", "representative_line_uci", "representative_line_san",
          "source_revision", "source_license", "catalogue",
        )}
        on conflict (position_key) do update set
          eco = coalesce(opening_positions.eco, excluded.eco),
          opening_name = coalesce(opening_positions.opening_name, excluded.opening_name),
          family = coalesce(opening_positions.family, excluded.family),
          variation = coalesce(opening_positions.variation, excluded.variation),
          updated_at = now()`;
    }
    for (const batch of chunks([...observedEdges.values()], 300)) {
      await sql`
        insert into opening_edges ${sql(
          batch,
          "from_key", "move_uci", "to_key", "move_san", "catalogue", "source_revision",
        )}
        on conflict (from_key, move_uci, to_key) do update set
          move_san = excluded.move_san,
          catalogue = opening_edges.catalogue or excluded.catalogue`;
    }
    for (const batch of chunks(observations, 300)) {
      await sql`
        insert into player_opening_observations ${sql(
          batch,
          "user_id", "game_id", "ply", "position_key", "next_position_key",
          "move_uci", "move_san", "actor_is_player", "player_color", "platform",
          "speed", "played_at", "result", "eco", "opening_name", "family",
          "acceptable", "acceptable_reason", "evaluation_loss_cp", "classifier_version",
        )}
        on conflict (game_id, ply) do update set
          position_key = excluded.position_key,
          next_position_key = excluded.next_position_key,
          move_uci = excluded.move_uci,
          move_san = excluded.move_san,
          actor_is_player = excluded.actor_is_player,
          player_color = excluded.player_color,
          platform = excluded.platform,
          speed = excluded.speed,
          played_at = excluded.played_at,
          result = excluded.result,
          eco = excluded.eco,
          opening_name = excluded.opening_name,
          family = excluded.family,
          acceptable = excluded.acceptable,
          acceptable_reason = excluded.acceptable_reason,
          evaluation_loss_cp = excluded.evaluation_loss_cp,
          classifier_version = excluded.classifier_version,
          updated_at = now()`;
    }
  });

  return {
    userId: account.userId,
    games: new Set(moveRows.map((row) => String(row.game_id))).size,
    observations: observations.length,
  };
}

function passes(row: ObservationRow, filters: ExplorerFilters): boolean {
  if (filters.platform && filters.platform !== "all" && row.platform !== filters.platform) return false;
  if (filters.speed && filters.speed !== "all" && row.speed !== filters.speed) return false;
  if (filters.color && filters.color !== "all" && row.player_color !== filters.color) return false;
  if (filters.since && (!row.played_at || new Date(row.played_at) < new Date(filters.since))) return false;
  return true;
}

function finding(nodeRows: ObservationRow[], incomingCount: number): OpeningFinding {
  const row = nodeRows[0]!;
  const decisions = nodeRows.filter((item) => item.actor_is_player);
  const scored = decisions.filter((item) => item.acceptable != null);
  const name = String(row.node_name ?? row.opening_name ?? row.family ?? "Unclassified");
  return {
    nodeKey: row.position_key,
    name,
    family: String(row.family ?? splitOpeningName(name).family),
    variation: row.variation == null ? splitOpeningName(name).variation : String(row.variation),
    fen: row.fen,
    lineSan: String(row.representative_line_san ?? ""),
    lineUci: String(row.representative_line_uci ?? ""),
    opportunities: scored.length,
    games: new Set(decisions.map((item) => item.game_id)).size,
    acceptable: scored.filter((item) => item.acceptable).length,
    failures: scored.filter((item) => !item.acceptable).length,
    metrics: metrics(nodeRows),
    transposition: incomingCount > 1,
  };
}

const STATUS_PRIORITY: Record<MasteryMetrics["status"], number> = {
  blind_spot: 5,
  decaying: 4,
  unstable: 3,
  emerging: 2,
  stable: 1,
};

function weaknessOrder(left: OpeningFinding, right: OpeningFinding): number {
  return (
    STATUS_PRIORITY[right.metrics.status] - STATUS_PRIORITY[left.metrics.status] ||
    left.metrics.mastery - right.metrics.mastery ||
    Number(right.metrics.averageLossCp ?? 0) - Number(left.metrics.averageLossCp ?? 0) ||
    right.metrics.evidence - left.metrics.evidence ||
    right.opportunities - left.opportunities
  );
}

async function observationsForUser(userId: string): Promise<ObservationRow[]> {
  const rows = await client`
    select o.*, p.fen, p.opening_name as node_name, p.variation,
      p.representative_line_san, p.representative_line_uci,
      g.opponent_username, g.url, g.platform_game_id,
      pe.best_move_uci
    from player_opening_observations o
    join opening_positions p on p.position_key = o.position_key
    join games g on g.id = o.game_id
    left join lateral (
      select best_move_uci from position_eval
      where fen = p.fen and profile_id = 'screening'
      order by computed_at desc limit 1
    ) pe on true
    where o.user_id = ${userId}
    order by o.played_at desc nulls last, o.game_id, o.ply`;
  return rows as unknown as ObservationRow[];
}

export async function getOpeningExplorer(
  username: string,
  filters: ExplorerFilters = {},
): Promise<Record<string, unknown>> {
  const account = await findUser(username);
  let rows = await observationsForUser(account.userId);
  if (!rows.length) {
    await buildPlayerOpeningGraph(username);
    rows = await observationsForUser(account.userId);
  }
  const filtered = rows.filter((row) => passes(row, filters));
  const incomingRows = await client`select to_key, count(distinct from_key)::int as count
    from opening_edges group by to_key`;
  const incoming = new Map(incomingRows.map((row) => [String(row.to_key), Number(row.count)]));
  const byNode = new Map<string, ObservationRow[]>();
  for (const row of filtered) {
    const list = byNode.get(row.position_key) ?? [];
    list.push(row);
    byNode.set(row.position_key, list);
  }
  const findings = [...byNode.values()]
    .filter((nodeRows) => nodeRows.some((row) => row.actor_is_player))
    .map((nodeRows) => finding(nodeRows, incoming.get(nodeRows[0]!.position_key) ?? 0))
    .filter((item) => item.opportunities > 0)
    .sort(weaknessOrder);

  const familyMap = new Map<string, ObservationRow[]>();
  for (const row of filtered.filter((item) => item.actor_is_player)) {
    const family = String(row.family ?? "Unclassified");
    const list = familyMap.get(family) ?? [];
    list.push(row);
    familyMap.set(family, list);
  }
  const families = [...familyMap.entries()].map(([family, familyRows]) => {
    const familyFindings = findings.filter((item) => item.family === family);
    const weakest = familyFindings[0];
    const familyMetrics = metrics(familyRows, "game");
    return {
      family,
      games: new Set(familyRows.map((row) => row.game_id)).size,
      opportunities: familyRows.filter((row) => row.acceptable != null).length,
      acceptable: familyRows.filter((row) => row.acceptable === true).length,
      failures: familyRows.filter((row) => row.acceptable === false).length,
      mastery: familyMetrics.mastery,
      evidence: familyMetrics.evidence,
      status: familyMetrics.status,
      weakestNodeKey: weakest?.nodeKey ?? null,
      weakestLine: weakest?.name ?? family,
    };
  }).sort((left, right) =>
    STATUS_PRIORITY[right.status] - STATUS_PRIORITY[left.status] ||
    left.mastery - right.mastery ||
    right.games - left.games,
  );

  const selectedKey = filters.node ??
    (filters.family ? findings.find((item) => item.family === filters.family)?.nodeKey : null) ??
    families[0]?.weakestNodeKey ??
    findings[0]?.nodeKey ??
    null;
  const selectedRows = selectedKey ? byNode.get(selectedKey) ?? [] : [];
  const selected = selectedRows.length
    ? finding(selectedRows, incoming.get(selectedKey!) ?? 0)
    : null;
  const childMap = new Map<string, ObservationRow[]>();
  for (const row of filtered.filter((item) => item.position_key === selectedKey)) {
    const key = `${row.move_uci}|${row.next_position_key}`;
    const list = childMap.get(key) ?? [];
    list.push(row);
    childMap.set(key, list);
  }
  const children = [...childMap.entries()].map(([key, edgeRows]) => {
    const [moveUci, nextPositionKey] = key.split("|");
    const nextRows = byNode.get(nextPositionKey) ?? [];
    const nextFinding = nextRows.some((row) => row.actor_is_player)
      ? finding(nextRows, incoming.get(nextPositionKey) ?? 0)
      : null;
    return {
      moveUci,
      moveSan: edgeRows[0]!.move_san,
      nextPositionKey,
      games: new Set(edgeRows.map((row) => row.game_id)).size,
      playerMove: edgeRows.some((row) => row.actor_is_player),
      mastery: nextFinding?.metrics.mastery ?? null,
      evidence: nextFinding?.metrics.evidence ?? null,
      status: nextFinding?.metrics.status ?? "opponent_reply",
      name: nextFinding?.name ?? edgeRows[0]!.opening_name ?? edgeRows[0]!.family,
      transposition: (incoming.get(nextPositionKey) ?? 0) > 1,
    };
  }).sort((left, right) => right.games - left.games).slice(0, 12);

  const failures = selectedRows
    .filter((row) => row.actor_is_player && row.acceptable === false)
    .sort((left, right) => Number(right.evaluation_loss_cp ?? 0) - Number(left.evaluation_loss_cp ?? 0))
    .slice(0, 5)
    .map((row) => ({
      gameId: row.game_id,
      platformGameId: row.platform_game_id,
      ply: Number(row.ply),
      opponent: row.opponent_username,
      playedAt: row.played_at,
      result: row.result,
      playerColor: row.player_color,
      moveUci: row.move_uci,
      moveSan: row.move_san,
      bestMoveUci: row.best_move_uci,
      evaluationLossCp: row.evaluation_loss_cp,
      reason: row.acceptable_reason,
      url: row.url,
      fen: row.fen,
    }));

  return {
    username: account.username,
    generatedAt: new Date().toISOString(),
    filters,
    sample: {
      games: new Set(filtered.map((row) => row.game_id)).size,
      observations: filtered.length,
      scoredDecisions: filtered.filter((row) => row.actor_is_player && row.acceptable != null).length,
    },
    families,
    selected,
    children,
    failures,
    findings: findings.slice(0, 12),
  };
}

export async function createOpeningDrill(
  username: string,
  positionKey: string,
): Promise<Record<string, unknown>> {
  const account = await findUser(username);
  const rows = await client`
    select o.game_id, o.position_key, pe.best_move_uci
    from player_opening_observations o
    join opening_positions p on p.position_key = o.position_key
    left join lateral (
      select best_move_uci from position_eval
      where fen = p.fen and profile_id = 'screening'
      order by computed_at desc limit 1
    ) pe on true
    where o.user_id = ${account.userId} and o.position_key = ${positionKey}
      and o.actor_is_player = true and o.acceptable = false
    order by o.evaluation_loss_cp desc nulls last limit 1`;
  if (!rows[0]?.best_move_uci) throw new Error("No engine-backed failure exists for this branch");
  const inserted = await client`
    insert into opening_drills (user_id, position_key, source_game_id, solution_uci, prompt)
    values (${account.userId}, ${positionKey}, ${String(rows[0].game_id)},
      ${String(rows[0].best_move_uci)}, 'Choose the move that preserves your opening advantage')
    on conflict (user_id, position_key, solution_uci) do update set status = 'queued'
    returning id, position_key, source_game_id, solution_uci, prompt, status, created_at`;
  return inserted[0] as Record<string, unknown>;
}

export async function setOpeningRepertoireMove(
  username: string,
  positionKey: string,
  moveUci: string,
  enabled = true,
): Promise<Record<string, unknown>> {
  const account = await findUser(username);
  const edge = await client`
    select 1 from opening_edges
    where from_key = ${positionKey} and move_uci = ${moveUci}
    limit 1`;
  if (!edge[0]) throw new Error("Move is not present in the opening graph");

  if (!enabled) {
    await client`
      delete from opening_repertoire_moves
      where user_id = ${account.userId}
        and position_key = ${positionKey}
        and move_uci = ${moveUci}`;
  } else {
    await client`
      insert into opening_repertoire_moves (user_id, position_key, move_uci)
      values (${account.userId}, ${positionKey}, ${moveUci})
      on conflict (user_id, position_key, move_uci)
      do update set updated_at = now()`;
  }

  await client`
    update player_opening_observations
    set classifier_version = 0, updated_at = now()
    where user_id = ${account.userId} and position_key = ${positionKey}`;
  return { positionKey, moveUci, enabled };
}
