/**
 * The opening explorer, read from the canonical position graph.
 *
 * The legacy explorer in `service.ts` reads `player_opening_observations`, a
 * table the import pipeline denormalizes out of `public.games`. This one reads
 * E09's `chess.position_occurrences` / `chess.position_transitions` instead,
 * which changes three things that matter:
 *
 *   1. **Transpositions are found, not approximated.** A core position is board,
 *      side to move, castling rights and a *legal* en-passant square, and
 *      nothing else, so two move orders reaching the same board share one
 *      `core_position_id` by construction rather than by a query remembering to
 *      normalize a FEN.
 *   2. **The decision verdict is cited, not recomputed.** E12 already wrote
 *      `analysis.transition_assessments.played_move_acceptable` against a
 *      versioned tolerance, and E11 already decided which analysis run is the
 *      published one. Reclassifying here would produce a second opinion with no
 *      provenance, which is exactly what the versioning exists to prevent.
 *   3. **Loss is expected score, not centipawns.** `decision_loss` is a
 *      generated column over `expected_score_before - expected_score_after`, in
 *      the 0..1 units the calibration pins. The legacy wire field `al` is
 *      documented as centipawns; multiplying one into the other would put a
 *      number on the page whose stated unit is false, so `al` is left absent
 *      and the expected-score figure travels as `dl` under its own name.
 *
 * What is *not* rebuilt here: `buildPersonalOpeningTree` and the compact wire
 * encoding are pure functions over `TreeObservation`, so they are reused
 * verbatim. This module's whole job is to produce that array from `chess.*`.
 *
 * The opening names come from the same Lichess catalogue the legacy explorer
 * uses. That join is safe because `public.opening_positions.position_key` and
 * `chess.core_positions.core_key` are the same string: both are the four-field
 * FEN prefix with the en-passant square kept only when a capture onto it is
 * legal. The catalogue is built with chess.js and the core key with chessops,
 * and the two agree on that rule — including when the capturing pawn is pinned.
 * `subject-explorer.test.ts` pins that agreement so a library upgrade that
 * changes it fails here rather than silently emptying every opening name.
 */

import type { Queryable } from "../db/queryable.js";
import { toDate } from "../db/timestamps.js";
import {
  buildPersonalOpeningTree,
  focusPersonalOpeningTree,
  type PersonalOpeningTree,
  type TreeObservation,
} from "./tree.js";

/**
 * How deep the explorer looks.
 *
 * The same bound the legacy explorer uses. It is not a display limit: it caps
 * the join, which is one row per ply per game and would otherwise be ~80k rows
 * for a thousand-game subject.
 */
export const MAX_OPENING_PLIES = 30;

export interface ExplorerFilters {
  /** Provider slug, e.g. `lichess`. Null means every linked provider. */
  readonly provider: string | null;
  /** `bullet` | `blitz` | `rapid` | `classical` | `correspondence`. */
  readonly speed: string | null;
  /** The side being studied. Null means both. */
  readonly color: "white" | "black" | null;
  /** ISO instant; games played before it are excluded. */
  readonly since: string | null;
  /** Restrict to one opening family. */
  readonly family: string | null;
}

export const NO_FILTERS: ExplorerFilters = {
  provider: null,
  speed: null,
  color: null,
  since: null,
  family: null,
};

/** What the caller's games could support, stated rather than implied. */
export interface ExplorerCoverage {
  /** Games that reached the graph at all. */
  readonly games: number;
  /** Position visits inside the ply bound. */
  readonly observations: number;
  /**
   * Player decisions carrying a published verdict. The gap between this and
   * `playerDecisions` is unanalysed games, and the UI has to say so rather than
   * render the difference as "no mistakes".
   */
  readonly scoredDecisions: number;
  /** Player decisions in range, analysed or not. */
  readonly playerDecisions: number;
  /** Games with no published analysis run behind them. */
  readonly unanalysedGames: number;
}

interface ObservationRow {
  subject_game_id: string;
  ply: number;
  position_key: string;
  next_position_key: string | null;
  uci: string | null;
  san: string | null;
  subject_color: "white" | "black" | null;
  played_at: string | Date | null;
  played_move_acceptable: boolean | null;
  decision_loss: string | number | null;
  node_name: string | null;
  next_node_name: string | null;
  opening_family: string | null;
  analysed: boolean;
  materialized_at: string | Date | null;
  analysed_at: string | Date | null;
}

