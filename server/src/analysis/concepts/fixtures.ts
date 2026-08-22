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
    shape: "refuted_geometry",
    fen: "8/4k3/5n2/8/7B/8/8/4K3 w - - 0 1",
    move: "h4g5",
    expectLegal: true,
    subjectColor: "white",
    expectation:
      "Bg5 pins the knight on f6 against the king on e7, and the knight cannot legally move. "
      + "It still wins nothing: Bxf6 is answered by Kxf6, so the pinned piece is not winnable. "
      + "Written first as a positive, which was the mistake -- immobilising a piece and winning "
      + "one are different claims, and the contract records only the second.",
  },
  {
    id: "pin/rook-pins-knight-and-wins-it",
    family: "pin",
    shape: "positive",
    fen: "3k4/8/8/3n4/8/8/8/R6K w - - 0 1",
    move: "a1d1",
    expectLegal: true,
    subjectColor: "white",
    expectation:
      "Rd1 pins the undefended knight on d5 against the king on d8. Every black reply loses it: "
      + "moving the king leaves it hanging and it cannot move itself. Event pin, subtype "
      + "absolute, role execute, payoff a knight.",
  },
  {
    id: "pin/rook-pins-knight-and-wins-it-black",
    family: "pin",
    shape: "positive",
    fen: "r6k/8/8/8/3N4/8/8/3K4 b - - 0 1",
    move: "a8d8",
    expectLegal: true,
    subjectColor: "black",
    expectation: "The same winning pin with the colours reversed.",
  },
  {
    id: "pin/bishop-pins-knight-to-king-black",
    family: "pin",
    shape: "refuted_geometry",
    fen: "4k3/8/8/8/1b6/8/3N4/4K3 b - - 0 1",
    move: "b4c3",
    expectLegal: true,
    subjectColor: "black",
    expectation:
      "The colour-reversed twin of the bishop pin, and a negative for the same reason: Bxd2 is "
      + "answered by Kxd2.",
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
      + "Rxe7 follows. The rook cannot interpose: the only blocking squares are e2 and e3, and "
      + "its own king on e4 stands in the way of reaching them. Front target is the more "
      + "valuable one, which is what separates this from a pin.",
  },
  {
    id: "skewer/bishop-checks-king-wins-rook",
    family: "skewer",
    shape: "positive",
    fen: "7r/6k1/8/8/8/8/8/2B2K2 w - - 0 1",
    move: "c1b2",
    expectLegal: true,
    subjectColor: "white",
    expectation:
      "Bb2+ checks the king on g7 along a1-h8 with the rook on h8 directly behind it. Nothing "
      + "can interpose -- the rook cannot reach the diagonal in one move -- so the king moves and "
      + "Bxh8 follows. Where the king steps to g8 or h7 it defends the rook, which the payoff "
      + "accounts for.",
  },
  {
    id: "skewer/bishop-checks-king-wins-rook-black",
    family: "skewer",
    shape: "positive",
    fen: "2b1k3/8/8/8/8/8/6K1/7R b - - 0 1",
    move: "c8b7",
    expectLegal: true,
    subjectColor: "black",
    expectation: "The same skewer with the colours reversed: Bb7+ along a8-h1, winning the rook on h1.",
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
    fen: "8/2r3k1/8/8/3N4/8/8/B6K w - - 0 1",
    move: "d4b5",
    expectLegal: true,
    subjectColor: "white",
    expectation:
      "Nb5 vacates the a1-h8 diagonal and the bishop on a1 checks the king on g7, while the "
      + "knight lands attacking the rook on c7. The check must be answered and the rook falls. "
      + "Written first without the rook, where the discovery won nothing at all -- a check that "
      + "wins nothing is not a chance the opponent missed.",
  },
  {
    id: "discovered_attack/double-check",
    family: "discovered_attack",
    shape: "positive",
    fen: "8/4r1k1/8/8/3N4/8/8/B6K w - - 0 1",
    move: "d4f5",
    expectLegal: true,
    subjectColor: "white",
    expectation:
      "Nf5+ checks from the knight and uncovers the bishop's check at the same time. Double "
      + "check: no interposition and no capture answers it, the king has to move, and the rook "
      + "on e7 falls. Subtype double_check, same family and same event type.",
  },
  {
    id: "discovered_attack/knight-steps-off-the-diagonal-black",
    family: "discovered_attack",
    shape: "positive",
    fen: "b2k4/8/8/3n4/8/8/4R1K1/8 b - - 0 1",
    move: "d5c3",
    expectLegal: true,
    subjectColor: "black",
    expectation:
      "The colour-reversed twin: Nc3 vacates the a8-h1 diagonal, the bishop on a8 checks the "
      + "king on g2, and the knight lands attacking the rook on e2.",
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
    fen: "3k4/8/2p5/3n4/1N6/8/8/3RK3 w - - 0 1",
    move: "b4c6",
    expectLegal: true,
    subjectColor: "white",
    expectation:
      "Nxc6 takes the only defender of the knight on d5, which is pinned to the king on d8 by "
      + "the rook and so cannot run. Rxd5 follows whatever Black does. Written first with the "
      + "king on e8, where the knight simply moves away -- removing a guard wins nothing if what "
      + "it was guarding can walk off.",
  },
  {
    id: "removal_of_defender/capture-the-pawn-that-guards-black",
    family: "removal_of_defender",
    shape: "positive",
    fen: "3kr3/8/8/6n1/4N3/5P2/8/4K3 b - - 0 1",
    move: "g5f3",
    expectLegal: true,
    subjectColor: "black",
    expectation: "The colour-reversed removal: Nxf3 removes the knight on e4's only guard.",
  },
  {
    id: "removal_of_defender/target-has-a-second-defender",
    family: "removal_of_defender",
    shape: "refuted_geometry",
    fen: "3k4/8/2p1p3/3n4/1N6/8/8/3RK3 w - - 0 1",
    move: "b4c6",
    expectLegal: true,
    subjectColor: "white",
    expectation:
      "The pawn on e6 also guards d5, so removing the c6 pawn wins nothing: Rxd5 is answered by "
      + "exd5. The duty was shared, and a shared duty is not removed by taking one holder of it.",
  },

  // -------------------------------------------------------------------------
  // trapped_piece
  // -------------------------------------------------------------------------
  {
    id: "trapped_piece/knight-in-the-corner",
    family: "trapped_piece",
    shape: "positive",
    fen: "n7/8/2B5/PP6/7k/8/8/4K3 w - - 0 1",
    move: "b5b6",
    expectLegal: true,
    subjectColor: "white",
    expectation:
      "b6 takes c7 away from the knight on a8 while the a5 pawn covers b6, and the bishop on c6 "
      + "attacks a8 so staying loses it too. Nxb6 axb6, Nc7 bxc7, anything else Bxa8. Written "
      + "first without the bishop, where the knight was merely restricted -- a piece nobody is "
      + "attacking has not been lost yet, however few squares it has.",
  },
  {
    id: "trapped_piece/knight-still-has-a-square",
    family: "trapped_piece",
    shape: "near_miss",
    fen: "n7/8/2B5/1P6/7k/8/8/4K3 w - - 0 1",
    move: "b5b6",
    expectLegal: true,
    subjectColor: "white",
    expectation:
      "Without the a5 pawn behind it, b6 is undefended and the knight takes it for free. "
      + "One escape is enough — the piece is not trapped, and this is a negative.",
  },
  {
    id: "trapped_piece/knight-in-the-corner-black",
    family: "trapped_piece",
    shape: "positive",
    fen: "3k4/8/8/K7/6pp/5b2/8/7N b - - 0 1",
    move: "g4g3",
    expectLegal: true,
    subjectColor: "black",
    expectation: "The colour-reversed trap: ...g3 removes the white knight's last safe square.",
  },

  // -------------------------------------------------------------------------
  // Contract-matrix evidence variants. Alternative and incomplete cases reuse
  // the positive board deliberately: the premise that changes is stored search
  // evidence, not geometry. Illegal cases use a genuinely pinned focal mover.
  // -------------------------------------------------------------------------
  ...[
    ["double_attack/stronger-follow-up", "double_attack", "alternative_better", "r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1", "b5c7", true,
      "The fork exists, but an acceptable stronger follow-up must abstain rather than fail."],
    ["double_attack/truncated-line", "double_attack", "incomplete_evidence", "r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1", "b5c7", true,
      "The fork exists, but a stored line shorter than its claim produces no row."],

    ["pin/stronger-follow-up", "pin", "alternative_better", "3k4/8/8/3n4/8/8/8/R6K w - - 0 1", "a1d1", true,
      "The pin exists, but an acceptable stronger follow-up must abstain rather than fail."],
    ["pin/pinner-is-pinned", "pin", "illegal_attacker", "r3k3/8/8/4n3/8/8/R7/K7 w - - 0 1", "a2e2", false,
      "The rook would create a pin on the e-file, but it is pinned to its own king on a1."],
    ["pin/truncated-line", "pin", "incomplete_evidence", "3k4/8/8/3n4/8/8/8/R6K w - - 0 1", "a1d1", true,
      "The pin exists, but a stored line shorter than its claim produces no row."],

    ["skewer/one-square-short", "skewer", "near_miss", "8/4r3/8/8/4k3/8/8/R6K w - - 0 1", "a1a2", true,
      "Ra2 does not land on the king and rook's e-file, so no skewer is created."],
    ["skewer/stronger-follow-up", "skewer", "alternative_better", "8/4r3/8/8/4k3/8/8/R6K w - - 0 1", "a1e1", true,
      "The skewer exists, but an acceptable stronger follow-up must abstain rather than fail."],
    ["skewer/skewering-rook-is-pinned", "skewer", "illegal_attacker", "r3r3/8/8/4k3/8/8/R7/K7 w - - 0 1", "a2e2", false,
      "The rook would skewer on the e-file, but moving it exposes its own king on a1."],
    ["skewer/truncated-line", "skewer", "incomplete_evidence", "8/4r3/8/8/4k3/8/8/R6K w - - 0 1", "a1e1", true,
      "The skewer exists, but a stored line shorter than its claim produces no row."],

    ["discovered_attack/equal-payoff", "discovered_attack", "refuted_geometry", "8/2n3k1/8/8/3N4/8/8/B6K w - - 0 1", "d4b5", true,
      "The line opens with check, but the mover attacks only an equal knight; no material is won."],
    ["discovered_attack/stronger-follow-up", "discovered_attack", "alternative_better", "8/2r3k1/8/8/3N4/8/8/B6K w - - 0 1", "d4b5", true,
      "The discovery exists, but an acceptable stronger follow-up must abstain rather than fail."],
    ["discovered_attack/mover-is-pinned", "discovered_attack", "illegal_attacker", "3r4/2r3k1/8/8/3N4/8/8/B2K4 w - - 0 1", "d4b5", false,
      "The knight would uncover the bishop, but it is pinned to the king on d1."],
    ["discovered_attack/truncated-line", "discovered_attack", "incomplete_evidence", "8/2r3k1/8/8/3N4/8/8/B6K w - - 0 1", "d4b5", true,
      "The discovery exists, but a stored line shorter than its claim produces no row."],

    ["removal_of_defender/guard-not-touched", "removal_of_defender", "near_miss", "3k4/8/2p5/3n4/1N6/8/8/3RK3 w - - 0 1", "b4a6", true,
      "Na6 neither captures nor deflects the pawn on c6, so its duty remains."],
    ["removal_of_defender/stronger-follow-up", "removal_of_defender", "alternative_better", "3k4/8/2p5/3n4/1N6/8/8/3RK3 w - - 0 1", "b4c6", true,
      "The guard is removed, but an acceptable stronger follow-up must abstain rather than fail."],
    ["removal_of_defender/remover-is-pinned", "removal_of_defender", "illegal_attacker", "1r1k4/2p5/8/1N1n4/8/8/8/1K1R4 w - - 0 1", "b5c7", false,
      "The knight would capture the guard on c7, but it is pinned to the king on b1."],
    ["removal_of_defender/truncated-line", "removal_of_defender", "incomplete_evidence", "3k4/8/2p5/3n4/1N6/8/8/3RK3 w - - 0 1", "b4c6", true,
      "The guard is removed, but a stored line shorter than its claim produces no row."],

    ["trapped_piece/restriction-does-not-win", "trapped_piece", "refuted_geometry", "n7/8/2B5/1P6/7k/8/8/4K3 w - - 0 1", "b5b6", true,
      "The knight is restricted but can capture b6 safely, so the geometry is refuted."],
    ["trapped_piece/stronger-follow-up", "trapped_piece", "alternative_better", "n7/8/2B5/PP6/7k/8/8/4K3 w - - 0 1", "b5b6", true,
      "The trap exists, but an acceptable stronger follow-up must abstain rather than fail."],
    ["trapped_piece/restricting-pawn-is-pinned", "trapped_piece", "illegal_attacker", "n7/8/b1B5/PP6/7k/8/4K3/8 w - - 0 1", "b5b6", false,
      "The pawn would remove the knight's last square, but moving exposes the king on e2."],
    ["trapped_piece/truncated-line", "trapped_piece", "incomplete_evidence", "n7/8/2B5/PP6/7k/8/8/4K3 w - - 0 1", "b5b6", true,
      "The trap exists, but a stored line shorter than its claim produces no row."],
  ].map(([id, family, shape, fen, move, expectLegal, expectation]) => ({
    id,
    family,
    shape,
    fen,
    move,
    expectLegal,
    subjectColor: "white" as const,
    expectation,
  } as ConceptFixture)),
]);

export function fixturesFor(family: string): readonly ConceptFixture[] {
  return CONCEPT_FIXTURES.filter((fixture) => fixture.family === family);
}

export function fixturesOfShape(shape: FixtureShape): readonly ConceptFixture[] {
  return CONCEPT_FIXTURES.filter((fixture) => fixture.shape === shape);
}
