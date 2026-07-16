export const PHASE_CLASSIFIER_VERSION = "tempo-phase-v1" as const;

export type GamePhase = "opening" | "middlegame" | "endgame";
export type PhaseBoundaryReason =
  | "opening_book_boundary"
  | "opening_position_developed"
  | "endgame_low_material"
  | "endgame_queenless_reduced_material";

export interface PhasePosition {
  /** Ply after the move; the initial position is ply 0. */
  ply: number;
  fen: string;
}

export interface PhaseBoundary {
  phase: "middlegame" | "endgame";
  startsAtPly: number;
  reason: PhaseBoundaryReason;
}

export interface PhaseClassificationInput {
  positions: readonly PhasePosition[];
  /** Last ply classified by the position-based opening catalogue. */
  openingBoundaryPly?: number;
  inputRevision?: string;
}

export interface PhaseClassification {
  version: typeof PHASE_CLASSIFIER_VERSION;
  boundaries: readonly PhaseBoundary[];
  byPly: ReadonlyMap<number, GamePhase>;
  provenance: {
    method: "deterministic";
    openingBoundarySource: "catalogue" | "position_rules";
    inputRevision?: string;
  };
}

/** Append-only persistence shape: callers keep old records when the classifier upgrades. */
export interface PhaseComputationRecord {
  classifierVersion: string;
  computedAt: string;
  inputRevision?: string;
  supersedesClassifierVersion?: string;
  boundaries: readonly PhaseBoundary[];
}

export function phaseComputationRecord(
  classification: PhaseClassification,
  computedAt: Date,
  previous?: PhaseComputationRecord,
): PhaseComputationRecord {
  return {
    classifierVersion: classification.version,
    computedAt: computedAt.toISOString(),
    ...(classification.provenance.inputRevision
      ? { inputRevision: classification.provenance.inputRevision }
      : {}),
    ...(previous ? { supersedesClassifierVersion: previous.classifierVersion } : {}),
    boundaries: classification.boundaries,
  };
}

interface MaterialSnapshot {
  queens: number;
  nonPawnPoints: number;
}

function boardFromFen(fen: string): string {
  const fields = fen.trim().split(/\s+/);
  const board = fields[0];
  const ranks = board?.split("/") ?? [];
  const validRanks = ranks.length === 8 && ranks.every((rank) => {
    if (!/^[prnbqkPRNBQK1-8]+$/.test(rank)) return false;
    return [...rank].reduce((width, token) => width + (/\d/.test(token) ? Number(token) : 1), 0) === 8;
  });
  const pieces = board?.replace(/[1-8/]/g, "") ?? "";
  const validKings = [...pieces].filter((piece) => piece === "K").length === 1
    && [...pieces].filter((piece) => piece === "k").length === 1;
  const validTurn = fields[1] === "w" || fields[1] === "b";
  if (!board || !validRanks || !validKings || !validTurn) throw new Error(`Invalid FEN: ${fen}`);
  return board;
}

function material(fen: string): MaterialSnapshot {
  const pieces = boardFromFen(fen).replace(/[1-8/]/g, "");
  const values: Record<string, number> = { n: 3, b: 3, r: 5, q: 9 };
  let queens = 0;
  let nonPawnPoints = 0;
  for (const piece of pieces.toLowerCase()) {
    if (piece === "q") queens += 1;
    nonPawnPoints += values[piece] ?? 0;
  }
  return { queens, nonPawnPoints };
}

function openingHasDeveloped(position: PhasePosition): boolean {
  if (position.ply < 16) return false;
  const board = boardFromFen(position.fen);
  // Original minor-piece squares vacated plus loss of castling rights/central pawn movement.
  const ranks = board.split("/").map((rank) => {
    let expanded = "";
    for (const token of rank) expanded += /\d/.test(token) ? " ".repeat(Number(token)) : token;
    return expanded;
  });
  const originalMinorSquares = [ranks[7]![1], ranks[7]![6], ranks[0]![1], ranks[0]![6]];
  const developedMinors = originalMinorSquares.filter((piece, index) =>
    piece !== (index < 2 ? "N" : "n"),
  ).length;
  const fields = position.fen.trim().split(/\s+/);
  const castlingRights = fields[2] ?? "-";
  return developedMinors >= 3 && (castlingRights === "-" || position.ply >= 20);
}

function endgameReason(fen: string): PhaseBoundaryReason | undefined {
  const snapshot = material(fen);
  if (snapshot.nonPawnPoints <= 16) return "endgame_low_material";
  if (snapshot.queens === 0 && snapshot.nonPawnPoints <= 26) {
    return "endgame_queenless_reduced_material";
  }
  return undefined;
}