/**
 * Every position visit in the subject's games, inside the ply bound.
 *
 * The scoping chain is `subject_games -> game_replay_revisions ->
 * materialization_runs(published) -> position_occurrences`, and it is walked in
 * that direction deliberately. Starting from `position_occurrences` and
 * filtering to the subject afterwards would make the tenancy boundary a
 * property of the `where` clause; starting from `subject_games` makes it a
 * property of the join, which is the one a missing predicate cannot widen.
 *
 * `sg.latest_replay_revision_id` is the subject's own pointer, not
 * `pg.current_replay_revision_id`. They can differ while a provider correction
 * is mid-flight, and the subject's is the one an analysis cited.
 */
async function observationRows(
  sql: Queryable,
  subjectId: string,
  filters: ExplorerFilters,
): Promise<ObservationRow[]> {
  return sql<ObservationRow[]>`
    select
      sg.id                             as subject_game_id,
      o.ply,
      cp.core_key                       as position_key,
      nxt.core_key                      as next_position_key,
      t.uci,
      t.san,
      sg.subject_color,
      rev.played_at,
      ta.played_move_acceptable,
      ta.decision_loss,
      cat.opening_name                  as node_name,
      ncat.opening_name                 as next_node_name,
      coalesce(cat.family, ncat.family) as opening_family,
      (sgp.run_id is not null)          as analysed,
      mr.published_at                   as materialized_at,
      sgp.published_at                  as analysed_at
    from chess.subject_games sg
    join chess.game_replay_revisions rev
      on rev.id = sg.latest_replay_revision_id
    join chess.provider_games pg on pg.id = sg.provider_game_id
    join app.providers prov on prov.id = pg.provider_id
    join chess.materialization_runs mr
      on mr.replay_revision_id = rev.id and mr.state = 'published'
    -- Strictly less than the bound: the row is the *from* occurrence, and the
    -- position it reaches is one ply deeper. Using <= would put nodes at
    -- ply 31 in a graph that claims to stop at 30.
    join chess.position_occurrences o
      on o.run_id = mr.id and o.ply < ${MAX_OPENING_PLIES}
    join chess.core_positions cp on cp.id = o.core_position_id
    -- The move played from here, and the position it reaches. Both are left
    -- joins: the final ply of a game has no continuation, and a node with no
    -- outgoing edge is a real observation the tree counts as terminal.
    left join chess.position_transitions t
      on t.run_id = o.run_id and t.from_ply = o.ply
    left join chess.position_occurrences nxt_occ
      on nxt_occ.run_id = o.run_id and nxt_occ.ply = o.ply + 1
    left join chess.core_positions nxt on nxt.id = nxt_occ.core_position_id
    -- The published analysis for this game, and its verdict on this move. A
    -- game with no publication contributes positions but no decisions, which is
    -- what coverage.unanalysedGames reports.
    left join analysis.subject_game_publications sgp
      on sgp.subject_game_id = sg.id
    left join analysis.transition_assessments ta
      on ta.analysis_run_id = sgp.run_id
     and ta.materialization_run_id = mr.id
     and ta.from_ply = o.ply
    -- Opening identity, by exact core key. A position one move out of book has
    -- no row here and is correctly left unnamed.
    left join public.opening_positions cat on cat.position_key = cp.core_key
    left join public.opening_positions ncat on ncat.position_key = nxt.core_key
    where sg.subject_id = ${subjectId}
      and sg.status = 'included'
      and sg.latest_replay_revision_id is not null
      ${filters.provider ? sql`and prov.slug = ${filters.provider}` : sql``}
      ${filters.speed ? sql`and rev.speed = ${filters.speed}` : sql``}
      ${filters.color ? sql`and sg.subject_color = ${filters.color}` : sql``}
      ${filters.since ? sql`and rev.played_at >= ${filters.since}::timestamptz` : sql``}
    order by rev.played_at desc, sg.id, o.ply
  `;
}

/**
 * Whose move it was.
 *
 * Derived from ply parity rather than read from the assessment, because an
 * unanalysed game has no assessment and its moves still belong to somebody. Ply
 * 0 is the initial position with White to move, so an even ply is White's.
 */
function actorIsPlayer(ply: number, subjectColor: "white" | "black" | null): boolean {
  if (!subjectColor) return false;
  return (ply % 2 === 0 ? "white" : "black") === subjectColor;
}

/**
 * A published verdict, or no verdict.
 *
 * `played_move_acceptable` is `not null` in the schema, so a null here means
 * there is no assessment row — the game was never analysed. That is distinct
 * from an analysed move judged unacceptable, and the tree keeps them apart:
 * `null` contributes no opportunity, `false` contributes a failure.
 */
