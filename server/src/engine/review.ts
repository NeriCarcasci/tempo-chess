/**
 * The published objective review of one game, as the API reads it.
 *
 * API contract §7 asks `GET /games/{gameId}/review` for "replay moves/positions,
 * transition assessments, critical moments, events, concepts, explanations,
 * trajectory, and evidence links for one coherent published run" and requires
 * that "pending/failed/unavailable components are explicit".
 *
 * This epic produces the first three. Events, concepts and explanations are
 * E13's and E15's, and they are reported as `unavailable` rather than as empty
 * arrays — an empty `events: []` is a claim that the detectors ran and found
 * nothing, which would be the exact false-negative the epic is not allowed to
 * ship. `sections` is where that distinction lives, so a client can render "not
 * yet analysed for tactics" instead of "no tactics here".
 *
 * "One coherent published run" is load-bearing too: every move in the response
 * comes from the run the pointer currently names, so a client never sees half a
 * new analysis stitched to half an old one. Ownership is an argument to the
 * query, so a game belonging to someone else is indistinguishable from one that
 * does not exist.
 */

import type { Queryable } from "../db/queryable.js";
import type { VersionBlock } from "../v1/envelope.js";
import type { DeepStatus } from "./contract.js";

/** Whether a review section has anything to say, and why when it does not. */
export type SectionState = "published" | "unavailable";

export interface ReviewMove {
  fromPly: number;
  uci: string;
  san: string | null;
  actorColor: "white" | "black";
  phase: string | null;
  /** Actor-perspective, from the pinned calibration. */
  expectedScoreBefore: number;
  expectedScoreAfter: number;
  decisionLoss: number;
  /** Against the tolerance rule the run pinned. Not a "mistake" label. */
  acceptable: boolean;
  bestMoveUci: string | null;
  playedMoveRank: number | null;
  /** Null when the search that answered retained one line. */
  acceptableMoveCount: number | null;
  onlyMove: boolean | null;
  criticality: number | null;
  /** What each side of the evidence was computed over. */
  evidence: { beforeScope: string; afterScope: string };
  deep: {
    status: DeepStatus;
    reasons: { code: string; observed: number | string }[];
    candidates: { rank: number; uci: string; expectedScore: number; pv: string[] }[];
  };
  /**
   * How hard the position this move created is for *this* opponent, or why
   * Forma will not say. Always present, never omitted: an absent field reads as
   * "no pressure" and this one has to be able to say "we do not know".
   */
  practicalContext: PracticalContextView;
}

/**
 * The human layer, kept structurally separate from the objective one.
 *
 * `unavailable` carries the reason rather than an empty object, because the
 * product's answer to an uncalibrated player is a sentence about Forma's
 * coverage and not a blank space. Pressure is an interval: the lower bound
 * assumes every move the model did not retain was adequate and the upper bound
 * assumes none was, and quoting either alone would be an assumption presented
 * as a measurement.
 */
export type PracticalContextView =
  | { status: "unavailable"; reason: string }
  | {
      status: "available";
      adequateReplyCount: number;
      adequateReplyProbability: number;
      unretainedProbabilityMass: number;
      practicalPressureLower: number;
      practicalPressureUpper: number;
      policyEntropyBits: number;
      entropyIsLowerBound: boolean;
      bestRefutationUci: string | null;
      bestRefutationProbability: number | null;
      bestRefutationRank: number | null;
      humanExpectedScore: number | null;
      outOfDomain: boolean;
      opponentConceded: boolean | null;
      subjectCapitalized: boolean | null;
    };

export interface GameReview {
  gameId: string;
  runId: string;
  replayRevisionId: string;
  /** True when the published run read an older revision than the current one. */
  stale: boolean;
  sections: {
    transitions: SectionState;
    criticalMoments: SectionState;
    events: SectionState;
    concepts: SectionState;
    explanations: SectionState;
    trajectory: SectionState;
    practicalContext: SectionState;
  };
  moves: ReviewMove[];
  criticalMoments: { fromPly: number; criticality: number | null; reasons: string[] }[];
  version: VersionBlock;
}

interface PublicationRow {
  run_id: string;
  publication_id: string;
  published_at: string;
  recipe_version_id: string;
  published_revision_id: string;
  latest_revision_id: string;
}

/**
 * Read the published review of one owned game, or null.
 *
 * Null covers three different situations on purpose — the game does not exist,
 * it belongs to someone else, or it has no publication — because the API's
 * answer to all three is the same 404 and distinguishing them in the response
 * is how an identifier becomes probeable.
 */
