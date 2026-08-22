import { conceptBySlug, describeConceptRole } from "../analysis/concepts/catalogue.js";
import type { Queryable } from "../db/queryable.js";
import type { CoverageStatus, FindingType } from "./contract.js";

/**
 * The dashboard read model.
 *
 * One atomic live publication, read through the pointer E11 publishes rather
 * than by re-deriving anything: the page a user sees is the report that was
 * published, not a fresh computation that might disagree with the findings
 * stored beside it.
 *
 * Every section is named even when it is empty, and an absent section says
 * `unavailable` with a reason. A missing key is read as "nothing found"; a
 * present key saying "not analysed yet" cannot be.
 */

export type SectionState = "published" | "unavailable";

/** The order a game meets them, which is the order a reader expects. */
const PHASE_DISPLAY_ORDER: readonly string[] = ["opening", "middlegame", "endgame"];

/**
 * What to call a dimension on screen.
 *
 * Resolved from the catalogue at read time rather than read out of
 * `skill_dimensions.display_name`, for a reason that only shows up in a live
 * database: that table is immutable and keyed by dimension and estimator
 * version, so the rows written when the name was `material_safety (respond)`
 * keep that name for as long as the estimator version does. A screen fed from
 * the column would go on showing a database key to a customer no matter how
 * many times the catalogue was reworded.
 *
 * That is also what `conceptVersionHash` was designed for: the display name is
 * deliberately outside it so a rename does not orphan a season of evidence.
 * Resolving here is the other half of that decision.
 *
 * Falls back to the stored name, and then to a plain phrase, but never to
 * something with an underscore in it.
 */
function readableName(
  conceptSlug: string | null,
  role: string | null,
  stored: string,
): string {
  if (conceptSlug !== null && role !== null && conceptBySlug(conceptSlug) !== undefined) {
    return describeConceptRole(conceptSlug, role).label;
  }
  if (!/_/.test(stored)) return stored;
  return "a measurement this build cannot name";
}

export interface EstimateView {
  dimensionKey: string;
  displayName: string;
  frame: string;
  /** Set on the pooled per-phase estimates, null on the per-concept ones. */
  phase: string | null;
  windowKind: string;
  /** Null with a reason, never a placeholder number. */
  estimate: number | null;
  intervalLow: number | null;
  intervalHigh: number | null;
  rawSampleSize: number;
  effectiveSampleSize: number;
  coverage: { success: number; failure: number; graded: number; censored: number };
  coverageStatus: CoverageStatus;
  unavailableReason: string | null;
  delta: number | null;
  improvementProbability: number | null;
}

/**
 * One phase of the game, as a card.
 *
 * On the dashboard rather than on its own route, and for one reason: the
 * dashboard is a read of a published report, so everything on it was computed
 * from the same frozen snapshot in the same run. A separate endpoint computing
 * phase rates live would let the phase cards and the findings beside them
 * disagree about the same games, which is the failure the whole publication
 * pointer exists to prevent.
 *
 * `taken` over `observed` is a pooled hit rate across every concept that fires
 * in this phase, not a skill. The concepts are not the same mix in every phase,
 * so the three rates are descriptions of what happened rather than a ranking of
 * the player's phases — the `inconsistency` finding is the one thing allowed to
 * make that comparison, and it does it over concepts shared by both phases.
 */
export interface PhaseView {
  phase: string;
  /** Every chance recorded in this phase, censored ones included. */
  chances: number;
  /** Of those, the ones the player actually had a move at. */
  observed: number;
  /** Of `observed`, the ones that went well. */
  taken: number;
  /**
   * Chances that ended before the player was on move.
   *
   * Named `setAside` rather than folded into a failure count: a chance the
   * opponent's resignation removed is not a chance the player missed, and the
   * card has to be able to show that it was excluded.
   */
  setAside: number;
  /** Null with a reason rather than a placeholder, as everywhere else. */
  rate: number | null;
  intervalLow: number | null;
  intervalHigh: number | null;
  coverageStatus: CoverageStatus;
  unavailableReason: string | null;
  /**
   * Games in the cohort that reached this phase, from the trajectory.
   *
   * Null when there is no trajectory to read it from. An endgame rate over
   * eighty games and an opening rate over three hundred are not comparable at
   * a glance, and a card that shows only the rate is lying by omission.
   */
  gamesReaching: number | null;
  phaseReachRate: number | null;
}

