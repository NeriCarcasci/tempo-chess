/**
 * The canonical fixture manifest, frozen by FOR-121.
 *
 * Every detector ticket in this project must cover the six shapes named in
 * `plans/tactical-concepts-contracts.md`: a positive, a near miss, refuted
 * geometry, an alternative that was better, an attacker that cannot legally
 * move, and evidence too incomplete to judge. They live here rather than inside
 * each detector's test file for one reason — a fixture that only exists next to
 * the detector it was written for is a fixture that agrees with it.
 *
 * `fixtures.test.ts` replays every entry and fails if a FEN does not parse into
 * a legal position or a listed move is not legal in it. That check is the whole
 * value of this file: a hand-written FEN is wrong more often than not, and a
 * detector tested against an impossible position proves nothing at all.
 *
 * Nothing here interprets a position. Whether `positive` really is a fork is the
 * detector's claim to make and its test's to assert; this module only promises
 * the board is real and the move is playable.
 */

/** The six shapes every family covers. See the contract matrix. */
export const FIXTURE_SHAPES = [
  "positive",
  "near_miss",
  "refuted_geometry",
  "alternative_better",
  "illegal_attacker",
  "incomplete_evidence",
] as const;
export type FixtureShape = (typeof FIXTURE_SHAPES)[number];

export interface ConceptFixture {
  readonly id: string;
  /** The concept family slug this exercises. */
  readonly family: string;
  readonly shape: FixtureShape;
  /** Position before the focal move. */
  readonly fen: string;
  /**
   * The focal move, in UCI.
   *
   * Legal in `fen` for every shape except `illegal_attacker`, where the point of
   * the fixture is that it is not — `expectLegal` says which.
   */
  readonly move: string;
  readonly expectLegal: boolean;
  /** Which side the subject is, for role and colour assertions. */
  readonly subjectColor: "white" | "black";
  /** What the detector must conclude. Prose, for the human reading the failure. */
  readonly expectation: string;
}

/**
 * Colour-reversed twins are listed explicitly rather than generated.
 *
 * Mirroring a FEN programmatically is its own source of bugs — castling rights,
 * en passant files and the side to move all have to flip together — and a
 * generated fixture that is wrong is wrong in both directions at once.
 */
