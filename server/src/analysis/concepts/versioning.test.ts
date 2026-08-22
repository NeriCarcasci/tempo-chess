/**
 * That a version means one concept, and that identity is deterministic.
 *
 * FOR-122's acceptance criteria split into two halves. The half that needs a
 * database -- migration on an empty schema, repeat execution, concurrent retry,
 * incremental addition against existing E13 rows -- belongs to the integration
 * gate and is asserted there. The half that does not need one is here, and it
 * is the half that actually decides whether the scheme is sound: if a version
 * hash or a detection key is not a pure function of the thing it identifies,
 * no amount of database testing will make the writes idempotent.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Chess } from "chessops/chess";
import { parseFen, makeFen, INITIAL_FEN } from "chessops/fen";
import { parseUci } from "chessops/util";
import {
  CONCEPT_CATALOGUE,
  conceptVersionHash,
  type ConceptDefinition,
} from "./catalogue.js";
import { detectGame, eventKey, type GameFacts, type PositionFact, type TransitionFact } from "./detect.js";

// ---------------------------------------------------------------------------
// Versions belong to concepts, not to the catalogue
// ---------------------------------------------------------------------------

test("every concept declares its own version, and it is a real version number", () => {
  for (const concept of CONCEPT_CATALOGUE) {
    assert.ok(
      Number.isInteger(concept.versionNo) && concept.versionNo > 0,
      `${concept.slug} has version ${concept.versionNo}, which the version_no > 0 constraint rejects`,
    );
  }
});

test("bumping one concept's version leaves every other hash untouched", () => {
  const before = CONCEPT_CATALOGUE.map(conceptVersionHash);

  // The change FOR-124 is about to make to one entry, simulated here.
  const bumped: ConceptDefinition[] = CONCEPT_CATALOGUE.map((concept) =>
    concept.slug === "critical_moment" ? { ...concept, versionNo: concept.versionNo + 1 } : concept,
  );
  const after = bumped.map(conceptVersionHash);

  CONCEPT_CATALOGUE.forEach((concept, index) => {
    if (concept.slug === "critical_moment") {
      assert.notEqual(
        after[index],
        before[index],
        "the bumped concept must hash differently, or the bump registers nothing",
      );
    } else {
      assert.equal(
        after[index],
        before[index],
        `${concept.slug} changed hash because a different concept was bumped -- `
        + "that is the whole bug FOR-122 exists to remove",
      );
    }
  });
});

test("a changed rule under an unchanged version number is a different hash", () => {
  const [first] = CONCEPT_CATALOGUE;
  assert.ok(first);
  // Same slug, same version, different rule. The register step compares the
  // stored hash against this and must refuse rather than accept the new
  // meaning under the old number.
  const changed = { ...first, detectorContract: { ...first.detectorContract, thresholdCp: 999 } };
  assert.notEqual(conceptVersionHash(changed), conceptVersionHash(first));
});

test("the wording is not the rule", () => {
  const [first] = CONCEPT_CATALOGUE;
  assert.ok(first);
  assert.equal(
    conceptVersionHash({ ...first, displayName: "Renamed entirely" }),
    conceptVersionHash(first),
    "renaming a concept must not orphan the evidence recorded under it",
  );
  assert.equal(
    conceptVersionHash({ ...first, humanDefinition: "Reworded entirely." }),
    conceptVersionHash(first),
  );
});

test("no two catalogue entries collide on slug and version", () => {
  const keys = CONCEPT_CATALOGUE.map((concept) => `${concept.slug}@${concept.versionNo}`);
  assert.equal(new Set(keys).size, keys.length);
  const hashes = CONCEPT_CATALOGUE.map(conceptVersionHash);
  assert.equal(
    new Set(hashes).size,
    hashes.length,
    "two concepts hash the same, which the concept_versions_hash_unique index would reject",
  );
});

// ---------------------------------------------------------------------------
// Detection keys
// ---------------------------------------------------------------------------

function play(moves: readonly string[], initial = INITIAL_FEN): PositionFact[] {
  const board = Chess.fromSetup(parseFen(initial).unwrap()).unwrap();
  const positions: PositionFact[] = [{ ply: 0, fen: makeFen(board.toSetup()) }];
  moves.forEach((uci, index) => {
    board.play(parseUci(uci)!);
    positions.push({ ply: index + 1, fen: makeFen(board.toSetup()) });
  });
  return positions;
}

const MOVES = ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6", "f3g5", "d7d5", "e4d5", "f6d5"];

function busyGame(over: Partial<GameFacts> = {}): GameFacts {
  const positions = play(MOVES);
  const transitions = MOVES.map((uci, index): TransitionFact => ({
    fromPly: index,
    actorColor: index % 2 === 0 ? "white" : "black",
    playedMoveUci: uci,
    bestMoveUci: null,
    playedMoveRank: 1,
    playedMoveAcceptable: true,
    onlyMove: index === 4,
    criticality: index === 4 ? 0.4 : null,
    acceptableMoveCount: index === 4 ? 1 : null,
    candidateCount: index === 4 ? 3 : null,
    expectedScoreBefore: 0.5,
    expectedScoreAfter: 0.5,
    phase: "opening",
  }));
  return {
    subjectColor: "white",
    speed: "blitz",
    playedAt: new Date("2026-07-01T00:00:00Z"),
    termination: "resign",
    result: "white",
    positions,
    transitions,
    ...over,
  };
}

test("the same game detects the same keys, in the same order, every time", () => {
  const game = busyGame();
  const first = detectGame(game).map((found) => found.event.detectionKey);
  const second = detectGame(game).map((found) => found.event.detectionKey);
  assert.deepEqual(first, second);
  assert.ok(first.length > 0, "the fixture game produced nothing to compare");
});

test("one moment is one key, however many things are measured about it", () => {
  // A critical moment is observed twice -- did the player look at a real
  // candidate, and did they choose well among them -- and those are two
  // observations of one occurrence, not two occurrences.
  const found = detectGame(busyGame()).filter(
    (observation) => observation.conceptSlug === "critical_moment",
  );
  assert.equal(found.length, 2, "the fixture should produce both critical-moment roles");
  assert.deepEqual(found.map((observation) => observation.role).sort(), ["execute", "recognize"]);
  assert.equal(
    found[0]!.event.detectionKey,
    found[1]!.event.detectionKey,
    "recognize and execute must share the event, or the worker writes the moment twice",
  );
});

test("the observation identity the worker deduplicates on is unique per run", () => {
  // `(detection key, concept version, role)` is what the worker checks before
  // writing and what `opportunities_event_concept_role_unique` enforces. If the
  // detector can emit the same triple twice in one pass, the unique index turns
  // a normal run into a constraint violation.
  const identities = detectGame(busyGame()).map(
    (observation) => `${observation.event.detectionKey}|${observation.conceptSlug}|${observation.role}`,
  );
  assert.equal(
    new Set(identities).size,
    identities.length,
    `the detector emitted a duplicate observation identity: ${identities.join(", ")}`,
  );
});

test("different occurrences of the same event type do not share a key", () => {
  assert.notEqual(eventKey("pin", 12), eventKey("pin", 14));
  assert.notEqual(eventKey("pin", 12, "c1-f4"), eventKey("pin", 12, "a3-e7"));
  assert.equal(eventKey("pin", 12), eventKey("pin", 12));
  // The undiscriminated form is not accidentally equal to a discriminated one.
  assert.notEqual(eventKey("pin", 12), eventKey("pin", 12, ""));
});

test("a key says nothing about the concept, the role or the detector version", () => {
  // Stated as a test because it is the property that lets a corrected detector
  // attach a new label to an existing event instead of inventing a second
  // occurrence at the same ply.
  const key = eventKey("critical_moment", 4);
  assert.ok(!key.includes("critical_moment@"));
  assert.equal(key, "critical_moment:4");
});