function verdictOf(row: ObservationRow): boolean | null {
  return row.played_move_acceptable ?? null;
}

/** `decision_loss` arrives as numeric; postgres.js hands numerics over as text. */
function lossOf(row: ObservationRow): number | null {
  if (row.decision_loss === null || row.decision_loss === undefined) return null;
  const value = typeof row.decision_loss === "number" ? row.decision_loss : Number(row.decision_loss);
  return Number.isFinite(value) ? value : null;
}

export interface SubjectObservations {
  readonly observations: TreeObservation[];
  /**
   * The newest publication behind this answer, or null when nothing is
   * published yet.
   *
   * Deliberately not "when this ran". A read whose body carries the clock has a
   * different ETag on every request, so the validator can never match and the
   * conditional-request machinery becomes decoration. It is also the less
   * truthful of the two: the reader wants to know how current the data is, not
   * how recently a query executed over stale rows.
   */
  readonly asOf: string | null;
  readonly coverage: ExplorerCoverage;
  /** Mean expected-score loss per edge id, in 0..1. Absent when unanalysed. */
  readonly decisionLoss: Map<string, number>;
}

/**
 * Turn the position graph into the tree builder's input.
 *
 * Only rows with a continuation become observations: a `TreeObservation` *is* a
 * move, and the tree derives terminal nodes from the moves that never leave
 * them. The final ply of every game is therefore counted in `observations` for
 * coverage but contributes no edge, which is the same thing the legacy builder
 * does.
 */
export async function readSubjectObservations(
  sql: Queryable,
  subjectId: string,
  filters: ExplorerFilters = NO_FILTERS,
): Promise<SubjectObservations> {
  const rows = await observationRows(sql, subjectId, filters);

  const observations: TreeObservation[] = [];
  const games = new Set<string>();
  const unanalysed = new Set<string>();
  const lossTotals = new Map<string, { sum: number; count: number }>();
  let playerDecisions = 0;
  let scoredDecisions = 0;
  let asOf: Date | null = null;

  for (const row of rows) {
    games.add(row.subject_game_id);
    if (!row.analysed) unanalysed.add(row.subject_game_id);

    for (const stamp of [toDate(row.materialized_at), toDate(row.analysed_at)]) {
      if (stamp && (asOf === null || stamp > asOf)) asOf = stamp;
    }

    // No continuation: the game ended here. Counted above, no edge below.
    if (!row.uci || !row.san || !row.next_position_key) continue;

    const isPlayer = actorIsPlayer(row.ply, row.subject_color);
    const verdict = verdictOf(row);
    if (isPlayer) {
      playerDecisions += 1;
      if (verdict !== null) scoredDecisions += 1;
    }

    const loss = lossOf(row);
    if (isPlayer && loss !== null) {
      const id = `${row.position_key}|${row.uci}`;
      const acc = lossTotals.get(id) ?? { sum: 0, count: 0 };
      acc.sum += loss;
      acc.count += 1;
      lossTotals.set(id, acc);
    }

    observations.push({
      gameId: row.subject_game_id,
      positionKey: row.position_key,
      nextPositionKey: row.next_position_key,
      // The core key is the first four FEN fields; the tree only needs a FEN to
      // render a board, and the counters it omits are history the key drops on
      // purpose. Same convention as the legacy graph's `fenFromNode`.
      fen: `${row.position_key} 0 1`,
      nextFen: `${row.next_position_key} 0 1`,
      // `TreeObservation.ply` is the ply the move *reaches*, not the one it
      // leaves: `buildPersonalOpeningTree` derives the source node's ply as
      // `ply - 1`. Passing the from-ply here put every node one ply shallow and
      // collapsed the root into the first-move positions.
      ply: row.ply + 1,
      moveUci: row.uci,
      moveSan: row.san,
      actorIsPlayer: isPlayer,
      acceptable: verdict,
      // The reason vocabulary belongs to the legacy classifier. E12 published a
      // verdict against a versioned tolerance and no reason string, and
      // inventing one here would attribute a rationale to a run that never
      // stated it.
      acceptableReason: null,
      // Deliberately null: see the module header. The expected-score figure
      // travels separately, under a name that says what it is.
      evaluationLossCp: null,
      playedAt: row.played_at,
      nodeName: row.node_name,
      nextNodeName: row.next_node_name,
      openingFamily: row.opening_family,
    });
  }

  const decisionLoss = new Map<string, number>();
  for (const [id, acc] of lossTotals) {
    if (acc.count > 0) decisionLoss.set(id, acc.sum / acc.count);
  }

  return {
    observations,
    decisionLoss,
    asOf: asOf === null ? null : (asOf as Date).toISOString(),
    coverage: {
      games: games.size,
      observations: rows.length,
      scoredDecisions,
      playerDecisions,
      unanalysedGames: unanalysed.size,
    },
  };
}

