/**
 * `analysis_detect_concepts` — turning an analysed game into skill evidence.
 *
 * The step E13 was missing. Everything around it existed: the tables, the
 * vocabulary and validators in `analysis/observations.ts`, and the whole
 * consumer chain from `estimates/aggregate.ts` through the baseline report. But
 * nothing ever wrote a `concept_opportunities` row outside a gate, so the
 * estimator grouped nothing into nothing and every report said the same thing:
 * we have your games and we have measured none of them.
 *
 * This runs once per game, after the transitions have been assessed, because it
 * reads those assessments. It writes three kinds of row in one transaction:
 *
 *   * a `chess_events` row per detected moment -- what happened, and where;
 *   * a `concept_opportunities` row per observation -- what it says about the
 *     player, or that it says nothing because they never got to answer;
 *   * an `evidence_items` row per opportunity, which is what makes a claim in a
 *     report traceable back to the game it came from.
 *
 * One transaction because a half-written game is worse than an unwritten one:
 * the estimator would read the opportunities that landed and call the result a
 * measurement.
 *
 * ## Every write is bound
 *
 * All three tables are actor-scoped. The owner is resolved from the workflow
 * before anything else runs -- the pattern the rest of this codebase learned
 * the hard way, where an unbound read returns zero rows rather than raising and
 * the failure presents as "you have no data".
 */

import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import { withActor } from "../../db/actor.js";
import { jsonParam } from "../../db/json.js";
import { requiredDate, type RawTimestamp } from "../../db/timestamps.js";
import { registerHandler, type WorkContext, type WorkResult } from "../../ops/handlers.js";
import { WorkFailure } from "../../ops/retry.js";
import { isRecordableOpportunity, difficultyIsUncontaminated } from "../observations.js";
import { conceptBySlug } from "./catalogue.js";
import { conceptVersionIds } from "./register.js";
import {
  detectGame,
  groupByEvent,
  withheldFrom,
  DETECTOR_VERSION,
  type CandidateLine,
  type DetectedOpportunity,
  type GameFacts,
  type PositionFact,
  type TransitionFact,
} from "./detect.js";
import { publishedMaterializationRun } from "../../engine/recipe.js";

export const DETECT_TASK = "analysis_detect_concepts";
export const CONCEPT_EVENT_FAMILY = "chess_events";
export const CONCEPT_OPPORTUNITY_FAMILY = "concept_opportunities";
export const CONCEPT_ARTIFACT_FAMILIES = [
  CONCEPT_EVENT_FAMILY,
  CONCEPT_OPPORTUNITY_FAMILY,
] as const;

/**
 * Whether the detector ran, and if not, why.
 *
 * The distinction FOR-132 turns on. A game the detector read and found nothing
 * in is *complete* -- it has been measured, and the answer is that nothing
 * happened worth recording. A game it could not read is *abstained*. Reporting
 * both as "no concepts" would let an unmeasured game masquerade as a clean one,
 * and a player would be shown an empty report either way with no means of
 * telling which they were looking at.
 */
export type DetectionState = "complete" | "abstained";

