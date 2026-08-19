/**
 * `npm run analysis:unit` — the observation invariants, offline.
 *
 * These are E13's acceptance criteria stated as assertions: recognition and
 * execution stay two observations, a censored chance is never a failure, and a
 * number always carries the rubric that produced it.
 */

import { strict as assert } from "node:assert";
import {
  CONCEPT_ROLES,
  EPISODE_KINDS,
  RELATION_TYPES,
  difficultyIsUncontaminated,
  inspectOpportunity,
  isRecordableOpportunity,
  isSubjectAttributed,
  relationIsAuditable,
  successRate,
  tallyObservations,
  type OpportunityDraft,
} from "./observations.js";

let passed = 0;
const failures: string[] = [];

function check(name: string, body: () => string): void {
  try {
    const detail = body();
    passed += 1;
    console.log(`ok   ${name} — ${detail}`);
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    console.log(`FAIL ${name}`);
  }
}

const OBSERVED: OpportunityDraft = {
  role: "execute",
  opportunityPly: 20,
  responsePly: 21,
  responseObserved: true,
  censoredReason: null,
  success: false,
  score: null,
  rubricComponentVersionId: null,
  difficulty: { material: 0.4, complexity: 0.8 },
};

const CENSORED: OpportunityDraft = {
  role: "respond",
  opportunityPly: 40,
  responsePly: null,
  responseObserved: false,
  censoredReason: "opponent_resigned",
  success: null,
  score: null,
  rubricComponentVersionId: null,
  difficulty: null,
};

console.log("cd server && npm run analysis:unit\n");

check("an observed response must say what happened", () => {
  assert.deepEqual(inspectOpportunity(OBSERVED), []);
  assert.deepEqual(inspectOpportunity({ ...OBSERVED, success: null }), [
    "observed_must_have_success",
  ]);
  assert.deepEqual(inspectOpportunity({ ...OBSERVED, responsePly: null }), [
    "observed_must_have_response_ply",
  ]);
  return "success and a response ply are both required";
});

check("a censored chance is never a failure", () => {
  assert.deepEqual(inspectOpportunity(CENSORED), []);
  // The exact mistake this epic exists to prevent: recording "they failed"
  // when the subject was never given the move.
  assert.deepEqual(inspectOpportunity({ ...CENSORED, success: false }), [
    "censored_must_have_null_success",
  ]);
  assert.deepEqual(inspectOpportunity({ ...CENSORED, success: true }), [
    "censored_must_have_null_success",
  ]);
  return "success must be null when no response was observed, even a false one";
});

check("a censored chance must say why", () => {
  assert.deepEqual(inspectOpportunity({ ...CENSORED, censoredReason: null }), [
    "censored_must_state_reason",
  ]);
  // And an observed one must not claim to be censored.
  assert.deepEqual(
    inspectOpportunity({ ...OBSERVED, censoredReason: "game_ended" }),
    ["observed_must_not_be_censored"],
  );
  return "a reason is required when censored and forbidden when observed";
});

check("a score always pins its rubric", () => {
  assert.deepEqual(
    inspectOpportunity({ ...OBSERVED, score: 0.6, rubricComponentVersionId: null }),
    ["score_requires_rubric"],
  );
  assert.deepEqual(
    inspectOpportunity({ ...OBSERVED, score: 0.6, rubricComponentVersionId: "rubric-1" }),
    [],
  );
  // A censored row cannot carry a score at all.
  assert.deepEqual(
    inspectOpportunity({ ...CENSORED, score: 0.6, rubricComponentVersionId: "rubric-1" }),
    ["censored_must_have_null_score"],
  );
  return "0.6 without a rubric is refused; with one it is accepted";
});

check("a response cannot precede its opportunity", () => {
  assert.deepEqual(inspectOpportunity({ ...OBSERVED, responsePly: 19 }), [
    "response_precedes_opportunity",
  ]);
  assert.equal(isRecordableOpportunity({ ...OBSERVED, responsePly: 20 }), true);
  return "ply 19 for a chance at ply 20 is refused; the same ply is allowed";
});

