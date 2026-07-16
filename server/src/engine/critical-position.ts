/** Machine-readable reasons that a position deserves deeper analysis. */
export const CRITICAL_POSITION_REASONS = [
  "serious_judgment",
  "evaluation_swing",
  "trade",
  "pawn_break",
  "candidate_ambiguity",
  "clock_anomaly",
  "phase_transition",
] as const;

export type CriticalPositionReason =
  (typeof CRITICAL_POSITION_REASONS)[number];

export type MoveJudgment =
  | "good"
  | "inaccuracy"
  | "mistake"
  | "blunder";

export type GamePhase = "opening" | "middlegame" | "endgame";

export interface CandidateEvaluation {
  /** Move in UCI notation. */
  move: string;
  /** Evaluation from the moving player's perspective. */
  evaluationCp: number;
}

/**
 * Cheap, first-pass signals for one player decision. Evaluations must use the
 * moving player's perspective so a positive `evaluationLossCp` always means
 * the played move was worse.
 */
export interface CriticalPositionCandidate {
  gameId: string;
  ply: number;
  judgment?: MoveJudgment;
  evaluationLossCp?: number;
  isTrade?: boolean;
  isPawnBreak?: boolean;
  candidateEvaluations?: readonly CandidateEvaluation[];
  thinkTimeSeconds?: number;
  remainingTimeSeconds?: number;
  /** Median think time for comparable moves in this game. */
  baselineThinkTimeSeconds?: number;
  phaseBefore?: GamePhase;
  phaseAfter?: GamePhase;
}

export interface CriticalPositionPolicy {
  maxPositionsPerGame: number;
  evaluationSwingCp: number;
  ambiguousCandidateGapCp: number;
  minimumAmbiguousCandidates: number;
  rushedThinkTimeSeconds: number;
  rushedRemainingTimeSeconds: number;
  longThinkMultiplier: number;
  longThinkMinimumSeconds: number;
}

export const DEFAULT_CRITICAL_POSITION_POLICY: Readonly<CriticalPositionPolicy> =
  Object.freeze({
    maxPositionsPerGame: 12,
    evaluationSwingCp: 100,
    ambiguousCandidateGapCp: 35,
    minimumAmbiguousCandidates: 2,
    rushedThinkTimeSeconds: 3,
    rushedRemainingTimeSeconds: 30,
    longThinkMultiplier: 3,
    longThinkMinimumSeconds: 45,
  });

export interface CriticalReasonDetail {
  code: CriticalPositionReason;
  /** Larger values indicate a stronger signal within the same reason. */
  strength: number;
  observed: number | string;
  threshold?: number | string;
}

export interface CriticalPositionAssessment {
  candidate: CriticalPositionCandidate;
  reasons: readonly CriticalReasonDetail[];
  /** Deterministic ranking score. This is not a chess evaluation. */
  priorityScore: number;
  selected: boolean;
  rank?: number;
}

export interface CriticalPositionSelection {
  selected: readonly CriticalPositionAssessment[];
  assessments: readonly CriticalPositionAssessment[];
  cap: number;
  eligibleCount: number;
}

const REASON_WEIGHT: Record<CriticalPositionReason, number> = {
  serious_judgment: 1_000,
  evaluation_swing: 500,
  candidate_ambiguity: 160,
  clock_anomaly: 120,
  trade: 80,
  pawn_break: 80,
  phase_transition: 60,
};

function finiteNonNegative(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value)
    ? Math.max(0, value)
    : undefined;
}

