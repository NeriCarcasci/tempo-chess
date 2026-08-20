/**
 * `npm run analysis:unit` — the deterministic half of E11, with no database.
 *
 * Everything here is a pure function that decides what "the same analysis"
 * means: the hashes that give immutable rows their identity, the scope rules
 * that say which run type may cite which input, the manifest completeness rule
 * that stands between a partial run and a publication, and the lifecycle
 * transitions that stop a draft becoming production without evidence.
 *
 * The negative cases are the point. A hash that ignores a field, a manifest
 * check that accepts a missing family, or a cohort that treats unknown as yes
 * would each produce a claim Forma cannot support, and each is asserted against
 * here rather than assumed.
 */

import { strict as assert } from "node:assert";
import {
  assessManifest,
  cohortDefinitionSchema,
  componentVersionHash,
  cohortDefinitionHash,
  isLifecycleTransitionAllowed,
  outputManifestHash,
  recipeManifestHash,
  runInputManifestHash,
  scopeViolations,
  snapshotHash,
  HASH_SHAPE,
  LIFECYCLE_STATES,
  type CohortDefinition,
} from "./contract.js";
import { compareRecipes } from "./versions.js";

let passed = 0;
const failures: string[] = [];

function check(name: string, body: () => string): void {
  try {
    console.log(`ok   ${name} — ${body()}`);
    passed += 1;
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    console.log(`FAIL ${name}`);
  }
}

console.log("cd server && npm run analysis:unit\n");

// --- component version identity --------------------------------------------

const BASE = {
  componentKey: "estimator",
  version: "1",
  implementationSha256: "a".repeat(64),
  configuration: { halfLifeDays: 90, mode: "decay" },
  modelIdentity: null,
};

check("a component version hash is a sha-256", () => {
  const hash = componentVersionHash(BASE);
  assert.match(hash, HASH_SHAPE);
  return hash.slice(0, 12);
});

check("configuration key order does not change the identity", () => {
  const reordered = { ...BASE, configuration: { mode: "decay", halfLifeDays: 90 } };
  assert.equal(componentVersionHash(reordered), componentVersionHash(BASE));
  return "same hash for the same content";
});

check("a changed configuration value is a different version", () => {
  const changed = { ...BASE, configuration: { halfLifeDays: 45, mode: "decay" } };
  assert.notEqual(componentVersionHash(changed), componentVersionHash(BASE));
  return "half-life 90 and 45 do not collide";
});

check("model identity is part of the identity", () => {
  const withModel = { ...BASE, modelIdentity: { family: "maia", revision: "1900" } };
  assert.notEqual(componentVersionHash(withModel), componentVersionHash(BASE));
  return "swapping weights forks the version";
});

// --- recipe manifest --------------------------------------------------------

const RECIPE = {
  recipeKey: "live",
  version: "1",
  runType: "subject_live" as const,
  inputSchemaVersion: "subject_snapshot.v1",
  outputSchemaVersion: "subject_live.v1",
  requiredArtifacts: ["skill_estimates", "transition_assessments"],
  components: { engine: "b".repeat(64), estimator: "c".repeat(64) },
};

check("artifact family order does not change a recipe manifest", () => {
  const reversed = { ...RECIPE, requiredArtifacts: ["transition_assessments", "skill_estimates"] };
  assert.equal(recipeManifestHash(reversed), recipeManifestHash(RECIPE));
  return "a manifest is a set of commitments, not a document";
});

check("swapping one pinned component changes the manifest", () => {
  const bumped = { ...RECIPE, components: { ...RECIPE.components, estimator: "d".repeat(64) } };
  assert.notEqual(recipeManifestHash(bumped), recipeManifestHash(RECIPE));
  return "a method-only change is a new recipe";
});

// --- snapshots --------------------------------------------------------------

const GAMES = [
  { subjectGameId: "g2", replayRevisionId: "20", materializationRunId: "m2", weight: null },
  { subjectGameId: "g1", replayRevisionId: "10", materializationRunId: "m1", weight: null },
];

check("a snapshot hash does not depend on manifest order", () => {
  const a = snapshotHash({ subjectId: "s", cohortDefinitionHash: "e".repeat(64), cutoff: "2026-01-01T00:00:00.000Z", games: GAMES });
  const b = snapshotHash({ subjectId: "s", cohortDefinitionHash: "e".repeat(64), cutoff: "2026-01-01T00:00:00.000Z", games: [...GAMES].reverse() });
  assert.equal(a, b);
  return "the same games in any order freeze to one manifest";
});

