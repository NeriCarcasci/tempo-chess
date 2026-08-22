/**
 * The manifest has to be real before it can be evidence.
 *
 * A hand-written FEN is wrong more often than it is right, and a detector
 * tested against an impossible position proves nothing — it agrees with itself.
 * So every entry in `fixtures.ts` is parsed, legalised and replayed here, and
 * the shape coverage the contract matrix demands is asserted rather than
 * assumed.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Chess } from "chessops/chess";
import { parseFen } from "chessops/fen";
import { parseUci } from "chessops/util";
import {
  CONCEPT_FIXTURES,
  FIXTURE_SHAPES,
  fixturesFor,
  type ConceptFixture,
} from "./fixtures.js";

/** The position a fixture describes, or null if the FEN is not a legal position. */
function positionOf(fixture: ConceptFixture): Chess | null {
  const parsed = parseFen(fixture.fen);
  if (parsed.isErr) return null;
  const position = Chess.fromSetup(parsed.unwrap());
  return position.isErr ? null : position.unwrap();
}

test("every fixture FEN is a legal position", () => {
  for (const fixture of CONCEPT_FIXTURES) {
    assert.notEqual(positionOf(fixture), null, `${fixture.id} does not parse into a legal position`);
  }
});

test("the side to move is not already in check", () => {
  for (const fixture of CONCEPT_FIXTURES) {
    assert.equal(
      positionOf(fixture)!.isCheck(),
      false,
      `${fixture.id} starts with the focal player already in check`,
    );
  }
});

test("every fixture move is legal exactly when the fixture says it is", () => {
  for (const fixture of CONCEPT_FIXTURES) {
    const position = positionOf(fixture);
    assert.notEqual(position, null, `${fixture.id} does not parse`);
    const move = parseUci(fixture.move);
    assert.notEqual(move, null, `${fixture.id} has an unparseable move ${fixture.move}`);
    assert.equal(
      position!.isLegal(move!),
      fixture.expectLegal,
      fixture.expectLegal
        ? `${fixture.id}: ${fixture.move} should be legal and is not`
        : `${fixture.id}: ${fixture.move} should be illegal and is not — `
          + "the fixture no longer demonstrates what it claims",
    );
  }
});

test("a legal fixture move replays into a legal position", () => {
  for (const fixture of CONCEPT_FIXTURES) {
    if (!fixture.expectLegal) continue;
    const position = positionOf(fixture)!;
    position.play(parseUci(fixture.move)!);
    // `play` on a legal move cannot produce an illegal position; asserting the
    // king is still there catches a fixture that encoded a king capture.
    assert.notEqual(
      position.board.kingOf("white"),
      undefined,
      `${fixture.id} replayed into a position with no white king`,
    );
    assert.notEqual(
      position.board.kingOf("black"),
      undefined,
      `${fixture.id} replayed into a position with no black king`,
    );
  }
});

test("the side to move owns the focal move", () => {
  for (const fixture of CONCEPT_FIXTURES) {
    const position = positionOf(fixture)!;
    const move = parseUci(fixture.move)!;
    assert.ok("from" in move, `${fixture.id} is a drop, not a board move`);
    const piece = position.board.get(move.from);
    assert.notEqual(piece, undefined, `${fixture.id}: no piece on the from-square`);
    assert.equal(
      piece!.color,
      position.turn,
      `${fixture.id}: the focal move is played by the side that is not to move`,
    );
  }
});

test("fixture ids are unique", () => {
  const ids = CONCEPT_FIXTURES.map((fixture) => fixture.id);
  assert.equal(new Set(ids).size, ids.length, "two fixtures share an id");
});

test("every fixture shape is a declared shape", () => {
  const shapes = new Set<string>(FIXTURE_SHAPES);
  for (const fixture of CONCEPT_FIXTURES) {
    assert.ok(shapes.has(fixture.shape), `${fixture.id} has an unknown shape ${fixture.shape}`);
  }
});

/** The frozen matrix requires every shape for every detector in this milestone. */
const MVP_FAMILIES = [
  "double_attack",
  "pin",
  "skewer",
  "discovered_attack",
  "removal_of_defender",
  "trapped_piece",
] as const;

test("every MVP family has every contracted fixture shape", () => {
  for (const family of MVP_FAMILIES) {
    const present = new Set(fixturesFor(family).map((fixture) => fixture.shape));
    for (const shape of FIXTURE_SHAPES) {
      assert.ok(present.has(shape), `${family} has no ${shape} fixture`);
    }
  }
});

test("every MVP family has a colour-reversed positive", () => {
  for (const family of MVP_FAMILIES) {
    const positives = fixturesFor(family).filter((fixture) => fixture.shape === "positive");
    const colors = new Set(positives.map((fixture) => fixture.subjectColor));
    assert.equal(
      colors.size,
      2,
      `${family} has several positives but they are all the same colour`,
    );
  }
});