export async function readGameReview(
  sql: Queryable,
  input: { subjectGameId: string; ownerProfileId: string },
): Promise<GameReview | null> {
  const [publication] = await sql<PublicationRow[]>`
    select pub.run_id, pub.publication_id, pub.published_at, pub.recipe_version_id,
           pub.replay_revision_id as published_revision_id,
           sg.latest_replay_revision_id as latest_revision_id
    from analysis.subject_game_publications pub
    join chess.subject_games sg on sg.id = pub.subject_game_id
    join app.analysis_subjects s on s.id = sg.subject_id
    where pub.subject_game_id = ${input.subjectGameId}
      and s.owner_user_id = ${input.ownerProfileId}
  `;
  if (!publication) return null;

  const rows = await sql<
    {
      from_ply: number;
      uci: string;
      san: string | null;
      actor_color: "white" | "black";
      phase: string | null;
      expected_score_before: string;
      expected_score_after: string;
      decision_loss: string;
      played_move_acceptable: boolean;
      best_move_uci: string | null;
      played_move_rank: number | null;
      acceptable_move_count: number | null;
      only_move: boolean | null;
      criticality: string | null;
      deep_status: DeepStatus;
      deep_selection_reasons: { code: string; observed: number | string }[];
      difficulty_features: Record<string, unknown>;
      deep_evaluation_id: string | null;
    }[]
  >`
    select ta.from_ply, pt.uci, pt.san, ta.actor_color, ta.phase,
           ta.expected_score_before, ta.expected_score_after, ta.decision_loss,
           ta.played_move_acceptable, ta.best_move_uci, ta.played_move_rank,
           ta.acceptable_move_count, ta.only_move, ta.criticality, ta.deep_status,
           ta.deep_selection_reasons, ta.difficulty_features, ta.deep_evaluation_id
    from analysis.transition_assessments ta
    join chess.position_transitions pt
      on pt.run_id = ta.materialization_run_id and pt.from_ply = ta.from_ply
    where ta.analysis_run_id = ${publication.run_id}
    order by ta.from_ply
  `;

  const deepIds = rows.map((row) => row.deep_evaluation_id).filter((id): id is string => id !== null);
  const candidates = await readCandidates(sql, deepIds);
  const practical = await readPracticalContext(sql, publication.run_id);

  const moves: ReviewMove[] = rows.map((row) => ({
    fromPly: row.from_ply,
    uci: row.uci,
    san: row.san,
    actorColor: row.actor_color,
    phase: row.phase,
    expectedScoreBefore: Number(row.expected_score_before),
    expectedScoreAfter: Number(row.expected_score_after),
    decisionLoss: Number(row.decision_loss),
    acceptable: row.played_move_acceptable,
    bestMoveUci: row.best_move_uci,
    playedMoveRank: row.played_move_rank,
    acceptableMoveCount: row.acceptable_move_count,
    onlyMove: row.only_move,
    criticality: row.criticality == null ? null : Number(row.criticality),
    evidence: {
      beforeScope: String(row.difficulty_features.beforeScope ?? "unknown"),
      afterScope: String(row.difficulty_features.afterScope ?? "unknown"),
    },
    deep: {
      status: row.deep_status,
      reasons: row.deep_selection_reasons.map((reason) => ({
        code: reason.code,
        observed: reason.observed,
      })),
      candidates: row.deep_evaluation_id ? (candidates.get(row.deep_evaluation_id) ?? []) : [],
    },
    // A run written before E14, or one whose step has not landed yet, has no
    // row for this ply. `unavailable` with a named reason is the honest reading
    // of that, and it is the same shape the computed refusals take.
    practicalContext: practical.get(row.from_ply) ?? {
      status: "unavailable",
      reason: "no_promoted_model",
    },
  }));

  return {
    gameId: input.subjectGameId,
    runId: publication.run_id,
    replayRevisionId: String(publication.published_revision_id),
    stale: String(publication.published_revision_id) !== String(publication.latest_revision_id),
    sections: {
      // Published, not "published when non-empty". A run reaches this pointer
      // only after its manifest covered the transition-assessment family, and a
      // family with a count of zero is a complete answer about a game with no
      // transitions. Downgrading it here would report a run that succeeded as
      // one that did not happen.
      transitions: "published",
      criticalMoments: "published",
      // Published in the sense that the section was computed and every move
      // carries an answer. Whether that answer is a number or a reason is a
      // per-move fact, not a section-level one.
      practicalContext: practical.size > 0 ? "published" : "unavailable",
      // E13 and E15. Named rather than omitted, and `unavailable` rather than
      // empty, so a client cannot read "not analysed yet" as "nothing found".
      events: "unavailable",
      concepts: "unavailable",
      explanations: "unavailable",
      trajectory: "unavailable",
    },
    moves,
    criticalMoments: moves
      .filter((move) => move.deep.status !== "not_selected")
      .map((move) => ({
        fromPly: move.fromPly,
        criticality: move.criticality,
        reasons: move.deep.reasons.map((reason) => reason.code),
      })),
    version: {
      publicationId: publication.publication_id,
      generatedAt: new Date(publication.published_at).toISOString(),
      subjectSnapshotId: null,
      recipeVersionId: publication.recipe_version_id,
      policyVersions: await policyVersions(sql, publication.recipe_version_id),
    },
  };
}

