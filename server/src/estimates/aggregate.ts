import type { Sql } from "postgres";

import type { Queryable } from "../db/queryable.js";
import { ESTIMATOR_POLICY, type Frame } from "./contract.js";
import { compare, estimate, type Estimate, type Observation } from "./estimator.js";
import {
  controlFalseDiscovery,
  deriveCandidates,
  selectPublished,
  type DimensionInput,
} from "./findings.js";
import { alignTrajectory, type TrajectoryGame } from "./trajectory.js";
import {
  ensureDimension,
  writeEstimate,
  writeFinding,
  writeTrajectory,
  type RegisteredEstimateVersions,
} from "./store.js";

/**
 * Build one subject report from one frozen snapshot.
 *
 * Frozen is the operative word. Everything here reads the snapshot's game list
 * rather than the subject's current games, so two runs over the same snapshot
 * produce the same report and a report can be reproduced months later from the
 * row that says which games it saw.
 */

export interface AggregateInput {
  analysisRunId: string;
  subjectId: string;
  subjectDataSnapshotId: string;
  versions: RegisteredEstimateVersions;
  /** The E12 versions the trajectory is attributed to. */
  phaseComponentVersionId: string;
  expectedScoreCalibrationVersionId: string;
  /** True when the subject's rating sits outside the calibrated band. */
  outsideCalibratedRange?: boolean;
  cutoff: Date;
}

export interface AggregateSummary {
  estimates: number;
  unavailableEstimates: number;
  trajectoryBins: number;
  findingsPublished: number;
  findingsWithheld: number;
  explanationsHeld: number;
  includedGames: number;
}

interface OpportunityRow {
  concept_version_id: string;
  concept_slug: string;
  role: string;
  speed: string | null;
  success: boolean | null;
  score: string | null;
  censored_reason: string | null;
  occurred_at: Date;
  evidence_item_id: string | null;
}

/**
 * Read every scored opportunity the snapshot covers.
 *
 * The join goes through `subject_data_snapshot_games` rather than through the
 * subject, which is what makes the report frozen: a game synced after the
 * snapshot was taken is not in it, and a report recomputed tomorrow sees the
 * same evidence as the one computed today.
 */
async function readOpportunities(
  sql: Queryable,
  snapshotId: string,
): Promise<OpportunityRow[]> {
  return sql<OpportunityRow[]>`
    select o.concept_version_id, c.slug as concept_slug, o.role, o.speed,
           o.success, o.score, o.censored_reason, o.occurred_at,
           (select e.id from analysis.evidence_items e
             where e.subject_game_id = o.subject_game_id
               and e.evidence_kind = 'opportunity'
             order by e.id limit 1) as evidence_item_id
    from analysis.concept_opportunities o
    join analysis.subject_data_snapshot_games g
      on g.subject_game_id = o.subject_game_id and g.snapshot_id = ${snapshotId}
    join analysis.concept_versions cv on cv.id = o.concept_version_id
    join analysis.concepts c on c.id = cv.concept_id
    order by o.occurred_at
  `;
}

/** Read the transition series the trajectory is aligned from. */
async function readTrajectoryGames(
  sql: Queryable,
  snapshotId: string,
): Promise<TrajectoryGame[]> {
  const rows = await sql<
    {
      subject_game_id: string;
      from_ply: number;
      phase: string | null;
      expected_score_after: string;
    }[]
  >`
    select g.subject_game_id, ta.from_ply, ta.phase, ta.expected_score_after
    from analysis.subject_data_snapshot_games g
    join analysis.subject_game_publications pub on pub.subject_game_id = g.subject_game_id
    join analysis.transition_assessments ta on ta.analysis_run_id = pub.run_id
    where g.snapshot_id = ${snapshotId} and ta.phase is not null
    order by g.subject_game_id, ta.from_ply
  `;

  const byGame = new Map<string, TrajectoryGame>();
  for (const row of rows) {
    const game = byGame.get(row.subject_game_id) ?? {
      gameKey: row.subject_game_id,
      points: [] as TrajectoryGame["points"],
    };
    (game.points as { ply: number; phase: "opening" | "middlegame" | "endgame"; expectedScore: number }[]).push({
      ply: row.from_ply,
      phase: row.phase as "opening" | "middlegame" | "endgame",
      expectedScore: Number(row.expected_score_after),
    });
    byGame.set(row.subject_game_id, game);
  }
  return [...byGame.values()];
}