check("a provider correction changes the snapshot hash", () => {
  const before = snapshotHash({ subjectId: "s", cohortDefinitionHash: "e".repeat(64), cutoff: "2026-01-01T00:00:00.000Z", games: GAMES });
  const corrected = GAMES.map((game) =>
    game.subjectGameId === "g1" ? { ...game, replayRevisionId: "11" } : game,
  );
  assert.notEqual(
    snapshotHash({ subjectId: "s", cohortDefinitionHash: "e".repeat(64), cutoff: "2026-01-01T00:00:00.000Z", games: corrected }),
    before,
  );
  return "a new revision is a new manifest, not an edit";
});

check("a new materialization of the same replay changes the snapshot hash", () => {
  const before = snapshotHash({ subjectId: "s", cohortDefinitionHash: "e".repeat(64), cutoff: "2026-01-01T00:00:00.000Z", games: GAMES });
  const rematerialized = GAMES.map((game) =>
    game.subjectGameId === "g1" ? { ...game, materializationRunId: "m1b" } : game,
  );
  assert.notEqual(
    snapshotHash({ subjectId: "s", cohortDefinitionHash: "e".repeat(64), cutoff: "2026-01-01T00:00:00.000Z", games: rematerialized }),
    before,
  );
  return "the chain the analysis reads is part of the pin";
});

// --- run input manifest -----------------------------------------------------

const RUN_INPUT = {
  runType: "subject_live" as const,
  recipeManifestHash: "f".repeat(64),
  scope: { subjectId: "s", subjectDataSnapshotId: "snap" },
  snapshotHash: "0".repeat(64),
  dependencyOutputHashes: ["1".repeat(64), "2".repeat(64)],
};

check("identical inputs produce one run identity", () => {
  const shuffled = { ...RUN_INPUT, dependencyOutputHashes: ["2".repeat(64), "1".repeat(64)] };
  assert.equal(runInputManifestHash(shuffled), runInputManifestHash(RUN_INPUT));
  return "reuse order is not an input";
});

check("a different recipe is a different run identity", () => {
  assert.notEqual(
    runInputManifestHash({ ...RUN_INPUT, recipeManifestHash: "9".repeat(64) }),
    runInputManifestHash(RUN_INPUT),
  );
  return "a method-only rerun is a new run, not a duplicate";
});

check("dropping a reused upstream output is a different run identity", () => {
  assert.notEqual(
    runInputManifestHash({ ...RUN_INPUT, dependencyOutputHashes: ["1".repeat(64)] }),
    runInputManifestHash(RUN_INPUT),
  );
  return "what was reused is part of what was run";
});

// --- run scope --------------------------------------------------------------

check("a game analysis must pin a game and a revision", () => {
  const problems = scopeViolations("game_analysis", { subjectId: "s" });
  assert.deepEqual(problems, [
    "game_analysis requires subject_game_id",
    "game_analysis requires replay_revision_id",
  ]);
  return "both missing pins are named";
});

check("a game analysis may not also pin a snapshot", () => {
  const problems = scopeViolations("game_analysis", {
    subjectId: "s",
    subjectGameId: "g",
    replayRevisionId: "1",
    subjectDataSnapshotId: "snap",
  });
  assert.deepEqual(problems, ["game_analysis must not set subject_data_snapshot_id"]);
  return "scope is exclusive, not additive";
});

check("a subject run pins a snapshot and no single game", () => {
  assert.deepEqual(scopeViolations("subject_live", { subjectId: "s", subjectDataSnapshotId: "snap" }), []);
  assert.deepEqual(
    scopeViolations("subject_baseline", { subjectId: "s", subjectDataSnapshotId: "snap", subjectGameId: "g" }),
    ["subject_baseline must not set subject_game_id"],
  );
  return "the manifest is the game list, not a column";
});

// --- output manifests -------------------------------------------------------

const DECLARED = ["events", "skill_estimates"];

check("a complete manifest has every declared family", () => {
  const assessment = assessManifest(DECLARED, [
    { family: "events", count: 0, checksum: "a".repeat(64) },
    { family: "skill_estimates", count: 7, checksum: "b".repeat(64) },
  ]);
  assert.equal(assessment.complete, true);
  return "count 0 is complete: a quiet game produced no events";
});

check("a missing family is incomplete, not empty", () => {
  const assessment = assessManifest(DECLARED, [
    { family: "skill_estimates", count: 7, checksum: "b".repeat(64) },
  ]);
  assert.equal(assessment.complete, false);
  assert.deepEqual(assessment.missing, ["events"]);
  return "absence cannot be read as none";
});

