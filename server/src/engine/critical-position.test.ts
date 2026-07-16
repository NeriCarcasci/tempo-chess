import assert from "node:assert/strict";
import {
  CRITICAL_POSITION_REASONS,
  selectCriticalPositions,
  type CriticalPositionCandidate,
} from "./critical-position.js";
import { validateCriticalPositionPolicy } from "./critical-position-validation.js";
import { buildBenchmarkCorpus } from "../benchmark/corpus.js";

function allTriggerCandidate(): CriticalPositionCandidate {
  return {
    gameId: "all-reasons",
    ply: 24,
    judgment: "blunder",
    evaluationLossCp: 240,
    isTrade: true,
    isPawnBreak: true,
    candidateEvaluations: [
      { move: "e2e4", evaluationCp: 45 },
      { move: "d2d4", evaluationCp: 30 },
    ],
    thinkTimeSeconds: 2,
    remainingTimeSeconds: 180,
    baselineThinkTimeSeconds: 12,
    phaseBefore: "opening",
    phaseAfter: "middlegame",
  };
}

{
  const result = selectCriticalPositions([allTriggerCandidate()]);
  assert.equal(result.selected.length, 1);
  assert.deepEqual(
    result.selected[0].reasons.map(({ code }) => code).sort(),
    [...CRITICAL_POSITION_REASONS].sort(),
  );
  assert.equal(result.selected[0].selected, true);
  assert.equal(result.selected[0].rank, 1);
}

{
  const candidates: CriticalPositionCandidate[] = [
    { gameId: "priority", ply: 1, isTrade: true },
    { gameId: "priority", ply: 2, isPawnBreak: true },
    { gameId: "priority", ply: 3, judgment: "mistake" },
  ];
  const first = selectCriticalPositions(candidates, { maxPositionsPerGame: 2 });
  const second = selectCriticalPositions(candidates, { maxPositionsPerGame: 2 });
  assert.deepEqual(first, second, "selection must be deterministic");
  assert.deepEqual(
    first.selected.map(({ candidate }) => candidate.ply),
    [3, 1],
    "serious errors rank before contextual triggers and ply breaks ties",
  );
  assert.equal(first.assessments.find(({ candidate }) => candidate.ply === 2)?.selected, false);
}

{
  const cases = Array.from({ length: 10 }, (_, gameIndex) => {
    const gameId = `validation-${gameIndex}`;
    return [
      ...Array.from({ length: 3 }, (_, errorIndex) => ({
        candidate: {
          gameId,
          ply: errorIndex * 4 + 5,
          judgment: errorIndex === 0 ? "blunder" as const : "mistake" as const,
          evaluationLossCp: 130 + errorIndex * 30,
        },
        isSeriousError: true,
      })),
      ...Array.from({ length: 9 }, (_, signalIndex) => ({
        candidate: {
          gameId,
          ply: signalIndex * 2 + 20,
          isTrade: signalIndex % 2 === 0,
          isPawnBreak: signalIndex % 2 === 1,
        },
        isSeriousError: false,
      })),
    ];
  }).flat();

  const validation = validateCriticalPositionPolicy(cases, {
    maxPositionsPerGame: 5,
  });
  assert.ok(validation.seriousErrorRecall >= 0.9);
  assert.equal(validation.seriousErrorRecall, 1);
  assert.equal(validation.budgetCompliant, true);
  assert.ok(Object.values(validation.selectedPerGame).every((count) => count <= 5));
}

{
  // Replay the policy against every real game record in the shared benchmark
  // corpus. The serious decision is mixed with lower-priority contextual
  // signals so this validates ranking as well as trigger recall.
  const cases = buildBenchmarkCorpus().flatMap((game, gameIndex) => [
    {
      candidate: {
        gameId: game.id,
        ply: game.decisionPly,
        judgment: gameIndex % 4 === 0 ? "blunder" as const : "mistake" as const,
        evaluationLossCp: 150 + (gameIndex % 5) * 20,
        thinkTimeSeconds: game.remainingClockMs === undefined ? 8 : 2,
        remainingTimeSeconds: game.remainingClockMs === undefined ? 120 : 45,
      },
      isSeriousError: true,
    },
    ...Array.from({ length: 5 }, (_, signalIndex) => ({
      candidate: {
        gameId: game.id,
        ply: game.decisionPly + signalIndex + 1,
        isTrade: signalIndex % 2 === 0,
        isPawnBreak: signalIndex % 2 === 1,
      },
      isSeriousError: false,
    })),
  ]);
  const validation = validateCriticalPositionPolicy(cases, {
    maxPositionsPerGame: 3,
  });
  assert.equal(validation.gameCount, 120);
  assert.ok(validation.seriousErrorRecall >= 0.9);
  assert.equal(validation.budgetCompliant, true);
}

{
  const result = selectCriticalPositions(
    [
      {
        gameId: "clock",
        ply: 1,
        thinkTimeSeconds: 60,
        remainingTimeSeconds: 200,
        baselineThinkTimeSeconds: 10,
      },
      { gameId: "quiet", ply: 1 },
    ],
    { maxPositionsPerGame: 0 },
  );
  assert.equal(result.selected.length, 0);
  assert.equal(result.assessments[0].reasons[0].observed, "long_think");
  assert.equal(result.assessments[1].reasons.length, 0);
}

assert.throws(
  () => selectCriticalPositions([], { longThinkMultiplier: Number.NaN }),
  /finite positive numbers/,
);
assert.throws(
  () => selectCriticalPositions([], { minimumAmbiguousCandidates: 1 }),
  /at least 2/,
);

console.log("PASS  critical-position policy and validation");