export function classifyGamePhases(input: PhaseClassificationInput): PhaseClassification {
  const positions = [...input.positions].sort((a, b) => a.ply - b.ply);
  if (positions.length === 0) throw new Error("Phase classification requires at least one position");
  for (const position of positions) {
    if (!Number.isInteger(position.ply) || position.ply < 0) {
      throw new Error(`Invalid phase ply: ${position.ply}`);
    }
    boardFromFen(position.fen);
  }
  for (let index = 1; index < positions.length; index += 1) {
    if (positions[index]!.ply === positions[index - 1]!.ply) {
      throw new Error(`Duplicate phase position at ply ${positions[index]!.ply}`);
    }
  }
  if (
    input.openingBoundaryPly !== undefined
    && (!Number.isInteger(input.openingBoundaryPly)
      || input.openingBoundaryPly < 0
      || input.openingBoundaryPly > positions.at(-1)!.ply)
  ) {
    throw new Error(`Invalid opening boundary ply: ${input.openingBoundaryPly}`);
  }

  let middleStart: number | undefined;
  let middleReason: PhaseBoundaryReason | undefined;
  if (input.openingBoundaryPly !== undefined) {
    middleStart = input.openingBoundaryPly + 1;
    middleReason = "opening_book_boundary";
  } else {
    const developed = positions.find(openingHasDeveloped);
    middleStart = developed?.ply;
    middleReason = developed ? "opening_position_developed" : undefined;
  }

  // A game with no detected exit remains opening; material alone cannot relabel its early plies.
  let endStart: number | undefined;
  let endReason: PhaseBoundaryReason | undefined;
  if (middleStart !== undefined) {
    const ending = positions.find((position) => position.ply >= middleStart! && endgameReason(position.fen));
    if (ending) {
      endStart = ending.ply;
      endReason = endgameReason(ending.fen);
    }
  }

  const boundaries: PhaseBoundary[] = [];
  if (middleStart !== undefined && middleReason !== undefined) {
    boundaries.push({ phase: "middlegame", startsAtPly: middleStart, reason: middleReason });
  }
  if (endStart !== undefined && endReason !== undefined) {
    boundaries.push({ phase: "endgame", startsAtPly: endStart, reason: endReason });
  }

  const byPly = new Map<number, GamePhase>();
  for (const position of positions) {
    const phase = endStart !== undefined && position.ply >= endStart
      ? "endgame"
      : middleStart !== undefined && position.ply >= middleStart
        ? "middlegame"
        : "opening";
    byPly.set(position.ply, phase);
  }

  return {
    version: PHASE_CLASSIFIER_VERSION,
    boundaries,
    byPly,
    provenance: {
      method: "deterministic",
      openingBoundarySource: input.openingBoundaryPly === undefined ? "position_rules" : "catalogue",
      ...(input.inputRevision ? { inputRevision: input.inputRevision } : {}),
    },
  };
}

export interface ProviderDivision {
  middlegamePly?: number;
  endgamePly?: number;
}

export interface PhaseValidationComparison {
  provider: string;
  classifierVersion: string;
  middlegameDeltaPly?: number;
  endgameDeltaPly?: number;
  middlegameWithinTolerance?: boolean;
  endgameWithinTolerance?: boolean;
  comparableBoundaryCount: number;
  withinTolerance: boolean;
}

/** Pure comparison helper for offline validation; provider divisions never drive classification. */
export function compareProviderDivisions(
  classification: PhaseClassification,
  provider: string,
  divisions: ProviderDivision,
  tolerancePly = 4,
): PhaseValidationComparison {
  const middle = classification.boundaries.find((boundary) => boundary.phase === "middlegame")?.startsAtPly;
  const ending = classification.boundaries.find((boundary) => boundary.phase === "endgame")?.startsAtPly;
  const middlegameDeltaPly = middle !== undefined && divisions.middlegamePly !== undefined
    ? middle - divisions.middlegamePly
    : undefined;
  const endgameDeltaPly = ending !== undefined && divisions.endgamePly !== undefined
    ? ending - divisions.endgamePly
    : undefined;
  const deltas = [middlegameDeltaPly, endgameDeltaPly].filter((value): value is number => value !== undefined);
  return {
    provider,
    classifierVersion: classification.version,
    ...(middlegameDeltaPly !== undefined ? { middlegameDeltaPly } : {}),
    ...(endgameDeltaPly !== undefined ? { endgameDeltaPly } : {}),
    ...(middlegameDeltaPly !== undefined
      ? { middlegameWithinTolerance: Math.abs(middlegameDeltaPly) <= tolerancePly }
      : {}),
    ...(endgameDeltaPly !== undefined
      ? { endgameWithinTolerance: Math.abs(endgameDeltaPly) <= tolerancePly }
      : {}),
    comparableBoundaryCount: deltas.length,
    withinTolerance: deltas.length > 0 && deltas.every((delta) => Math.abs(delta) <= tolerancePly),
  };
}

export interface PhaseValidationSummary {
  games: number;
  comparableBoundaries: number;
  boundariesWithinTolerance: number;
  agreementRate: number | null;
  meanAbsoluteDeltaPly: number | null;
}

export function summarizePhaseValidation(
  comparisons: readonly PhaseValidationComparison[],
): PhaseValidationSummary {
  const deltas = comparisons.flatMap((comparison) => [
    comparison.middlegameDeltaPly,
    comparison.endgameDeltaPly,
  ]).filter((delta): delta is number => delta !== undefined);
  const boundaryAgreement = comparisons.flatMap((comparison) => [
    comparison.middlegameWithinTolerance,
    comparison.endgameWithinTolerance,
  ]).filter((agrees): agrees is boolean => agrees !== undefined);
  return {
    games: comparisons.length,
    comparableBoundaries: deltas.length,
    boundariesWithinTolerance: boundaryAgreement.filter(Boolean).length,
    agreementRate: boundaryAgreement.length === 0
      ? null
      : boundaryAgreement.filter(Boolean).length / boundaryAgreement.length,
    meanAbsoluteDeltaPly: deltas.length === 0
      ? null
      : deltas.reduce((sum, delta) => sum + Math.abs(delta), 0) / deltas.length,
  };
}