/** A node in the wire graph. Single letters: this ships whole and is walked client-side. */
export interface ExplorerGraphNode {
  /** Canonical position key, which doubles as a FEN prefix. */
  readonly k: string;
  readonly p: number;
  readonly g: number;
  readonly o: number;
  readonly f: number;
  readonly t: number;
  readonly x: 0 | 1;
  readonly nm?: string;
}

export interface ExplorerGraphEdge {
  readonly a: number;
  readonly b: number;
  readonly u: string;
  readonly s: string;
  readonly g: number;
  readonly sh: number;
  readonly ac: "p" | "o" | "m";
  readonly op: number;
  readonly fa: number;
  /**
   * Mean expected-score loss when the player chose this move, 0..1.
   *
   * Not centipawns. The legacy graph's `al` is cp and is deliberately absent
   * from this payload rather than filled with a converted number.
   */
  readonly dl?: number;
  readonly lb?: string;
  readonly ev?: number;
  readonly bm?: 1;
}

export interface ExplorerGraph {
  readonly games: number;
  readonly root: number;
  readonly nodes: ExplorerGraphNode[];
  readonly edges: ExplorerGraphEdge[];
}

/** Screening eval and best move for a core position, White's perspective. */
export interface PositionScreening {
  readonly evalCp: number | null;
  readonly bestMoveUci: string | null;
}

/**
 * The latest screening evaluation for each position in the graph.
 *
 * `core` is the ideal scope here — history-free, so it answers "what is this
 * position worth" rather than "what happened in one game that reached it". But
 * nothing in the product writes one: `engine/contract.ts` `requiredScope()`
 * returns `history_exact` or `rule50` and never `core`, so filtering on `core`
 * alone would be a join that can only ever return nothing.
 *
 * `rule50` is accepted alongside it, and preferred *after* it in the ordering.
 * A rule50 evaluation is the position plus its halfmove clock, and inside the
 * opening that clock is never near the fifty-move threshold, so it is the same
 * assessment of the same board. It is used as a screening figure about a
 * position and never cited as exact evidence about an occurrence, which is the
 * distinction `analysis.enforce_assessment_evidence()` protects.
 */
export async function readScreeningEvaluations(
  sql: Queryable,
  positionKeys: readonly string[],
): Promise<Map<string, PositionScreening>> {
  if (positionKeys.length === 0) return new Map();
  const rows = await sql<
    { core_key: string; score_cp: number | null; best_move_uci: string | null }[]
  >`
    select distinct on (cp.core_key)
      cp.core_key, pe.score_cp, pe.best_move_uci
    from chess.core_positions cp
    join analysis.position_evaluations pe
      on pe.core_position_id = cp.id and pe.scope in ('core', 'rule50')
    where cp.core_key = any(${positionKeys as string[]}::text[])
    order by cp.core_key, (pe.scope = 'core') desc, pe.computed_at desc, pe.id desc
  `;
  const out = new Map<string, PositionScreening>();
  for (const row of rows) {
    out.set(row.core_key, { evalCp: row.score_cp, bestMoveUci: row.best_move_uci });
  }
  return out;
}

/**
 * Compact the tree for the wire.
 *
 * Nodes are referenced by index and keep only their key, so no full FENs ship.
 * Mirrors the legacy encoding field for field, minus `al` and plus `dl`, so a
 * client can walk either with the same code.
 */