export interface PhasesView {
  state: SectionState;
  /**
   * The games every number in this section is over.
   *
   * The report is built from a frozen cohort, which is smaller than the
   * account's synced history. Two screens that quote different denominators
   * without saying so read as two products.
   */
  gamesInCohort: number;
  phases: PhaseView[];
}

export interface FindingView {
  id: string;
  findingType: FindingType;
  priority: number;
  confidenceTier: string;
  claim: Record<string, unknown>;
  adjustedProbability: number | null;
  evidence: { evidenceItemId: string; role: string; displayRank: number }[];
  /** Null when the renderer's text did not pass its own check. */
  explanation: string | null;
  explanationState: string | null;
}

export interface TrajectoryView {
  state: SectionState;
  snapshotId: string | null;
  includedGameCount: number;
  bins: {
    phase: string;
    binOrdinal: number;
    progressLow: number;
    progressHigh: number;
    gamesContributing: number;
    medianExpectedScore: number;
    p25ExpectedScore: number;
    p75ExpectedScore: number;
    intervalLow: number | null;
    intervalHigh: number | null;
    phaseReachRate: number;
  }[];
  /** Phases with no bins at all, named so the client does not draw a flat line. */
  unreachedPhases: string[];
}

export interface RatingProfileView {
  state: SectionState;
  /**
   * One row per pool and speed. There is deliberately no combined figure: the
   * product does not present a single number for a person's chess ability, and
   * a client that wants one has to invent it rather than read it.
   */
  pools: {
    provider: string;
    pool: string;
    speed: string;
    observedRating: number | null;
    scaleEstimate: number | null;
    intervalLow: number | null;
    intervalHigh: number | null;
    inSupportedRange: boolean;
    suppressedReason: string | null;
  }[];
  note: string;
}

export interface Dashboard {
  subjectId: string;
  publicationId: string;
  runId: string;
  publishedAt: string;
  sections: {
    estimates: SectionState;
    findings: SectionState;
    phases: SectionState;
    trajectory: SectionState;
    ratingProfile: SectionState;
    /** E17 owns the goal. Named here so a client sees a state, not a gap. */
    goal: SectionState;
    connections: SectionState;
  };
  estimates: EstimateView[];
  findings: FindingView[];
  phases: PhasesView;
  trajectory: TrajectoryView;
  ratingProfile: RatingProfileView;
  coverageWarnings: string[];
  version: { recipeVersionId: string; snapshotId: string; estimatorVersions: string[] };
}

/**
 * Read one subject's published dashboard, or null.
 *
 * Null covers "no such subject", "not yours" and "nothing published yet" on
 * purpose: the API answers all three with a 404, and distinguishing them here
 * is how an identifier becomes probeable.
 */
