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
import { publishedMaterializationRun } from "./recipe.js";

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

/**
 * One concept label hanging off an occurrence, as a player's client reads it.
 *
 * `success` is null when the response was censored, and `censoredReason` says
 * why. A client that renders null as a failure would undo the whole point of
 * §17.5, so the two fields travel together and neither is optional.
 */
export interface ReviewConcept {
  slug: string;
  displayName: string;
  /** The wording of the version this evidence was recorded under, not today's. */
  definition: string;
  conceptVersionId: string;
  versionNo: number;
  role: string;
  color: string;
  detectorVersion: string;
  observed: boolean;
  success: boolean | null;
  score: number | null;
  censoredReason: string | null;
  opportunityPly: number;
  responsePly: number | null;
  difficulty: Record<string, number> | null;
  confidence: number | null;
  evidenceSourceKind: "engine" | "deterministic" | "human_model";
  /** For tracing a claim in a report back to the moment it came from. */
  evidenceItemId: string | null;
}

/** One physical occurrence in a game, with everything measured about it. */
export interface ReviewEvent {
  eventType: string;
  startPly: number;
  focalPly: number;
  endPly: number;
  actorColor: "white" | "black" | null;
  affectedColor: "white" | "black" | null;
  completeness: "complete" | "incomplete" | "censored";
  confidence: number | null;
  /** Board-derived facts only; see `safeFacts`. */
  facts: Record<string, ReviewFactValue>;
  concepts: ReviewConcept[];
}

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
  /** Empty and `published` is a game with nothing in it; see `sections.events`. */
  events: ReviewEvent[];
  version: VersionBlock;
}

interface PublicationRow {
  run_id: string;
  publication_id: string;
  published_at: string;
  recipe_version_id: string;
  published_revision_id: string;
  latest_revision_id: string;
  subject_color: "white" | "black";
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
           sg.latest_replay_revision_id as latest_revision_id, sg.subject_color
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

  // Whether detection ran at all is a manifest question, not a row-count one.
  // `analysis.run_artifacts` records a family with a count of zero for a quiet
  // game; an absent row is a run that never got there. Publications written
  // before the detector existed have neither, and must keep saying unavailable.
  const detectorArtifacts = new Map(
    (await sql<{ family: string; row_count: number }[]>`
      select family, row_count from analysis.run_artifacts
      where run_id = ${publication.run_id}
        and family in ('chess_events', 'concept_opportunities')
    `).map((row) => [row.family, Number(row.row_count)] as const),
  );
  const materializationRunId = await publishedMaterializationRun(
    sql,
    String(publication.published_revision_id),
  );
  const [mapped] = materializationRunId === null
    ? []
    : await sql<{ event_count: number; opportunity_count: number }[]>`
        select count(distinct o.event_id)::int as event_count,
               count(*)::int as opportunity_count
        from analysis.run_concept_opportunities ro
        join analysis.concept_opportunities o on o.id = ro.opportunity_id
        where ro.analysis_run_id = ${publication.run_id}
          and o.run_id = ${materializationRunId}
          and o.subject_game_id = ${input.subjectGameId}
      `;
  const detectionPublished = mapped !== undefined
    && detectorArtifacts.get("chess_events") === Number(mapped.event_count)
    && detectorArtifacts.get("concept_opportunities") === Number(mapped.opportunity_count);
  const events = detectionPublished && materializationRunId !== null
    ? await readEvents(
        sql,
        publication.run_id,
        materializationRunId,
        input.subjectGameId,
        publication.subject_color,
      )
    : [];

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
      // E13. Published means the detector ran and recorded what it concluded,
      // which for a quiet game is an empty array -- a different answer from a
      // game nobody has measured. A publication written before the detector
      // existed has no manifest entry and keeps saying unavailable, so a client
      // cannot read "not analysed yet" as "nothing found".
      events: detectionPublished ? "published" : "unavailable",
      concepts: detectionPublished ? "published" : "unavailable",
      // E15, still to come. Named rather than omitted.
      explanations: "unavailable",
      trajectory: "unavailable",
    },
    moves,
    events,
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

/**
 * What a detector fact is allowed to be by the time a client sees it.
 *
 * `facts` is a jsonb column a detector writes, and shipping it verbatim would
 * make the API's shape whatever the last detector happened to put there. So it
 * is copied key by key: primitives and flat arrays of primitives survive, nested
 * objects do not, and both the array length and the string length are capped.
 *
 * Nothing here is secret -- these are squares and moves from the player's own
 * game -- but "not secret" is not the same as "bounded", and an API whose
 * response shape is decided by a detector is one no client can be written
 * against.
 */