export function compactExplorerGraph(
  tree: PersonalOpeningTree,
  screening: Map<string, PositionScreening>,
  decisionLoss: Map<string, number>,
): ExplorerGraph {
  const index = new Map<string, number>();
  tree.nodes.forEach((node, i) => index.set(node.key, i));

  return {
    games: tree.games,
    root: index.get(tree.rootKey) ?? 0,
    nodes: tree.nodes.map((node) => ({
      k: node.key,
      p: node.ply,
      g: node.games,
      o: node.opportunities,
      f: node.failures,
      t: node.terminalGames,
      x: node.transposition ? (1 as const) : (0 as const),
      nm: node.name ?? undefined,
    })),
    edges: tree.edges.flatMap((edge) => {
      const a = index.get(edge.fromKey);
      const b = index.get(edge.toKey);
      // An edge whose endpoints are not both in the node set would index out of
      // bounds on the client. `focusPersonalOpeningTree` prunes nodes, so drop
      // rather than emit a dangling reference.
      if (a === undefined || b === undefined) return [];
      const parent = screening.get(edge.fromKey);
      const child = screening.get(edge.toKey);
      const loss = decisionLoss.get(`${edge.fromKey}|${edge.moveUci}`);
      return [
        {
          a,
          b,
          u: edge.moveUci,
          s: edge.moveSan,
          g: edge.games,
          sh: edge.sharePercent,
          ac:
            edge.actor === "player"
              ? ("p" as const)
              : edge.actor === "opponent"
                ? ("o" as const)
                : ("m" as const),
          op: edge.opportunities,
          fa: edge.failures,
          dl: loss ?? undefined,
          lb: edge.openingLabel ?? undefined,
          ev: child?.evalCp ?? undefined,
          bm: parent?.bestMoveUci && parent.bestMoveUci === edge.moveUci ? (1 as const) : undefined,
        },
      ];
    }),
  };
}

export interface ExplorerFamily {
  readonly family: string;
  readonly games: number;
  readonly playerDecisions: number;
  readonly scoredDecisions: number;
  readonly failures: number;
}

/**
 * The families present in the sample, with what is actually known about each.
 *
 * Deliberately not a mastery estimate. E15 owns estimation, and a second
 * shrinkage formula here would be a competing claim with no version behind it.
 * These are counts, and a count is either right or absent.
 */
export function summarizeFamilies(observations: readonly TreeObservation[]): ExplorerFamily[] {
  const byFamily = new Map<
    string,
    { games: Set<string>; player: number; scored: number; failures: number }
  >();
  for (const o of observations) {
    if (!o.actorIsPlayer) continue;
    const family = o.openingFamily ?? "Unclassified";
    const acc = byFamily.get(family) ?? {
      games: new Set<string>(),
      player: 0,
      scored: 0,
      failures: 0,
    };
    acc.games.add(o.gameId);
    acc.player += 1;
    if (o.acceptable !== null) acc.scored += 1;
    if (o.acceptable === false) acc.failures += 1;
    byFamily.set(family, acc);
  }
  return [...byFamily.entries()]
    .map(([family, acc]) => ({
      family,
      games: acc.games.size,
      playerDecisions: acc.player,
      scoredDecisions: acc.scored,
      failures: acc.failures,
    }))
    .sort((left, right) => right.games - left.games || left.family.localeCompare(right.family));
}

export interface SubjectExplorer {
  /** The newest publication behind this answer; null when nothing is published. */
  readonly asOf: string | null;
  readonly filters: ExplorerFilters;
  readonly coverage: ExplorerCoverage;
  readonly families: ExplorerFamily[];
  /** Null when the sample has no move in it: an empty graph is not a graph. */
  readonly graph: ExplorerGraph | null;
}

/**
 * The whole read.
 *
 * Carries no clock. Everything in the body is derived from rows, which is what
 * makes two identical reads produce the same ETag and lets the 304 path work.
 */
export async function readSubjectExplorer(
  sql: Queryable,
  subjectId: string,
  filters: ExplorerFilters = NO_FILTERS,
): Promise<SubjectExplorer> {
  const { observations, coverage, decisionLoss, asOf } = await readSubjectObservations(
    sql,
    subjectId,
    filters,
  );

  const families = summarizeFamilies(observations);
  const scope = filters.family ? "family" : "player";

  // Null exactly when there is no move in the sample. Kept as a branch rather
  // than an assertion: "no games yet", "the filters excluded everything" and
  // "the graph is empty" are the same shape on the wire, and the client says
  // which from `coverage` rather than from a thrown error.
  let tree = buildPersonalOpeningTree(filters.family ?? "All openings", observations, scope);
  if (!tree) {
    return { asOf, filters, coverage, families, graph: null };
  }

  if (filters.family) {
    // Keep only the walk into the family and its siblings, the same focusing the
    // legacy explorer applies, so the client does not have to prune.
    const entry = tree.nodes.find((node) => node.name === filters.family);
    if (entry) tree = focusPersonalOpeningTree(tree, entry.key);
  }

  const screening = await readScreeningEvaluations(
    sql,
    tree.nodes.map((node) => node.key),
  );

  return {
    asOf,
    filters,
    coverage,
    families,
    graph: compactExplorerGraph(tree, screening, decisionLoss),
  };
}