async function readCandidates(
  sql: Queryable,
  evaluationIds: readonly string[],
): Promise<Map<string, { rank: number; uci: string; expectedScore: number; pv: string[] }[]>> {
  const byEvaluation = new Map<string, { rank: number; uci: string; expectedScore: number; pv: string[] }[]>();
  if (evaluationIds.length === 0) return byEvaluation;
  const rows = await sql<
    { position_evaluation_id: string; rank: number; uci: string; expected_score: string; pv: string[] }[]
  >`
    select position_evaluation_id, rank, uci, expected_score, pv
    from analysis.evaluation_candidates
    where position_evaluation_id = any(${evaluationIds}::bigint[])
    order by position_evaluation_id, rank
  `;
  for (const row of rows) {
    const key = String(row.position_evaluation_id);
    byEvaluation.set(key, [
      ...(byEvaluation.get(key) ?? []),
      { rank: row.rank, uci: row.uci, expectedScore: Number(row.expected_score), pv: row.pv },
    ]);
  }
  return byEvaluation;
}

async function policyVersions(sql: Queryable, recipeVersionId: string): Promise<Record<string, string>> {
  const rows = await sql<{ role: string; component_key: string; version: string }[]>`
    select rc.role, c.component_key, cv.version
    from analysis.recipe_components rc
    join analysis.component_versions cv on cv.id = rc.component_version_id
    join analysis.components c on c.id = cv.component_id
    where rc.recipe_version_id = ${recipeVersionId}
    order by rc.role
  `;
  return Object.fromEntries(rows.map((row) => [row.role, `${row.component_key}@${row.version}`]));
}

/**
 * The practical context of one run, by ply.
 *
 * Read in one query and keyed by ply rather than joined per move: a review is a
 * page, and a per-move round trip is how a page becomes a hundred queries.
 */
async function readPracticalContext(
  sql: Queryable,
  runId: string,
): Promise<Map<number, PracticalContextView>> {
  const rows = await sql<
    {
      from_ply: number;
      status: "available" | "unavailable";
      unavailable_reason: string | null;
      adequate_reply_count: number | null;
      adequate_reply_probability: string | null;
      unretained_probability_mass: string | null;
      practical_pressure_lower: string | null;
      practical_pressure_upper: string | null;
      policy_entropy_bits: string | null;
      entropy_is_lower_bound: boolean | null;
      best_refutation_uci: string | null;
      best_refutation_probability: string | null;
      best_refutation_rank: number | null;
      human_expected_score: string | null;
      out_of_domain: boolean;
      opponent_conceded: boolean | null;
      subject_capitalized: boolean | null;
    }[]
  >`
    select ta.from_ply, pc.status, pc.unavailable_reason, pc.adequate_reply_count,
           pc.adequate_reply_probability, pc.unretained_probability_mass,
           pc.practical_pressure_lower, pc.practical_pressure_upper,
           pc.policy_entropy_bits, pc.entropy_is_lower_bound, pc.best_refutation_uci,
           pc.best_refutation_probability, pc.best_refutation_rank,
           pc.human_expected_score, pc.out_of_domain, pc.opponent_conceded,
           pc.subject_capitalized
    from analysis.practical_context_assessments pc
    join analysis.transition_assessments ta on ta.id = pc.transition_assessment_id
    where pc.analysis_run_id = ${runId}
    order by ta.from_ply
  `;

  const byPly = new Map<number, PracticalContextView>();
  for (const row of rows) {
    if (row.status === "unavailable") {
      byPly.set(row.from_ply, {
        status: "unavailable",
        reason: row.unavailable_reason ?? "no_promoted_model",
      });
      continue;
    }
    byPly.set(row.from_ply, {
      status: "available",
      adequateReplyCount: row.adequate_reply_count ?? 0,
      adequateReplyProbability: Number(row.adequate_reply_probability),
      unretainedProbabilityMass: Number(row.unretained_probability_mass),
      practicalPressureLower: Number(row.practical_pressure_lower),
      practicalPressureUpper: Number(row.practical_pressure_upper),
      policyEntropyBits: Number(row.policy_entropy_bits),
      entropyIsLowerBound: row.entropy_is_lower_bound ?? true,
      bestRefutationUci: row.best_refutation_uci,
      bestRefutationProbability:
        row.best_refutation_probability === null ? null : Number(row.best_refutation_probability),
      bestRefutationRank: row.best_refutation_rank,
      humanExpectedScore:
        row.human_expected_score === null ? null : Number(row.human_expected_score),
      outOfDomain: row.out_of_domain,
      opponentConceded: row.opponent_conceded,
      subjectCapitalized: row.subject_capitalized,
    });
  }
  return byPly;
}