export const REVIEW_FACT_SHAPE = {
  square: "number", piece: "string", atRiskCp: "number", squareAfter: "nullableNumber",
  remainingCp: "number", resolved: "boolean", resolution: "string", onOfferCp: "number",
  taken: "boolean", alternativeVerified: "boolean", criticality: "number", rank: "nullableNumber",
  acceptable: "boolean", acceptableMoveCount: "nullableNumber", coverage: "string",
  candidateCount: "nullableNumber", legalMoveCount: "nullableNumber", expectedScoreBefore: "number",
  converted: "nullableBoolean", censored: "nullableString", movesPlayed: "number", mover: "string",
  from: "number", to: "number", targets: "numberArray", targetValues: "numberArray",
  kingInvolved: "boolean", subtype: "string", expectedGainCp: "number",
  bestDefence: "nullableString", mate: "boolean", verificationLine: "nullableStringArray",
  verifiedBy: "string", pinner: "number", pinned: "number", target: "number", ray: "numberArray",
  pinnedValueCp: "number", targetValueCp: "number", winnableCp: "number", attacker: "number",
  front: "number", rear: "number", frontValueCp: "number", rearValueCp: "number",
  frontIsKing: "boolean", discoveredPiece: "number", moverTo: "number", uncoveredTarget: "number",
  uncoveredValueCp: "number", moverChecks: "boolean", moverTarget: "nullableNumber",
  defender: "number", defenderRole: "string", targetRole: "string", duty: "string",
  removalMethod: "string", defendersBefore: "number", followUpCp: "number", followUp: "number",
  pieceValueCp: "number", attackers: "numberArray", escapesTried: "numberArray",
  repliesConsidered: "number", expectedLossCp: "number",
} as const;

export const REVIEW_FACT_KEYS = Object.keys(REVIEW_FACT_SHAPE) as (keyof typeof REVIEW_FACT_SHAPE)[];

export type ReviewFactValue = string | number | boolean | null
  | string[] | number[];

function safeFactValue(
  kind: (typeof REVIEW_FACT_SHAPE)[keyof typeof REVIEW_FACT_SHAPE],
  value: unknown,
): ReviewFactValue | undefined {
  if (kind.startsWith("nullable") && value === null) return null;
  if ((kind === "number" || kind === "nullableNumber")
    && typeof value === "number" && Number.isFinite(value)) return value;
  if ((kind === "boolean" || kind === "nullableBoolean") && typeof value === "boolean") return value;
  if ((kind === "string" || kind === "nullableString") && typeof value === "string") {
    return value.slice(0, 120);
  }
  if ((kind === "numberArray" || kind === "nullableStringArray") && Array.isArray(value)) {
    if (value.length > 32) return undefined;
    if (kind === "numberArray" && value.every((item) =>
      typeof item === "number" && Number.isFinite(item))) return value;
    if (kind === "nullableStringArray" && value.every((item) => typeof item === "string")) {
      return value.map((item) => item.slice(0, 120));
    }
  }
  return undefined;
}

export function safeFacts(raw: unknown): Record<string, ReviewFactValue> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const safe: Record<string, ReviewFactValue> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(key in REVIEW_FACT_SHAPE)) continue;
    const checked = safeFactValue(
      REVIEW_FACT_SHAPE[key as keyof typeof REVIEW_FACT_SHAPE],
      value,
    );
    if (checked !== undefined) safe[key] = checked;
  }
  return safe;
}

interface EventRow {
  id: string;
  event_type: string;
  start_ply: number;
  focal_ply: number;
  end_ply: number;
  actor_color: "white" | "black" | null;
  affected_color: "white" | "black" | null;
  completeness: "complete" | "incomplete" | "censored";
  detection_confidence: string | null;
  detection_key: string | null;
  facts: unknown;
}

interface ConceptRow {
  event_id: string;
  slug: string;
  display_name: string;
  human_definition: string;
  concept_version_id: string;
  version_no: number;
  role: string;
  color: string;
  detector_version: string;
  response_observed: boolean;
  success: boolean | null;
  score: string | null;
  censored_reason: string | null;
  opportunity_ply: number;
  response_ply: number | null;
  difficulty: unknown;
  confidence: string | null;
  evidence_source_kind: "engine" | "deterministic" | "human_model";
  evidence_item_id: string | null;
}