/**
 * A stable fingerprint of what the detector concluded about one game.
 *
 * Over the detected output rather than over the rows written, so it does not
 * move when the same conclusions are written a second time or when database
 * identities differ between environments. Two runs of the same detector version
 * over the same game produce the same string; a change in the string means a
 * change in what Forma believes about that game.
 *
 * Sorted before hashing because the checksum must not depend on detector
 * ordering -- that is a separate contract, tested separately, and folding it in
 * here would make an ordering change look like an evidence change.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function eventChecksum(detected: readonly DetectedOpportunity[]): string {
  const events = new Map<string, DetectedOpportunity["event"]>();
  for (const found of detected) events.set(found.event.detectionKey, found.event);
  return sha256([...events.values()].sort((left, right) =>
    left.detectionKey.localeCompare(right.detectionKey)));
}

export function detectionChecksum(detected: readonly DetectedOpportunity[]): string {
  return sha256(detected
    .map((found) => ({
      conceptSlug: found.conceptSlug,
      phase: found.phase,
      eventKey: found.event.detectionKey,
      draft: found.draft,
    }))
    .sort((left, right) => JSON.stringify(canonical(left)).localeCompare(JSON.stringify(canonical(right)))));
}

async function recordDetectionArtifacts(
  tx: Sql,
  runId: string,
  detected: readonly DetectedOpportunity[],
): Promise<void> {
  const groups = groupByEvent(detected);
  const entries = [
    { family: CONCEPT_EVENT_FAMILY, count: groups.length, checksum: eventChecksum(detected) },
    {
      family: CONCEPT_OPPORTUNITY_FAMILY,
      count: detected.length,
      checksum: detectionChecksum(detected),
    },
  ] as const;

  for (const entry of entries) {
    const [existing] = await tx<{ checksum: string; row_count: number }[]>`
      select checksum, row_count from analysis.run_artifacts
      where run_id = ${runId} and family = ${entry.family}
    `;
    if (existing) {
      if (existing.checksum !== entry.checksum || existing.row_count !== entry.count) {
        // The transaction is rolled back, including any evidence written before
        // this check. A run whose immutable manifest disagrees needs a new run;
        // committing the new rows would make an old publication change in place.
        throw new WorkFailure(
          "permanent",
          "concept_manifest_drift",
          `the existing ${entry.family} manifest disagrees with this detector conclusion`,
        );
      }
      continue;
    }
    await tx`
      insert into analysis.run_artifacts (run_id, family, row_count, checksum)
      values (${runId}, ${entry.family}, ${entry.count}, ${entry.checksum})
    `;
  }
}

interface Payload {
  readonly runId?: unknown;
}

interface RunRow {
  subject_game_id: string | null;
  subject_id: string | null;
  replay_revision_id: string | null;
}

interface CandidateRow {
  readonly from_ply: number;
  readonly rank: number;
  readonly uci: string;
  readonly expected_score: string;
  readonly pv: unknown;
}

/**
 * Detect and record, for one run whose owner is already known.
 *
 * Separated from the handler so that an operator can run the detector over
 * games that were analysed before it existed, without redoing the engine work
 * those runs already paid for. The handler resolves the owner from the workflow
 * and calls this; a backfill resolves it from the subject and calls the same
 * thing. There is deliberately no second implementation.
 */