export async function readDashboard(
  sql: Queryable,
  input: { subjectId: string; ownerProfileId: string },
): Promise<Dashboard | null> {
  const [publication] = await sql<
    {
      run_id: string;
      publication_id: string;
      published_at: string;
      recipe_version_id: string;
      subject_data_snapshot_id: string;
    }[]
  >`
    select p.run_id, p.publication_id, p.published_at, p.recipe_version_id,
           p.subject_data_snapshot_id
    from analysis.subject_live_publications p
    join app.analysis_subjects s on s.id = p.subject_id
    where p.subject_id = ${input.subjectId} and s.owner_user_id = ${input.ownerProfileId}
  `;
  if (!publication) return null;

  const estimates = await sql<
    {
      dimension_key: string;
      display_name: string;
      frame: string;
      phase: string | null;
      role: string | null;
      concept_slug: string | null;
      window_kind: string;
      estimate: string | null;
      interval_low: string | null;
      interval_high: string | null;
      raw_sample_size: number;
      effective_sample_size: string;
      success_count: number;
      failure_count: number;
      graded_count: number;
      censored_count: number;
      coverage_status: CoverageStatus;
      unavailable_reason: string | null;
      delta: string | null;
      improvement_probability: string | null;
      estimator_component_version_id: string;
    }[]
  >`
    select d.dimension_key, d.display_name, d.frame, d.phase, d.role,
           c.slug as concept_slug, e.window_kind, e.estimate,
           e.interval_low, e.interval_high, e.raw_sample_size, e.effective_sample_size,
           e.success_count, e.failure_count, e.graded_count, e.censored_count,
           e.coverage_status, e.unavailable_reason, e.delta, e.improvement_probability,
           e.estimator_component_version_id
    from analysis.player_skill_estimates e
    join analysis.skill_dimensions d on d.id = e.skill_dimension_id
    -- The concept behind the dimension, so the name a reader sees comes from
    -- the catalogue rather than from a row written months ago.
    left join analysis.concept_versions cv on cv.id = d.concept_version_id
    left join analysis.concepts c on c.id = cv.concept_id
    where e.analysis_run_id = ${publication.run_id}
    order by d.frame, d.dimension_key
  `;

  const findingRows = await sql<
    {
      id: string;
      finding_type: FindingType;
      priority: number;
      confidence_tier: string;
      claim: Record<string, unknown>;
      adjusted_probability: string | null;
      rendered_text: string | null;
      safety_state: string | null;
    }[]
  >`
    select f.id, f.finding_type, f.priority, f.confidence_tier, f.claim,
           f.adjusted_probability, r.rendered_text, r.safety_state
    from analysis.findings f
    left join analysis.rendered_explanations r on r.finding_id = f.id
    where f.analysis_run_id = ${publication.run_id}
    order by f.priority desc, f.created_at
  `;

  const evidenceRows = await sql<
    { finding_id: string; evidence_item_id: string; role: string; display_rank: number }[]
  >`
    select e.finding_id, e.evidence_item_id, e.role, e.display_rank
    from analysis.finding_evidence e
    join analysis.findings f on f.id = e.finding_id
    where f.analysis_run_id = ${publication.run_id}
    order by e.finding_id, e.display_rank
  `;

  const [trajectorySnapshot] = await sql<
    { id: string; included_game_count: number }[]
  >`
    select id, included_game_count from analysis.player_trajectory_snapshots
    where analysis_run_id = ${publication.run_id} and speed is null and color is null
    limit 1
  `;

  const binRows = trajectorySnapshot
    ? await sql<
        {
          phase: string;
          bin_ordinal: number;
          progress_low: string;
          progress_high: string;
          games_contributing: number;
          median_expected_score: string;
          p25_expected_score: string;
          p75_expected_score: string;
          interval_low: string | null;
          interval_high: string | null;
          phase_reach_rate: string;
        }[]
      >`
        select phase, bin_ordinal, progress_low, progress_high, games_contributing,
               median_expected_score, p25_expected_score, p75_expected_score,
               interval_low, interval_high, phase_reach_rate
        from analysis.player_trajectory_bins
        where trajectory_snapshot_id = ${trajectorySnapshot.id}
        order by phase, bin_ordinal
      `
    : [];

  const poolRows = await sql<
    {
      provider: string;
      pool: string;
      speed: string;
      observed_rating: number | null;
      scale_estimate: string | null;
      interval_low: string | null;
      interval_high: string | null;
      in_supported_range: boolean;
      suppressed_reason: string | null;
    }[]
  >`
    select c.provider, c.pool, s.speed, s.observed_rating, s.scale_estimate,
           s.interval_low, s.interval_high, s.in_supported_range, s.suppressed_reason
    from analysis.subject_rating_scale_estimates s
    join analysis.rating_pool_calibration_versions c on c.id = s.calibration_version_id
    where s.analysis_run_id = ${publication.run_id}
    order by c.provider, s.speed
  `;

  const evidenceByFinding = new Map<string, FindingView["evidence"]>();
  for (const row of evidenceRows) {
    evidenceByFinding.set(row.finding_id, [
      ...(evidenceByFinding.get(row.finding_id) ?? []),
      { evidenceItemId: row.evidence_item_id, role: row.role, displayRank: row.display_rank },
    ]);
  }

  const estimateViews: EstimateView[] = estimates.map((row) => ({
    dimensionKey: row.dimension_key,
    displayName: readableName(row.concept_slug, row.role, row.display_name),
    frame: row.frame,
    phase: row.phase,
    windowKind: row.window_kind,
    estimate: row.estimate === null ? null : Number(row.estimate),
    intervalLow: row.interval_low === null ? null : Number(row.interval_low),
    intervalHigh: row.interval_high === null ? null : Number(row.interval_high),
    rawSampleSize: row.raw_sample_size,
    effectiveSampleSize: Number(row.effective_sample_size),
    coverage: {
      success: row.success_count,
      failure: row.failure_count,
      graded: row.graded_count,
      censored: row.censored_count,
    },
    coverageStatus: row.coverage_status,
    unavailableReason: row.unavailable_reason,
    delta: row.delta === null ? null : Number(row.delta),
    improvementProbability:
      row.improvement_probability === null ? null : Number(row.improvement_probability),
  }));

  const reachedPhases = new Set(binRows.map((row) => row.phase));
  const trajectory: TrajectoryView = {
    state: trajectorySnapshot ? "published" : "unavailable",
    snapshotId: trajectorySnapshot?.id ?? null,
    includedGameCount: trajectorySnapshot?.included_game_count ?? 0,
    bins: binRows.map((row) => ({
      phase: row.phase,
      binOrdinal: row.bin_ordinal,
      progressLow: Number(row.progress_low),
      progressHigh: Number(row.progress_high),
      gamesContributing: row.games_contributing,
      medianExpectedScore: Number(row.median_expected_score),
      p25ExpectedScore: Number(row.p25_expected_score),
      p75ExpectedScore: Number(row.p75_expected_score),
      intervalLow: row.interval_low === null ? null : Number(row.interval_low),
      intervalHigh: row.interval_high === null ? null : Number(row.interval_high),
      phaseReachRate: Number(row.phase_reach_rate),
    })),
    // Named rather than omitted: a client that does not know the endgame is
    // missing will draw a line to zero across it.
    unreachedPhases: ["opening", "middlegame", "endgame"].filter(
      (phase) => !reachedPhases.has(phase),
    ),
  };

  // The reach rate is written identically onto every bin of a phase, so the
  // first bin carries it for the whole phase. Reading it from the trajectory
  // rather than recounting games here is what keeps the phase cards and the
  // curve above them quoting the same denominator.
  const reachByPhase = new Map<string, number>();
  for (const row of binRows) {
    if (!reachByPhase.has(row.phase)) reachByPhase.set(row.phase, Number(row.phase_reach_rate));
  }
  const cohortGames = trajectorySnapshot?.included_game_count ?? 0;
  const phaseViews: PhaseView[] = estimateViews
    .filter((view) => view.phase !== null)
    .map((view) => {
      const reachRate = reachByPhase.get(view.phase!) ?? null;
      return {
        phase: view.phase!,
        chances: view.rawSampleSize,
        observed: view.rawSampleSize - view.coverage.censored,
        taken: view.coverage.success,
        setAside: view.coverage.censored,
        rate: view.estimate,
        intervalLow: view.intervalLow,
        intervalHigh: view.intervalHigh,
        coverageStatus: view.coverageStatus,
        unavailableReason: view.unavailableReason,
        gamesReaching:
          reachRate === null || cohortGames === 0 ? null : Math.round(reachRate * cohortGames),
        phaseReachRate: reachRate,
      };
    })
    .sort((a, b) => PHASE_DISPLAY_ORDER.indexOf(a.phase) - PHASE_DISPLAY_ORDER.indexOf(b.phase));

  const phases: PhasesView = {
    state: phaseViews.length > 0 ? "published" : "unavailable",
    gamesInCohort: cohortGames,
    phases: phaseViews,
  };

  return {
    subjectId: input.subjectId,
    publicationId: publication.publication_id,
    runId: publication.run_id,
    publishedAt: publication.published_at,
    sections: {
      estimates: estimateViews.length > 0 ? "published" : "unavailable",
      findings: findingRows.length > 0 ? "published" : "unavailable",
      phases: phases.state,
      trajectory: trajectory.state,
      ratingProfile: poolRows.length > 0 ? "published" : "unavailable",
      // Later epics. Named so a client reads a state rather than inferring one
      // from an absent key.
      goal: "unavailable",
      connections: "unavailable",
    },
    estimates: estimateViews,
    findings: findingRows.map((row) => ({
      id: row.id,
      findingType: row.finding_type,
      priority: row.priority,
      confidenceTier: row.confidence_tier,
      claim: row.claim,
      adjustedProbability:
        row.adjusted_probability === null ? null : Number(row.adjusted_probability),
      evidence: evidenceByFinding.get(row.id) ?? [],
      // Text that did not pass the renderer check is not shown. It is kept in
      // the database for an operator, which is a different audience.
      explanation: row.safety_state === "passed" ? row.rendered_text : null,
      explanationState: row.safety_state,
    })),
    phases,
    trajectory,
    ratingProfile: {
      state: poolRows.length > 0 ? "published" : "unavailable",
      pools: poolRows.map((row) => ({
        provider: row.provider,
        pool: row.pool,
        speed: row.speed,
        observedRating: row.observed_rating,
        scaleEstimate: row.scale_estimate === null ? null : Number(row.scale_estimate),
        intervalLow: row.interval_low === null ? null : Number(row.interval_low),
        intervalHigh: row.interval_high === null ? null : Number(row.interval_high),
        inSupportedRange: row.in_supported_range,
        suppressedReason: row.suppressed_reason,
      })),
      note: "Ratings from different pools are not comparable. Forma does not combine them into one number.",
    },
    coverageWarnings: coverageWarnings(estimateViews, trajectory),
    version: {
      recipeVersionId: publication.recipe_version_id,
      snapshotId: publication.subject_data_snapshot_id,
      estimatorVersions: [
        ...new Set(estimates.map((row) => row.estimator_component_version_id)),
      ],
    },
  };
}