function reasonDetails(
  candidate: CriticalPositionCandidate,
  policy: CriticalPositionPolicy,
): CriticalReasonDetail[] {
  const reasons: CriticalReasonDetail[] = [];
  const loss = finiteNonNegative(candidate.evaluationLossCp);

  if (candidate.judgment === "mistake" || candidate.judgment === "blunder") {
    reasons.push({
      code: "serious_judgment",
      strength: candidate.judgment === "blunder" ? 2 : 1,
      observed: candidate.judgment,
      threshold: "mistake",
    });
  }

  if (loss !== undefined && loss >= policy.evaluationSwingCp) {
    reasons.push({
      code: "evaluation_swing",
      strength: loss / policy.evaluationSwingCp,
      observed: loss,
      threshold: policy.evaluationSwingCp,
    });
  }

  if (candidate.isTrade) {
    reasons.push({ code: "trade", strength: 1, observed: "trade" });
  }

  if (candidate.isPawnBreak) {
    reasons.push({ code: "pawn_break", strength: 1, observed: "pawn_break" });
  }

  const evaluations = candidate.candidateEvaluations
    ?.map(({ evaluationCp }) => evaluationCp)
    .filter(Number.isFinite)
    .sort((a, b) => b - a);
  if (evaluations && evaluations.length >= policy.minimumAmbiguousCandidates) {
    const gap = Math.max(0, evaluations[0] - evaluations[1]);
    if (gap <= policy.ambiguousCandidateGapCp) {
      reasons.push({
        code: "candidate_ambiguity",
        strength: 1 + (policy.ambiguousCandidateGapCp - gap) /
          Math.max(1, policy.ambiguousCandidateGapCp),
        observed: gap,
        threshold: policy.ambiguousCandidateGapCp,
      });
    }
  }

  const thinkTime = finiteNonNegative(candidate.thinkTimeSeconds);
  const remaining = finiteNonNegative(candidate.remainingTimeSeconds);
  const baseline = finiteNonNegative(candidate.baselineThinkTimeSeconds);
  if (
    thinkTime !== undefined &&
    remaining !== undefined &&
    thinkTime <= policy.rushedThinkTimeSeconds &&
    remaining >= policy.rushedRemainingTimeSeconds
  ) {
    reasons.push({
      code: "clock_anomaly",
      strength: 1 +
        (policy.rushedThinkTimeSeconds - thinkTime) /
          Math.max(1, policy.rushedThinkTimeSeconds),
      observed: "rushed",
      threshold: policy.rushedThinkTimeSeconds,
    });
  } else if (
    thinkTime !== undefined &&
    baseline !== undefined &&
    thinkTime >= policy.longThinkMinimumSeconds &&
    thinkTime >= baseline * policy.longThinkMultiplier
  ) {
    reasons.push({
      code: "clock_anomaly",
      strength: thinkTime / Math.max(1, baseline * policy.longThinkMultiplier),
      observed: "long_think",
      threshold: baseline * policy.longThinkMultiplier,
    });
  }

  if (
    candidate.phaseBefore !== undefined &&
    candidate.phaseAfter !== undefined &&
    candidate.phaseBefore !== candidate.phaseAfter
  ) {
    reasons.push({
      code: "phase_transition",
      strength: 1,
      observed: `${candidate.phaseBefore}_to_${candidate.phaseAfter}`,
    });
  }

  return reasons;
}

function score(reasons: readonly CriticalReasonDetail[]): number {
  return reasons.reduce(
    (total, reason) => total + REASON_WEIGHT[reason.code] * reason.strength,
    0,
  );
}

function compareAssessments(
  left: CriticalPositionAssessment,
  right: CriticalPositionAssessment,
): number {
  return (
    right.priorityScore - left.priorityScore ||
    left.candidate.ply - right.candidate.ply ||
    left.candidate.gameId.localeCompare(right.candidate.gameId)
  );
}

function validatePolicy(policy: CriticalPositionPolicy): void {
  if (!Number.isInteger(policy.maxPositionsPerGame) || policy.maxPositionsPerGame < 0) {
    throw new RangeError("maxPositionsPerGame must be a non-negative integer");
  }
  if (!Number.isInteger(policy.minimumAmbiguousCandidates) || policy.minimumAmbiguousCandidates < 2) {
    throw new RangeError("minimumAmbiguousCandidates must be an integer of at least 2");
  }
  const positiveThresholds = [
    policy.evaluationSwingCp,
    policy.ambiguousCandidateGapCp,
    policy.rushedThinkTimeSeconds,
    policy.rushedRemainingTimeSeconds,
    policy.longThinkMultiplier,
    policy.longThinkMinimumSeconds,
  ];
  if (positiveThresholds.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new RangeError("policy thresholds must be finite positive numbers");
  }
}

/**
 * Selects critical positions independently for each game. Output order follows
 * input order for easy trace joins; `selected` is ordered by priority.
 */
export function selectCriticalPositions(
  candidates: readonly CriticalPositionCandidate[],
  overrides: Partial<CriticalPositionPolicy> = {},
): CriticalPositionSelection {
  const policy = { ...DEFAULT_CRITICAL_POSITION_POLICY, ...overrides };
  validatePolicy(policy);

  const base = candidates.map((candidate) => {
    if (!Number.isInteger(candidate.ply) || candidate.ply < 0) {
      throw new RangeError("candidate ply must be a non-negative integer");
    }
    const reasons = reasonDetails(candidate, policy);
    return {
      candidate,
      reasons,
      priorityScore: score(reasons),
      selected: false,
    } satisfies CriticalPositionAssessment;
  });

  const eligibleByGame = new Map<string, CriticalPositionAssessment[]>();
  for (const assessment of base) {
    if (assessment.reasons.length === 0) continue;
    const game = eligibleByGame.get(assessment.candidate.gameId) ?? [];
    game.push(assessment);
    eligibleByGame.set(assessment.candidate.gameId, game);
  }

  const selectedKeys = new Map<CriticalPositionAssessment, number>();
  for (const game of eligibleByGame.values()) {
    game.sort(compareAssessments);
    game.slice(0, policy.maxPositionsPerGame).forEach((assessment, index) => {
      selectedKeys.set(assessment, index + 1);
    });
  }

  const assessments = base.map((assessment) => {
    const rank = selectedKeys.get(assessment);
    return rank === undefined
      ? assessment
      : { ...assessment, selected: true, rank };
  });
  const selected = assessments.filter(({ selected }) => selected).sort(compareAssessments);

  return {
    selected,
    assessments,
    cap: policy.maxPositionsPerGame,
    eligibleCount: base.filter(({ reasons }) => reasons.length > 0).length,
  };
}