export async function detectForRun(
  sql: Sql,
  runId: string,
  ownerProfileId: string,
): Promise<WorkResult> {
  return withActor(sql, ownerProfileId, async (tx) => {
    const [run] = await tx<RunRow[]>`
      select subject_game_id, subject_id, replay_revision_id
      from analysis.runs where id = ${runId}
    `;
    if (!run?.subject_game_id || !run.subject_id || !run.replay_revision_id) {
      throw new WorkFailure("invalid_input", "unknown_run", "no such analysis run");
    }

    // The position graph hangs off the materialization, not off the analysis
    // run: a run names the replay revision it analysed, and the materializer
    // publishes exactly one chain per revision.
    const materializationRunId = await publishedMaterializationRun(tx, run.replay_revision_id);
    if (materializationRunId === null) {
      throw new WorkFailure(
        "invalid_input",
        "no_published_materialization",
        "the run's replay revision has no published position graph",
      );
    }

    // Detection is idempotent at observation granularity, but deciding what is
    // missing and writing it spans several statements. Serialize attempts for
    // one immutable position graph so a worker retry and a backfill cannot both
    // pass the reads and then race into the event/opportunity unique indexes.
    // The lock is transaction-scoped and releases on both commit and rollback.
    await tx`
      select pg_advisory_xact_lock(hashtextextended(${materializationRunId}, 0))
    `;

    const [game] = await tx<{
      subject_color: string;
      replay_revision_id: string;
      speed: string | null;
      termination: string | null;
      result: string;
      played_at: RawTimestamp;
    }[]>`
      select g.subject_color, r.id as replay_revision_id, r.speed, r.termination, r.result, r.played_at
      from chess.subject_games g
      -- Metadata and positions must describe the same immutable replay. The
      -- subject game's latest pointer can advance after this analysis run was
      -- created, so joining through it would mix a corrected replay's result
      -- and termination with the run-pinned transition evidence.
      join chess.game_replay_revisions r
        on r.id = ${run.replay_revision_id}
       and r.provider_game_id = g.provider_game_id
      where g.id = ${run.subject_game_id}
    `;
    if (!game) throw new WorkFailure("invalid_input", "unknown_game", "no such subject game");
    if (game.subject_color !== "white" && game.subject_color !== "black") {
      throw new WorkFailure("invalid_input", "unknown_color", "the subject played neither colour");
    }

    const positions = await tx<{ ply: number; fen: string }[]>`
      select ply, fen from chess.position_occurrences
      where run_id = ${materializationRunId}
      order by ply
    `;
    const transitions = await tx<{
      from_ply: number;
      actor_color: string;
      played_move_uci: string;
      best_move_uci: string | null;
      played_move_rank: number | null;
      played_move_acceptable: boolean;
      only_move: boolean | null;
      criticality: string | null;
      acceptable_move_count: number | null;
      retained_lines: string | null;
      expected_score_before: string;
      expected_score_after: string;
      phase: string | null;
    }[]>`
      select from_ply, actor_color, played_move_uci, best_move_uci, played_move_rank,
             played_move_acceptable, only_move, criticality, acceptable_move_count,
             -- How many lines the search that answered the candidate questions
             -- retained. only_move is derived from that set, so without this
             -- the detector cannot tell "the only move we looked at" from "the
             -- only move there is" -- and v1 asserted the second.
             difficulty_features->>'retainedLines' as retained_lines,
             expected_score_before, expected_score_after, phase
      from analysis.transition_assessments
      where analysis_run_id = ${runId}
        and materialization_run_id = ${materializationRunId}
      order by from_ply
    `;
    if (transitions.length === 0) {
      await recordDetectionArtifacts(tx as unknown as Sql, runId, []);
      // Nothing to read is not nothing to say, but it is nothing to measure.
      return {
        outputRef: `run:${runId}`,
        outputSummary: {
          // Read, and there was nothing in it. Complete, not unavailable.
          detection: "complete" satisfies DetectionState,
          opportunities: 0,
          events: 0,
          labels: 0,
          succeeded: 0,
          failed: 0,
          censored: 0,
          abstentions: { unregisteredConcept: 0, unrecordableDraft: 0 },
          concepts: {},
          roles: {},
          completeness: {},
          reason: "no_assessed_transitions",
          checksum: detectionChecksum([]),
        },
      };
    }
    const transitionsAreUsable = transitions.every((row) =>
      Number.isInteger(row.from_ply)
      && (row.actor_color === "white" || row.actor_color === "black")
      && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(row.played_move_uci)
      && Number.isFinite(Number(row.expected_score_before))
      && Number.isFinite(Number(row.expected_score_after))
      && (row.criticality === null || Number.isFinite(Number(row.criticality)))
      && (row.retained_lines === null || Number.isInteger(Number(row.retained_lines))));
    if (!transitionsAreUsable) {
      // Dropping a malformed transition would make a partial game look whole,
      // and coercing an unknown colour to Black would make the stronger claim.
      return {
        outputRef: `run:${runId}`,
        outputSummary: {
          // Could not be read. Distinct from having been read and found empty.
          detection: "abstained" satisfies DetectionState,
          opportunities: 0,
          reason: "malformed_transition_evidence",
        },
      };
    }

    // Tactical verification may use only the deep evaluation that this exact
    // transition assessment pinned. Joining through the assessment prevents a
    // cached evaluation from another run or replay revision being substituted
    // merely because it describes similar board geometry.
    const candidateRows = await tx<CandidateRow[]>`
      select t.from_ply, c.rank, c.uci, c.expected_score, c.pv
      from analysis.transition_assessments t
      join analysis.evaluation_candidates c
        on c.position_evaluation_id = t.deep_evaluation_id
      where t.analysis_run_id = ${runId}
        and t.materialization_run_id = ${materializationRunId}
      order by t.from_ply, c.rank
    `;
    const mutableCandidates = new Map<number, CandidateLine[]>();
    const malformedCandidatePlies = new Set<number>();
    const candidateRanks = new Map<number, Set<number>>();
    const candidateMoves = new Map<number, Set<string>>();
    for (const row of candidateRows) {
      const expectedScore = Number(row.expected_score);
      const pvIsValid = Array.isArray(row.pv)
        && row.pv.every((move): move is string => typeof move === "string");
      const valid = Number.isInteger(row.from_ply)
        && Number.isInteger(row.rank)
        && row.rank >= 1
        && row.rank <= 32
        && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(row.uci)
        && Number.isFinite(expectedScore)
        && expectedScore >= 0
        && expectedScore <= 1
        && pvIsValid
        && (row.pv.length === 0 || row.pv[0] === row.uci);
      if (!valid) {
        malformedCandidatePlies.add(row.from_ply);
        continue;
      }
      const ranks = candidateRanks.get(row.from_ply) ?? new Set<number>();
      const moves = candidateMoves.get(row.from_ply) ?? new Set<string>();
      if (ranks.has(row.rank) || moves.has(row.uci)) {
        malformedCandidatePlies.add(row.from_ply);
        continue;
      }
      ranks.add(row.rank);
      moves.add(row.uci);
      candidateRanks.set(row.from_ply, ranks);
      candidateMoves.set(row.from_ply, moves);
      mutableCandidates.set(row.from_ply, [
        ...(mutableCandidates.get(row.from_ply) ?? []),
        { rank: row.rank, uci: row.uci, expectedScore, pv: row.pv },
      ]);
    }
    // Silently dropping one bad line would turn a partial searched set into a
    // complete-looking one. The whole ply is unavailable instead.
    for (const ply of malformedCandidatePlies) mutableCandidates.delete(ply);
    const candidatesByPly: ReadonlyMap<number, readonly CandidateLine[]> = mutableCandidates;

    const versions = await conceptVersionIds(tx);
    if (versions.size === 0) {
      throw new WorkFailure(
        "unsupported",
        "no_registered_concepts",
        "the concept catalogue has not been registered in this environment",
      );
    }

    const facts: GameFacts = {
      subjectColor: game.subject_color,
      speed: game.speed,
      playedAt: requiredDate(game.played_at, "game_replay_revisions.played_at"),
      termination: game.termination,
      result:
        game.result === "white" || game.result === "black" || game.result === "draw"
          ? game.result
          : null,
      candidatesByPly,
      unavailableCandidatePlies: malformedCandidatePlies,
      positions: positions.map((row): PositionFact => ({ ply: row.ply, fen: row.fen })),
      transitions: transitions.map((row): TransitionFact => ({
        fromPly: row.from_ply,
        actorColor: row.actor_color as "white" | "black",
        playedMoveUci: row.played_move_uci,
        bestMoveUci: row.best_move_uci,
        playedMoveRank: row.played_move_rank,
        playedMoveAcceptable: row.played_move_acceptable,
        onlyMove: row.only_move,
        criticality: row.criticality === null ? null : Number(row.criticality),
        acceptableMoveCount: row.acceptable_move_count,
        candidateCount: row.retained_lines === null ? null : Number(row.retained_lines),
        expectedScoreBefore: Number(row.expected_score_before),
        expectedScoreAfter: Number(row.expected_score_after),
        phase: row.phase,
      })),
    };

    // Evidence is append-only, and the grants say so: `forma_analysis` may
    // insert and select these tables and may not delete from them. That is the
    // right shape -- a worker that can delete a player's evidence can quietly
    // rewrite what a report was based on -- so a re-delivery is answered by
    // declining to write a second copy rather than by clearing the first.
    //
    // Redetecting the same game under a changed catalogue is a different
    // matter, and it is a new analysis run, not an overwrite of this one.
    // `run_id` on all three evidence tables references
    // `chess.materialization_runs`, not `analysis.runs`. The evidence is about
    // a position graph rather than about one pass of the engine over it, which
    // is why the estimator joins these rows by game and snapshot and never by
    // run at all.
    // What this run has already produced, at the granularity that actually
    // repeats.
    //
    // This used to be one question -- "does this materialization run have any
    // opportunity at all?" -- and an early return if it did. Correct for a
    // re-delivered message and wrong for everything else: adding a seventh
    // concept could never reach a game that already had rows from the first
    // six, and correcting a detector could never reach anything. The only way
    // to pick up a new version was to delete evidence, which `forma_analysis`
    // is rightly not granted. So identity moves down to the physical occurrence
    // and the observation, and a second run inserts what is missing.
    const knownEvents = new Map<string, number>();
    for (const row of await tx<{ id: string; detection_key: string }[]>`
      select id, detection_key from analysis.chess_events
      where run_id = ${materializationRunId} and detection_key is not null
    `) {
      knownEvents.set(row.detection_key, Number(row.id));
    }

    const knownOpportunities = new Map<string, string>();
    for (const row of await tx<{
      id: string;
      detection_key: string;
      concept_version_id: string;
      role: string;
    }[]>`
      select o.id, e.detection_key, o.concept_version_id, o.role
      from analysis.concept_opportunities o
      join analysis.chess_events e on e.id = o.event_id
      where o.run_id = ${materializationRunId} and e.detection_key is not null
    `) {
      knownOpportunities.set(
        `${row.detection_key}|${row.concept_version_id}|${row.role}`,
        String(row.id),
      );
    }

    // One physical occurrence per group, however many things are measured about
    // it. The grouping is pure and lives in `detect.ts`; this loop only writes.
    const groups = groupByEvent(detectGame(facts, { withheld: withheldFrom(process.env) }));

    const opponentColor = game.subject_color === "white" ? "black" : "white";
    /** `subject`/`opponent` are relative so the detector stays colour-agnostic. */
    const resolveColor = (side: "subject" | "opponent" | null): string | null =>
      side === null ? null : side === "subject" ? game.subject_color : opponentColor;

    const detected = groups.flatMap((group) => group.observations);

    let succeeded = 0;
    let failed = 0;
    let censored = 0;
    const byConcept = new Map<string, number>();
    const byRole = new Map<string, number>();
    const byCompleteness = new Map<string, number>();
    // Abstentions are counted by reason rather than lumped into one "skipped".
    // "The catalogue in this database is behind the build" and "the detector
    // proposed a row that would have been a lie" are different operator
    // problems, and one number for both hides whichever is happening.
    const abstentions = { unregisteredConcept: 0, unrecordableDraft: 0 };

    // Refuse the whole conclusion before writing any of it. A detector bug or
    // a database whose catalogue is behind this build is not a "complete"
    // result with a few rows missing, and partial output may not publish.
    for (const observation of detected) {
      if (!versions.has(observation.conceptSlug) || !conceptBySlug(observation.conceptSlug)) {
        abstentions.unregisteredConcept += 1;
      } else if (!isRecordableOpportunity(observation.draft)
        || !difficultyIsUncontaminated(observation.draft.difficulty)) {
        abstentions.unrecordableDraft += 1;
      }
      byConcept.set(observation.conceptSlug, (byConcept.get(observation.conceptSlug) ?? 0) + 1);
      byRole.set(observation.draft.role, (byRole.get(observation.draft.role) ?? 0) + 1);
      byCompleteness.set(
        observation.event.completeness,
        (byCompleteness.get(observation.event.completeness) ?? 0) + 1,
      );
      if (!observation.draft.responseObserved) censored += 1;
      else if (observation.draft.success === true) succeeded += 1;
      else failed += 1;
    }
    if (abstentions.unregisteredConcept > 0 || abstentions.unrecordableDraft > 0) {
      throw new WorkFailure(
        abstentions.unregisteredConcept > 0 ? "unsupported" : "permanent",
        abstentions.unregisteredConcept > 0
          ? "unregistered_concept_output"
          : "unrecordable_concept_output",
        `concept output refused (${abstentions.unregisteredConcept} unregistered, ${abstentions.unrecordableDraft} unrecordable)`,
      );
    }

    for (const group of groups) {
      const { detectionKey } = group.event;

      // Decide what is writable before writing anything. An event with no
      // labels left to attach is an event nobody asked for -- inserting it and
      // then finding every observation was already present would leave a
      // physical occurrence with nothing hanging off it.
      const writable: {
        observation: (typeof group.observations)[number];
        conceptVersionId: string;
        evidenceSourceKind: string;
      }[] = [];

      for (const observation of group.observations) {
        const conceptVersionId = versions.get(observation.conceptSlug);
        const definition = conceptBySlug(observation.conceptSlug);
        if (!conceptVersionId || !definition) {
          // The catalogue in the database is behind this build. Skipping is the
          // conservative answer: an unregistered concept has no definition a
          // player could be shown, so evidence against it could not be explained.
          continue;
        }
        // The validators exist so a detector cannot write a row that lies. They
        // are checked here, on the way in, rather than trusted.
        if (!isRecordableOpportunity(observation.draft)
          || !difficultyIsUncontaminated(observation.draft.difficulty)) {
          continue;
        }
        const identity = `${detectionKey}|${conceptVersionId}|${observation.draft.role}`;
        const knownOpportunityId = knownOpportunities.get(identity);
        if (knownOpportunityId !== undefined) {
          // This exact observation is already recorded under this exact concept
          // version. Not an error and not a duplicate to write: a re-run that
          // finds its own previous output is the normal case.
          const knownEventId = knownEvents.get(detectionKey);
          if (knownEventId === undefined) {
            throw new WorkFailure(
              "permanent",
              "opportunity_without_event",
              "an existing concept opportunity has no matching detected event",
            );
          }
          await tx`
            insert into analysis.event_concepts (
              event_id, concept_version_id, color, role, label_confidence, detector_version
            ) values (
              ${knownEventId}, ${conceptVersionId}, ${game.subject_color},
              ${observation.draft.role}, null, ${DETECTOR_VERSION}
            )
            on conflict (event_id, concept_version_id, color, role) do nothing
          `;
          await tx`
            insert into analysis.run_concept_opportunities (analysis_run_id, opportunity_id)
            values (${runId}, ${knownOpportunityId})
            on conflict do nothing
          `;
          continue;
        }
        writable.push({
          observation,
          conceptVersionId,
          evidenceSourceKind: definition.evidenceSourceKind,
        });
      }

      if (writable.length === 0) continue;

      let eventId = knownEvents.get(detectionKey);
      if (eventId === undefined) {
        const [event] = await tx<{ id: string }[]>`
          insert into analysis.chess_events (
            run_id, replay_revision_id, subject_game_id, event_type, start_ply, focal_ply,
            end_ply, actor_color, affected_color, facts, detection_confidence, completeness,
            detection_key
          ) values (
            ${materializationRunId}, ${game.replay_revision_id}, ${run.subject_game_id},
            ${group.event.eventType}, ${group.event.startPly},
            ${group.event.focalPly}, ${group.event.endPly},
            ${resolveColor(group.event.actor)}, ${resolveColor(group.event.affected)},
            ${jsonParam(group.event.facts)}::jsonb, ${group.event.confidence},
            ${group.event.completeness},
            ${detectionKey}
          )
          returning id
        `;
        if (!event) throw new Error("the event vanished on insert");
        eventId = Number(event.id);
        knownEvents.set(detectionKey, eventId);
      }

      for (const { observation, conceptVersionId, evidenceSourceKind } of writable) {
        // The semantic label. §17.4's many-to-many: this is what lets one
        // moment carry `recognize` and `execute` as separate observations
        // without being stored as two separate moments.
        //
        // `color` is the side whose behaviour the role describes, which for
        // every concept in this catalogue is the subject -- `respond` measures
        // the subject answering an opponent's threat, and it is the answer
        // being labelled, not the threat. The threat's owner is on the event,
        // in `actor_color`.
        await tx`
          insert into analysis.event_concepts (
            event_id, concept_version_id, color, role, label_confidence, detector_version
          ) values (
            ${eventId}, ${conceptVersionId}, ${game.subject_color}, ${observation.draft.role},
            null, ${DETECTOR_VERSION}
          )
          on conflict (event_id, concept_version_id, color, role) do nothing
        `;
        const [evidence] = await tx<{ id: string }[]>`
          insert into analysis.evidence_items (
            run_id, evidence_kind, subject_id, subject_game_id, occurred_at, confidence
          ) values (
            ${materializationRunId}, 'opportunity', ${run.subject_id}, ${run.subject_game_id},
            ${facts.playedAt.toISOString()}, null
          )
          returning id
        `;
        if (!evidence) throw new Error("the evidence item vanished on insert");

        const [opportunity] = await tx<{ id: string }[]>`
          insert into analysis.concept_opportunities (
            run_id, subject_id, subject_game_id, event_id, concept_version_id, role,
            opportunity_ply, response_ply, response_observed, censored_reason, success,
            score, rubric_component_version_id, difficulty, phase, speed, context,
            confidence, evidence_source_kind, occurred_at, evidence_item_id
          ) values (
            ${materializationRunId}, ${run.subject_id}, ${run.subject_game_id}, ${eventId},
            ${conceptVersionId}, ${observation.draft.role}, ${observation.draft.opportunityPly},
            ${observation.draft.responsePly}, ${observation.draft.responseObserved},
            ${observation.draft.censoredReason}, ${observation.draft.success},
            ${observation.draft.score}, ${observation.draft.rubricComponentVersionId},
            ${jsonParam(observation.draft.difficulty)}::jsonb, ${observation.phase},
            ${game.speed}, ${jsonParam({ evidenceItemId: evidence.id })}::jsonb, null,
            ${evidenceSourceKind}, ${facts.playedAt.toISOString()}, ${Number(evidence.id)}
          ) returning id
        `;
        if (!opportunity) throw new Error("the concept opportunity vanished on insert");

        await tx`
          insert into analysis.run_concept_opportunities (analysis_run_id, opportunity_id)
          values (${runId}, ${opportunity.id})
        `;

        knownOpportunities.set(
          `${detectionKey}|${conceptVersionId}|${observation.draft.role}`,
          String(opportunity.id),
        );
      }
    }

    // The manifest is what tells a later reader that detection happened at all.
    // `analysis.run_artifacts` says so in its own table comment: a family whose
    // count is zero is a complete answer about a quiet game, and an absent row
    // is what makes "nothing found" indistinguishable from "never ran". The
    // review API reads exactly this to decide whether to say `published` or
    // `unavailable`.
    //
    // Counts and checksums are over the detected conclusions rather than the
    // rows written on this pass, so a retry that writes nothing new still
    // agrees with the manifest it wrote the first time.
    await recordDetectionArtifacts(tx as unknown as Sql, runId, detected);

    return {
      outputRef: `run:${runId}`,
      outputSummary: {
        detection: "complete" satisfies DetectionState,
        opportunities: detected.length,
        events: groups.length,
        labels: detected.length,
        // Outcomes, kept apart. `censored` is not a failure and adding it to
        // one is the arithmetic §17.5 exists to forbid.
        succeeded,
        failed,
        censored,
        abstentions,
        concepts: Object.fromEntries(byConcept),
        roles: Object.fromEntries(byRole),
        completeness: Object.fromEntries(byCompleteness),
        // Counts and a fingerprint. Nothing here carries a square, a move, a
        // FEN or a subject identity: a summary is written to logs and to a
        // publication manifest, and a player's board does not belong in either.
        checksum: detectionChecksum(detected),
      },
      metrics: { inputCount: transitions.length, outputCount: detected.length },
    };
  });
}