/**
 * The sentences a report has to say about itself.
 *
 * These are not decoration. Platform spec 14.5 requires a user with thin
 * evidence to see a useful limited report and the exact missing evidence rather
 * than a failure screen, and this is where "exact" is made concrete.
 */
function coverageWarnings(
  estimates: readonly EstimateView[],
  trajectory: TrajectoryView,
): string[] {
  const warnings: string[] = [];
  const insufficient = estimates.filter((e) => e.coverageStatus === "insufficient").length;
  const limited = estimates.filter((e) => e.coverageStatus === "limited").length;
  const outOfRange = estimates.filter((e) => e.coverageStatus === "out_of_range").length;

  if (insufficient > 0) {
    warnings.push(
      `${insufficient} of ${estimates.length} areas have too little evidence to estimate yet.`,
    );
  }
  if (limited > 0) {
    warnings.push(`${limited} areas are based on limited evidence and carry wide ranges.`);
  }
  if (outOfRange > 0) {
    warnings.push(
      "Your rating sits outside the range Forma has calibrated, so peer comparisons are not shown.",
    );
  }
  if (trajectory.unreachedPhases.length > 0) {
    warnings.push(
      `Your games did not reach ${trajectory.unreachedPhases.join(" or ")}, so those parts of the curve are absent rather than flat.`,
    );
  }
  return warnings;
}