check("an undeclared family is not the run that was planned", () => {
  const assessment = assessManifest(DECLARED, [
    { family: "events", count: 1, checksum: "a".repeat(64) },
    { family: "skill_estimates", count: 7, checksum: "b".repeat(64) },
    { family: "findings", count: 2, checksum: "c".repeat(64) },
  ]);
  assert.equal(assessment.complete, false);
  assert.deepEqual(assessment.undeclared, ["findings"]);
  return "the contract is exact in both directions";
});

check("an output manifest hash ignores family order", () => {
  const entries = [
    { family: "events", count: 1, checksum: "a".repeat(64) },
    { family: "skill_estimates", count: 7, checksum: "b".repeat(64) },
  ];
  assert.equal(outputManifestHash(entries), outputManifestHash([...entries].reverse()));
  assert.notEqual(
    outputManifestHash(entries),
    outputManifestHash([{ ...entries[0], count: 2 }, entries[1]]),
  );
  return "same families, different counts, different hash";
});

// --- lifecycle --------------------------------------------------------------

check("production is reachable only from validated", () => {
  const sources = LIFECYCLE_STATES.filter((state) => isLifecycleTransitionAllowed(state, "production"));
  assert.deepEqual(sources, ["validated"]);
  return "no shortcut from draft or shadow";
});

check("retirement is one way", () => {
  const onwards = LIFECYCLE_STATES.filter((state) => isLifecycleTransitionAllowed("retired", state));
  assert.deepEqual(onwards, []);
  return "a retired version comes back as a new version";
});

// --- cohort definitions -----------------------------------------------------

const COHORT: CohortDefinition = {
  providers: ["lichess"],
  rated: "rated",
  speeds: ["blitz"],
  includeBotOpponents: false,
  playedFrom: null,
  playedTo: null,
  maxGames: 500,
  minGames: 50,
  requireClocks: false,
  ratingMin: null,
  ratingMax: null,
};

check("a cohort definition hash ignores key order", () => {
  const reordered = Object.fromEntries(
    Object.entries(COHORT).reverse(),
  ) as unknown as CohortDefinition;
  assert.equal(cohortDefinitionHash(reordered), cohortDefinitionHash(COHORT));
  return "the rules are the identity, not their spelling";
});

check("changing the minimum creates a different cohort", () => {
  assert.notEqual(cohortDefinitionHash({ ...COHORT, minGames: 30 }), cohortDefinitionHash(COHORT));
  return "minimum 50 to 30 is a new version, not a quiet change";
});

check("an unknown cohort field is refused", () => {
  const result = cohortDefinitionSchema.safeParse({ ...COHORT, includeBlitzOnly: true });
  assert.equal(result.success, false);
  return "a typo cannot become a silently ignored rule";
});

check("an inverted rating band is refused", () => {
  const result = cohortDefinitionSchema.safeParse({ ...COHORT, ratingMin: 2000, ratingMax: 1200 });
  assert.equal(result.success, false);
  return "a band that selects nothing is a mistake, not a cohort";
});

check("an inverted played-at window is refused", () => {
  const result = cohortDefinitionSchema.safeParse({
    ...COHORT,
    playedFrom: "2026-06-01T00:00:00Z",
    playedTo: "2026-01-01T00:00:00Z",
  });
  assert.equal(result.success, false);
  return "from after to is refused at the contract";
});

// --- recipe comparison ------------------------------------------------------

check("comparing recipes names exactly the changed role", () => {
  const before = { normalizer: "n1", engine: "e1", estimator: "s1" };
  const after = { normalizer: "n1", engine: "e1", estimator: "s2" };
  const difference = compareRecipes(before, after);
  assert.deepEqual(difference.unchanged, ["engine", "normalizer"]);
  assert.deepEqual(difference.changed, ["estimator"]);
  assert.deepEqual(difference.added, []);
  assert.deepEqual(difference.removed, []);
  return "two roles reusable, one recomputed";
});

check("an added role is not reusable", () => {
  const difference = compareRecipes({ engine: "e1" }, { engine: "e1", renderer: "r1" });
  assert.deepEqual(difference.unchanged, ["engine"]);
  assert.deepEqual(difference.added, ["renderer"]);
  return "a new role has no upstream output to carry over";
});

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  - ${failure}`);
process.exit(failures.length === 0 ? 0 : 1);
