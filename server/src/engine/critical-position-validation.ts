import {
  selectCriticalPositions,
  type CriticalPositionCandidate,
  type CriticalPositionPolicy,
} from "./critical-position.js";

export interface CriticalPositionValidationCase {
  candidate: CriticalPositionCandidate;
  /** Ground-truth serious error established by the benchmark corpus. */
  isSeriousError: boolean;
}

export interface CriticalPositionValidationResult {
  seriousErrorCount: number;
  selectedSeriousErrorCount: number;
  seriousErrorRecall: number;
  selectedCount: number;
  gameCount: number;
  budgetCompliant: boolean;
  selectedPerGame: Readonly<Record<string, number>>;
}

/** Reusable acceptance metrics for synthetic or recorded benchmark corpora. */
export function validateCriticalPositionPolicy(
  cases: readonly CriticalPositionValidationCase[],
  overrides: Partial<CriticalPositionPolicy> = {},
): CriticalPositionValidationResult {
  const selection = selectCriticalPositions(
    cases.map(({ candidate }) => candidate),
    overrides,
  );
  const selected = new Set(
    selection.selected.map(({ candidate }) => `${candidate.gameId}:${candidate.ply}`),
  );
  const serious = cases.filter(({ isSeriousError }) => isSeriousError);
  const selectedSerious = serious.filter(({ candidate }) =>
    selected.has(`${candidate.gameId}:${candidate.ply}`),
  );
  const selectedPerGame: Record<string, number> = {};
  for (const { candidate } of selection.selected) {
    selectedPerGame[candidate.gameId] = (selectedPerGame[candidate.gameId] ?? 0) + 1;
  }

  return {
    seriousErrorCount: serious.length,
    selectedSeriousErrorCount: selectedSerious.length,
    seriousErrorRecall: serious.length === 0 ? 1 : selectedSerious.length / serious.length,
    selectedCount: selection.selected.length,
    gameCount: new Set(cases.map(({ candidate }) => candidate.gameId)).size,
    budgetCompliant: Object.values(selectedPerGame).every(
      (count) => count <= selection.cap,
    ),
    selectedPerGame,
  };
}