check("recognition and execution stay two observations", () => {
  // The same event, seen and then botched: two rows, two roles, two truths.
  const recognized: OpportunityDraft = { ...OBSERVED, role: "recognize", success: true };
  const executed: OpportunityDraft = { ...OBSERVED, role: "execute", success: false };
  assert.equal(isRecordableOpportunity(recognized), true);
  assert.equal(isRecordableOpportunity(executed), true);
  const tally = tallyObservations([recognized, executed]);
  assert.equal(tally.observed, 2);
  assert.equal(tally.successes, 1);
  assert.equal(tally.failures, 1);
  // There is no averaging into one "partially correct" number.
  assert.equal(successRate(tally), 0.5);
  return "saw it and misplayed it: 1 success, 1 failure, never 'half right'";
});

check("censored chances are excluded from the rate, not counted as failures", () => {
  const tally = tallyObservations([
    { ...OBSERVED, success: true },
    { ...OBSERVED, success: false },
    CENSORED,
    CENSORED,
  ]);
  assert.equal(tally.observed, 2);
  assert.equal(tally.censored, 2);
  assert.equal(tally.failures, 1);
  // The wrong arithmetic would be 1/4 = 0.25 by treating censored as failures.
  assert.equal(successRate(tally), 0.5);
  assert.notEqual(successRate(tally), 0.25);
  return "1 of 2 observed = 0.5, not 1 of 4 = 0.25";
});

check("no observed chances is unknown, not zero", () => {
  const tally = tallyObservations([CENSORED, CENSORED, CENSORED]);
  assert.equal(tally.observed, 0);
  assert.equal(tally.censored, 3);
  // Null, not 0: "we do not know" and "they always fail" are different claims.
  assert.equal(successRate(tally), null);
  return "three censored chances yield null, never 0%";
});

check("difficulty may not be derived from the outcome", () => {
  assert.equal(difficultyIsUncontaminated({ material: 0.4, complexity: 0.8 }), true);
  assert.equal(difficultyIsUncontaminated(null), true);
  for (const key of ["success", "Succeeded", "score", "result", "correct"]) {
    assert.equal(
      difficultyIsUncontaminated({ [key]: 1 }),
      false,
      `${key} was accepted into a difficulty vector`,
    );
  }
  return "outcome-derived keys refused; positional ones accepted";
});

check("an opponent's concession is not the subject recovering", () => {
  assert.equal(isSubjectAttributed("recovery"), true);
  assert.equal(isSubjectAttributed("stabilization"), true);
  assert.equal(isSubjectAttributed("conversion"), true);
  // The distinction §18.1 keeps: the position improved, but not because of them.
  assert.equal(isSubjectAttributed("opponent_concession"), false);
  assert.equal(isSubjectAttributed("setback"), false);
  assert.equal(isSubjectAttributed("collapse"), false);
  return "opponent_concession is not credited to the subject";
});

check("a relation must carry the method and components that justify it", () => {
  const sound = {
    relationType: "improved_response" as const,
    fromEventId: 1,
    toEventId: 2,
    methodVersion: "structural-v1",
    components: { motif: 0.9, pawnStructure: 0.8 },
  };
  assert.equal(relationIsAuditable(sound), true);
  assert.equal(relationIsAuditable({ ...sound, components: null }), false);
  assert.equal(relationIsAuditable({ ...sound, components: {} }), false);
  assert.equal(relationIsAuditable({ ...sound, methodVersion: "" }), false);
  // An event cannot be an improvement on itself.
  assert.equal(relationIsAuditable({ ...sound, toEventId: 1 }), false);
  return "no components, no method, or self-reference all refused";
});

check("the vocabularies match the check constraints in 0025", () => {
  assert.deepEqual(
    [...CONCEPT_ROLES],
    ["create", "recognize", "execute", "avoid", "prevent", "respond", "convert"],
  );
  assert.equal(RELATION_TYPES.length, 7);
  assert.equal(EPISODE_KINDS.length, 9);
  assert.equal(EPISODE_KINDS.includes("opponent_concession"), true);
  assert.equal(EPISODE_KINDS.includes("recovery"), true);
  return `${CONCEPT_ROLES.length} roles, ${RELATION_TYPES.length} relation types, ${EPISODE_KINDS.length} episode kinds`;
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
}