function safeDifficulty(raw: unknown): Record<string, number> | null {
  if (raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const entries = Object.entries(raw as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right));
  if (entries.length > 32) return null;
  const safe: Record<string, number> = {};
  for (const [key, value] of entries) {
    if (key.length === 0 || key.length > 64 || typeof value !== "number" || !Number.isFinite(value)) {
      return null;
    }
    safe[key] = value;
  }
  return safe;
}

/**
 * The occurrences of one published game, with their labels.
 *
 * Ordered by focal ply and then detection key so two reads of the same
 * publication return the same sequence -- an ETag over a response whose array
 * order drifts is an ETag that changes for no reason.
 *
 * Read through the materialization the publication names rather than through
 * the subject game, because the evidence belongs to a position graph and a game
 * can have more than one of those over its life.
 */
async function readEvents(
  sql: Queryable,
  analysisRunId: string,
  materializationRunId: string,
  subjectGameId: string,
  subjectColor: "white" | "black",
): Promise<ReviewEvent[]> {
  const events = await sql<EventRow[]>`
    select id, event_type, start_ply, focal_ply, end_ply, actor_color, affected_color,
           completeness, detection_confidence, detection_key, facts
    from analysis.chess_events e
    where e.run_id = ${materializationRunId} and e.subject_game_id = ${subjectGameId}
      and exists (
        select 1
        from analysis.run_concept_opportunities ro
        join analysis.concept_opportunities o on o.id = ro.opportunity_id
        where ro.analysis_run_id = ${analysisRunId} and o.event_id = e.id
      )
    order by e.focal_ply, e.detection_key nulls last, e.id
  `;
  if (events.length === 0) return [];

  const labels = await sql<ConceptRow[]>`
    select o.event_id, c.slug, c.display_name, cv.human_definition,
           cv.id as concept_version_id, cv.version_no, o.role, ec.color, ec.detector_version,
           o.response_observed, o.success, o.score, o.censored_reason, o.opportunity_ply, o.response_ply,
           o.difficulty, o.confidence, o.evidence_source_kind,
           coalesce(o.evidence_item_id, (o.context->>'evidenceItemId')::bigint) as evidence_item_id
    from analysis.run_concept_opportunities ro
    join analysis.concept_opportunities o on o.id = ro.opportunity_id
    join analysis.concept_versions cv on cv.id = o.concept_version_id
    join analysis.concepts c on c.id = cv.concept_id
    -- The label carries the detector version and the colour it was recorded
    -- for. Joining on the role as well keeps recognize and execute apart, which
    -- is the distinction §17.4 exists to preserve.
    join analysis.event_concepts ec
      on ec.event_id = o.event_id
     and ec.concept_version_id = o.concept_version_id
     and ec.role = o.role
     and ec.color = ${subjectColor}
    where ro.analysis_run_id = ${analysisRunId}
      and o.run_id = ${materializationRunId} and o.subject_game_id = ${subjectGameId}
    order by o.event_id, c.slug, cv.version_no, o.role, o.id
  `;

  const byEvent = new Map<string, ReviewConcept[]>();
  for (const row of labels) {
    const list = byEvent.get(String(row.event_id)) ?? [];
    list.push({
      slug: row.slug,
      displayName: row.display_name,
      definition: row.human_definition,
      conceptVersionId: row.concept_version_id,
      versionNo: row.version_no,
      role: row.role,
      color: row.color ?? "",
      detectorVersion: row.detector_version ?? "",
      observed: row.response_observed,
      // Censored rows keep a null success and say why. A client that renders
      // null as a failure would undo §17.5, so both fields always travel.
      success: row.response_observed ? row.success : null,
      score: row.response_observed && row.score !== null ? Number(row.score) : null,
      censoredReason: row.censored_reason,
      opportunityPly: row.opportunity_ply,
      responsePly: row.response_ply,
      difficulty: safeDifficulty(row.difficulty),
      confidence: row.confidence == null ? null : Number(row.confidence),
      evidenceSourceKind: row.evidence_source_kind,
      evidenceItemId: row.evidence_item_id === null ? null : String(row.evidence_item_id),
    });
    byEvent.set(String(row.event_id), list);
  }

  return events.map((event) => ({
    eventType: event.event_type,
    startPly: event.start_ply,
    focalPly: event.focal_ply,
    endPly: event.end_ply,
    actorColor: event.actor_color,
    affectedColor: event.affected_color,
    completeness: event.completeness,
    confidence: event.detection_confidence == null ? null : Number(event.detection_confidence),
    facts: safeFacts(event.facts),
    concepts: byEvent.get(String(event.id)) ?? [],
  }));
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