/**
 * The frames v1 measures.
 *
 * `objective` and `personal_current` only. `peer_current` and `peer_stretch`
 * need the rating-pool calibration a cohort model supplies, and publishing them
 * from the same evidence under a different label would be the same number
 * wearing three hats — which is exactly what platform spec 3.2's separation
 * exists to prevent.
 */
const MEASURED_FRAMES: readonly Frame[] = ["objective", "personal_current"];

export async function aggregateSubjectReport(
  sql: Sql,
  input: AggregateInput,
): Promise<AggregateSummary> {
  const summary: AggregateSummary = {
    estimates: 0,
    unavailableEstimates: 0,
    trajectoryBins: 0,
    findingsPublished: 0,
    findingsWithheld: 0,
    explanationsHeld: 0,
    includedGames: 0,
  };

  const opportunities = await readOpportunities(sql, input.subjectDataSnapshotId);
  const games = await readTrajectoryGames(sql, input.subjectDataSnapshotId);
  summary.includedGames = games.length;

  // Group by the slice a dimension describes: concept and role. Speed is left
  // out of v1's dimension key on purpose — splitting a thin corpus by speed as
  // well produces four dimensions that each say "insufficient evidence".
  const byDimension = new Map<string, OpportunityRow[]>();
  for (const row of opportunities) {
    const key = `${row.concept_slug}_${row.role}`;
    byDimension.set(key, [...(byDimension.get(key) ?? []), row]);
  }

  const dimensionInputs: DimensionInput[] = [];
  const estimateIds = new Map<string, string>();
  const evidenceByDimension = new Map<string, string[]>();

  for (const frame of MEASURED_FRAMES) {
    for (const [dimensionKey, rows] of byDimension) {
      const observations: Observation[] = rows.map((row) => ({
        occurredAt: row.occurred_at,
        score: row.score !== null ? Number(row.score) : row.success ? 1 : 0,
        censored: row.censored_reason !== null,
        graded: row.score !== null,
      }));

      // `personal_current` compares the player to their own earlier evidence, so
      // it is measured on the recent window; `objective` is measured over
      // everything the snapshot holds.
      const windowKind = frame === "personal_current" ? "recent_form" : "lifetime";
      const scoped =
        frame === "personal_current" ? recentHalf(observations) : observations;

      const result = estimate(scoped, input.cutoff, {
        outsideCalibratedRange:
          frame !== "objective" && input.outsideCalibratedRange === true,
      });

      const dimensionId = await ensureDimension(sql, {
        dimensionKey: `${dimensionKey}_${frame}`,
        version: ESTIMATOR_POLICY.version,
        conceptVersionId: rows[0]!.concept_version_id,
        role: rows[0]!.role,
        speed: null,
        phase: null,
        frame,
        displayName: `${rows[0]!.concept_slug} (${rows[0]!.role})`,
      });

      // The comparison is persisted before the estimate that cites it. A delta
      // with nothing to be a delta from is refused by the schema, and rightly:
      // "you improved by 0.12" is unreadable without the row saying from what.
      let comparison = null;
      let comparisonEstimateId: string | null = null;
      if (frame === "personal_current" && result.status === "available") {
        const earlier = estimate(earlierHalf(observations), input.cutoff);
        if (earlier.status === "available") {
          comparison = compare(earlier, result as Estimate);
          comparisonEstimateId = await writeEstimate(
            sql,
            {
              analysisRunId: input.analysisRunId,
              subjectId: input.subjectId,
              subjectDataSnapshotId: input.subjectDataSnapshotId,
              estimatorComponentVersionId: input.versions.estimatorVersionId,
            },
            {
              skillDimensionId: dimensionId,
              windowKind: "baseline",
              result: earlier,
              comparisonEstimateId: null,
              delta: null,
              improvementProbability: null,
            },
          );
          summary.estimates += 1;
        }
      }

      const estimateId = await writeEstimate(
        sql,
        {
          analysisRunId: input.analysisRunId,
          subjectId: input.subjectId,
          subjectDataSnapshotId: input.subjectDataSnapshotId,
          estimatorComponentVersionId: input.versions.estimatorVersionId,
        },
        {
          skillDimensionId: dimensionId,
          windowKind,
          result,
          comparisonEstimateId,
          delta: comparison?.delta ?? null,
          improvementProbability: comparison?.improvementProbability ?? null,
        },
      );
      estimateIds.set(`${dimensionKey}_${frame}`, estimateId);
      evidenceByDimension.set(
        `${dimensionKey}_${frame}`,
        rows.map((row) => row.evidence_item_id).filter((id): id is string => id !== null),
      );

      summary.estimates += 1;
      if (result.status === "unavailable") summary.unavailableEstimates += 1;

      dimensionInputs.push({
        dimensionKey: `${dimensionKey}_${frame}`,
        frame,
        conceptSlug: rows[0]!.concept_slug,
        role: rows[0]!.role,
        claimFamily: frame === "objective" ? "objective_quality" : "personal_change",
        result,
        comparison,
        failureCount: rows.filter((row) => row.censored_reason === null && row.success === false)
          .length,
      });
    }
  }

  if (games.length > 0) {
    const bins = alignTrajectory(games, { seed: seedFrom(input.subjectDataSnapshotId) });
    await writeTrajectory(
      sql,
      {
        analysisRunId: input.analysisRunId,
        subjectId: input.subjectId,
        subjectDataSnapshotId: input.subjectDataSnapshotId,
        phaseComponentVersionId: input.phaseComponentVersionId,
        alignmentComponentVersionId: input.versions.alignmentVersionId,
        expectedScoreCalibrationVersionId: input.expectedScoreCalibrationVersionId,
        includedGameCount: games.length,
        speed: null,
        color: null,
      },
      bins,
    );
    summary.trajectoryBins = bins.length;
  }

  const candidates = controlFalseDiscovery(
    dimensionInputs.flatMap((dimension) => deriveCandidates(dimension)),
  );
  const { published, withheld } = selectPublished(candidates);
  summary.findingsWithheld = withheld.length;

  for (const candidate of published) {
    const evidence = (evidenceByDimension.get(candidate.dimensionKey) ?? [])
      .slice(0, 5)
      .map((evidenceItemId) => ({ evidenceItemId, role: "supports", weight: null }));
    // A factual finding with no evidence rows would be refused at commit by
    // 0028's deferred trigger. Skipping it here names the reason instead of
    // failing the whole publication for one unlinkable claim.
    if (evidence.length === 0 && candidate.findingType !== "insufficient_evidence") {
      summary.findingsWithheld += 1;
      continue;
    }
    const written = await writeFinding(
      sql,
      {
        analysisRunId: input.analysisRunId,
        subjectId: input.subjectId,
        correctionComponentVersionId: input.versions.correctionVersionId,
        rendererComponentVersionId: input.versions.rendererVersionId,
      },
      {
        candidate,
        playerSkillEstimateId: estimateIds.get(candidate.dimensionKey) ?? null,
        conceptVersionId: null,
        role: null,
        evidence,
      },
    );
    summary.findingsPublished += 1;
    if (written.safetyState !== "passed") summary.explanationsHeld += 1;
  }

  return summary;
}

/** The later half of the evidence, by date. Empty when there is too little. */
function recentHalf(observations: readonly Observation[]): Observation[] {
  const sorted = [...observations].sort(
    (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime(),
  );
  return sorted.slice(Math.floor(sorted.length / 2));
}

function earlierHalf(observations: readonly Observation[]): Observation[] {
  const sorted = [...observations].sort(
    (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime(),
  );
  return sorted.slice(0, Math.floor(sorted.length / 2));
}

/** A stable seed from the snapshot, so the bootstrap is reproducible per report. */
function seedFrom(snapshotId: string): number {
  let hash = 0;
  for (let i = 0; i < snapshotId.length; i += 1) {
    hash = (Math.imul(hash, 31) + snapshotId.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}