/**
 * Deferred, for the reason `models/worker.ts` documents: `db/client.js` refuses
 * to load without a database identity, so an offline gate that only wants the
 * handler function must not pull it in at import time.
 */
async function runtimeSql(): Promise<Sql> {
  const { client } = await import("../../db/client.js");
  return client as unknown as Sql;
}

export async function detectConcepts(context: WorkContext, sql: Sql): Promise<WorkResult> {
  const payload = context.item.payload as Payload;
  const runId = typeof payload.runId === "string" ? payload.runId : null;
  if (runId === null) {
    throw new WorkFailure("invalid_input", "invalid_payload", "the payload names no run");
  }

  // The owner comes from the workflow the API created, never from the payload,
  // and it is resolved before anything reads a tenant table.
  const [workflow] = await sql<{ owner_profile_id: string | null }[]>`
    select owner_profile_id from ops.workflows where id = ${context.item.workflowId}
  `;
  if (!workflow?.owner_profile_id) {
    throw new WorkFailure("invalid_input", "unowned_workflow", "the workflow names no owner");
  }
  return detectForRun(sql, runId, workflow.owner_profile_id);
}

let registered = false;

export function registerConceptHandlers(): void {
  if (registered) return;
  registered = true;
  registerHandler(DETECT_TASK, async (context) => detectConcepts(context, await runtimeSql()));
}
