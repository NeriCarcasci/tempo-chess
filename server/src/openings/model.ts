export const OPENING_CLASSIFIER_VERSION = 2 as const;
export const OPENING_PRIOR = Object.freeze({ alpha: 4, beta: 2 });

export type FindingStatus =
  | "emerging"
  | "stable"
  | "unstable"
  | "blind_spot"
  | "decaying";

export interface MasteryInput {
  opportunities: number;
  acceptable: number;
  weightedOpportunities?: number;
  weightedAcceptable?: number;
  recentOpportunities?: number;
  recentAcceptable?: number;
  historicalOpportunities?: number;
  historicalAcceptable?: number;
  averageLossCp?: number | null;
}

export interface MasteryMetrics {
  mastery: number;
  evidence: number;
  interval: { low: number; high: number };
  effectiveSample: number;
  consistency: number;
  averageLossCp: number | null;
  status: FindingStatus;
}

export function classifyOpeningDecision(input: {
  actorIsPlayer: boolean;
  repertoireMove: boolean;
  catalogueMove: boolean;
  evaluationLossCp: number | null;
}): { acceptable: boolean | null; reason: string | null } {
  if (!input.actorIsPlayer) return { acceptable: null, reason: null };
  if (input.repertoireMove) {
    return { acceptable: true, reason: "saved_repertoire_move" };
  }
  if (input.catalogueMove) {
    return { acceptable: true, reason: "catalogue_move" };
  }
  if (input.evaluationLossCp == null) {
    return { acceptable: null, reason: "insufficient_engine_evidence" };
  }
  if (input.evaluationLossCp < 90) {
    return { acceptable: true, reason: "within_90cp_tolerance" };
  }
  return {
    acceptable: false,
    reason: `lost_${Math.round(input.evaluationLossCp)}cp`,
  };
}

export function canonicalPositionKey(fen: string): string {
  const fields = fen.trim().split(/\s+/);
  if (fields.length < 4) throw new Error(`Invalid FEN: ${fen}`);
  const enPassant = fields[3] === "-" ? "-" : fields[3];
  return `${fields[0]} ${fields[1]} ${fields[2]} ${enPassant}`;
}

function clamp(value: number, low = 0, high = 1): number {
  return Math.min(high, Math.max(low, value));
}

function score(
  successes: number,
  total: number,
  alpha = OPENING_PRIOR.alpha,
  beta = OPENING_PRIOR.beta,
): number {
  return (successes + alpha) / (total + alpha + beta);
}

function interval(successes: number, total: number): { low: number; high: number } {
  const alpha = successes + OPENING_PRIOR.alpha;
  const beta = total - successes + OPENING_PRIOR.beta;
  const mean = alpha / (alpha + beta);
  const variance = (alpha * beta) /
    ((alpha + beta) ** 2 * (alpha + beta + 1));
  const width = 1.96 * Math.sqrt(variance);
  return { low: clamp(mean - width), high: clamp(mean + width) };
}

export function calculateMastery(input: MasteryInput): MasteryMetrics {
  const effective = Math.max(
    0,
    input.weightedOpportunities ?? input.opportunities,
  );
  const weightedAcceptable = Math.min(
    effective,
    Math.max(0, input.weightedAcceptable ?? input.acceptable),
  );
  const masteryValue = score(weightedAcceptable, effective);
  const evidence = 1 - Math.exp(-effective / 7);
  const consistency = input.opportunities
    ? 1 - Math.min(1, 4 * (input.acceptable / input.opportunities) *
      (1 - input.acceptable / input.opportunities))
    : 0;
  const recent = score(
    input.recentAcceptable ?? 0,
    input.recentOpportunities ?? 0,
  );
  const historical = score(
    input.historicalAcceptable ?? 0,
    input.historicalOpportunities ?? 0,
  );

  let status: FindingStatus;
  if (effective < 3) status = "emerging";
  else if (
    (input.recentOpportunities ?? 0) >= 2 &&
    (input.historicalOpportunities ?? 0) >= 3 &&
    recent < historical - 0.15
  ) status = "decaying";
  else if (masteryValue < 0.58 && evidence >= 0.5) status = "blind_spot";
  else if (masteryValue < 0.72 || consistency < 0.35) status = "unstable";
  else status = "stable";

  const bounds = interval(weightedAcceptable, effective);
  return {
    mastery: Math.round(masteryValue * 100),
    evidence: Math.round(evidence * 100),
    interval: {
      low: Math.round(bounds.low * 100),
      high: Math.round(bounds.high * 100),
    },
    effectiveSample: Math.round(effective * 10) / 10,
    consistency: Math.round(consistency * 100),
    averageLossCp: input.averageLossCp == null
      ? null
      : Math.round(input.averageLossCp),
    status,
  };
}

export function splitOpeningName(name: string | null | undefined): {
  family: string;
  variation: string | null;
} {
  if (!name?.trim()) return { family: "Unclassified", variation: null };
  const [family, ...rest] = name.split(":");
  return {
    family: family.trim(),
    variation: rest.length ? rest.join(":").trim() : null,
  };
}