export const CONCEPT_FIXTURES: readonly ConceptFixture[] = Object.freeze([
  // -------------------------------------------------------------------------
  // double_attack
  // -------------------------------------------------------------------------
  {
    id: "double_attack/knight-fork-king-rook",
    family: "double_attack",
    shape: "positive",
    fen: "r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1",
    move: "b5c7",
    expectLegal: true,
    subjectColor: "white",
    expectation:
      "Nc7+ forks the king on e8 and the rook on a8; the king must move and the rook falls. "
      + "Event double_attack, subtype royal_fork, role execute, success.",
  },
  {
    id: "double_attack/knight-fork-king-rook-black",
    family: "double_attack",
    shape: "positive",
    fen: "4k3/8/8/8/1n6/8/8/R3K3 b - - 0 1",
    move: "b4c2",
    expectLegal: true,
    subjectColor: "black",
    expectation:
      "The same fork with the colours reversed: Nc2+ hits the king on e1 and the rook on a1. "
      + "A detector that passes the White twin and fails this one measures half the players.",
  },
  {
    id: "double_attack/knight-checks-one-target-only",
    family: "double_attack",
    shape: "near_miss",
    fen: "r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1",
    move: "b5d6",
    expectLegal: true,
    subjectColor: "white",
    expectation:
      "Nd6+ is check but touches nothing else. One threat is not a double attack. Negative.",
  },
  {
    id: "double_attack/fork-square-is-defended",
    family: "double_attack",
    shape: "refuted_geometry",
    fen: "r3k3/3r4/8/1N6/8/8/8/4K3 w - - 0 1",
    move: "b5c7",
    expectLegal: true,
    subjectColor: "white",
    expectation:
      "The fork geometry is real, but Rd7xc7 answers the check and takes the knight. "
      + "Nothing is won, so this is a negative rather than a chance the opponent missed.",
  },
  {
    id: "double_attack/forking-knight-is-pinned",
    family: "double_attack",
    shape: "illegal_attacker",
    fen: "1r2k3/8/8/1N6/8/8/8/1K6 w - - 0 1",
    move: "b5c7",
    expectLegal: false,
    subjectColor: "white",
    expectation:
      "The knight on b5 is pinned to the king on b1 by the rook on b8, so Nc7 is not a legal "
      + "move at all. Geometry that cannot be played is not an opportunity.",
  },

  // -------------------------------------------------------------------------
  // pin
  // -------------------------------------------------------------------------
  {
    id: "pin/bishop-pins-knight-to-king",
    family: "pin",
    shape: "positive",
    fen: "8/4k3/5n2/8/7B/8/8/4K3 w - - 0 1",
    move: "h4g5",
    expectLegal: true,
    subjectColor: "white",
    expectation:
      "Bg5 pins the knight on f6 against the king on e7 along the g5-f6-e7 diagonal. "
      + "Absolute pin: the knight cannot legally move. Event pin, subtype absolute, role execute.",
  },
  {
    id: "pin/bishop-pins-knight-to-king-black",
    family: "pin",
    shape: "positive",
    fen: "4k3/8/8/8/1b6/8/3N4/4K3 b - - 0 1",
    move: "b4c3",
    expectLegal: true,
    subjectColor: "black",
    expectation:
      "The colour-reversed twin: Bc3 pins the knight on d2 against the king on e1 along "
      + "c3-d2-e1. Absolute pin, role execute, subject Black.",
  },
  {
    id: "pin/alignment-with-nothing-behind-it",
    family: "pin",
    shape: "near_miss",
    fen: "4k3/8/8/5n2/7B/8/8/4K3 w - - 0 1",
    move: "h4g5",
    expectLegal: true,
    subjectColor: "white",
    expectation:
      "The bishop lands on g5 and the knight on f5 is not on that diagonal at all. "
      + "No ray, no pin. Negative.",
  },

  // -------------------------------------------------------------------------
  // skewer
  // -------------------------------------------------------------------------
  {
    id: "skewer/rook-checks-king-wins-rook",
    family: "skewer",
    shape: "positive",
    fen: "8/4r3/8/8/4k3/8/8/R6K w - - 0 1",
    move: "a1e1",
    expectLegal: true,
    subjectColor: "white",
    expectation:
      "Re1+ skewers the king on e4 to the rook on e7. The king must step off the e-file and "
      + "Rxe7 follows. Front target is the more valuable one, which is what separates this "
      + "from a pin.",
  },
  {
    id: "skewer/rear-target-is-defended",
    family: "skewer",
    shape: "refuted_geometry",
    fen: "8/4r3/3b4/8/4k3/8/8/R6K w - - 0 1",
    move: "a1e1",
    expectLegal: true,
    subjectColor: "white",
    expectation:
      "The skewer geometry is identical, but the bishop on d6 guards e7. The king steps aside, "
      + "Rxe7 Bxe7, and nothing is won. Negative — a skewer that trades evenly is not a skewer "
      + "the opponent failed to answer.",
  },

  // -------------------------------------------------------------------------
  // discovered_attack
  // -------------------------------------------------------------------------
  {
    id: "discovered_attack/knight-steps-off-the-diagonal",
    family: "discovered_attack",
    shape: "positive",
    fen: "8/6k1/8/8/3N4/8/8/B6K w - - 0 1",
    move: "d4b5",
    expectLegal: true,
    subjectColor: "white",
    expectation:
      "Nb5 vacates the a1-h8 diagonal and the bishop on a1 checks the king on g7. "
      + "The knight itself attacks nothing relevant, so this is a plain discovered check.",
  },
  {
    id: "discovered_attack/double-check",
    family: "discovered_attack",
    shape: "positive",
    fen: "8/6k1/8/8/3N4/8/8/B6K w - - 0 1",
    move: "d4f5",
    expectLegal: true,
    subjectColor: "white",
    expectation:
      "Nf5+ checks from the knight and uncovers the bishop's check at the same time. "
      + "Subtype double_check, from the same family and the same event type.",
  },
  {
    id: "discovered_attack/knight-steps-off-the-diagonal-black",
    family: "discovered_attack",
    shape: "positive",
    fen: "b3k3/8/8/3n4/8/8/6K1/8 b - - 0 1",
    move: "d5c3",
    expectLegal: true,
    subjectColor: "black",
    expectation:
      "The colour-reversed twin: Nc3 vacates the a8-h1 diagonal and the bishop on a8 checks "
      + "the king on g2.",
  },
  {
    id: "discovered_attack/line-was-never-blocked",
    family: "discovered_attack",
    shape: "near_miss",
    fen: "8/6k1/8/8/8/2N5/8/B6K w - - 0 1",
    move: "c3b5",
    expectLegal: true,
    subjectColor: "white",
    expectation:
      "The knight on c3 is not on the a1-h8 diagonal, so moving it uncovers nothing. "
      + "Negative — a knight move is not a discovery just because a bishop exists.",
  },

  // -------------------------------------------------------------------------
  // removal_of_defender
  // -------------------------------------------------------------------------
  {
    id: "removal_of_defender/capture-the-pawn-that-guards",
    family: "removal_of_defender",
    shape: "positive",
    fen: "4k3/8/2p5/3n4/1N6/8/8/3RK3 w - - 0 1",
    move: "b4c6",
    expectLegal: true,
    subjectColor: "white",
    expectation:
      "Nxc6 takes the only defender of the knight on d5; Rxd5 then wins it. "
      + "Event removal_of_defender, method capture, role execute.",
  },
  {
    id: "removal_of_defender/target-has-a-second-defender",
    family: "removal_of_defender",
    shape: "refuted_geometry",
    fen: "4k3/4b3/2p5/3n4/1N6/8/8/3RK3 w - - 0 1",
    move: "b4c6",
    expectLegal: true,
    subjectColor: "white",
    expectation:
      "The bishop on e7 also guards d5, so removing the c6 pawn wins nothing. "
      + "The duty was shared, and a shared duty is not removed by taking one holder of it.",
  },

  // -------------------------------------------------------------------------
  // trapped_piece
  // -------------------------------------------------------------------------
  {
    id: "trapped_piece/knight-in-the-corner",
    family: "trapped_piece",
    shape: "positive",
    fen: "n3k3/8/8/1PP5/8/8/8/4K3 w - - 0 1",
    move: "b5b6",
    expectLegal: true,
    subjectColor: "white",
    expectation:
      "b6 takes c7 away from the knight on a8 while the c5 pawn covers b6. "
      + "Both squares the knight has are gone, so it is lost. Role execute for White; "
      + "the same event gives Black a respond opportunity on the next ply.",
  },
  {
    id: "trapped_piece/knight-still-has-a-square",
    family: "trapped_piece",
    shape: "near_miss",
    fen: "n3k3/8/8/1P6/8/8/8/4K3 w - - 0 1",
    move: "b5b6",
    expectLegal: true,
    subjectColor: "white",
    expectation:
      "Without the c5 pawn, b6 is free and the knight escapes there. "
      + "One escape square is enough — the piece is not trapped, and this is a negative.",
  },
]);

export function fixturesFor(family: string): readonly ConceptFixture[] {
  return CONCEPT_FIXTURES.filter((fixture) => fixture.family === family);
}

export function fixturesOfShape(shape: FixtureShape): readonly ConceptFixture[] {
  return CONCEPT_FIXTURES.filter((fixture) => fixture.shape === shape);
}
