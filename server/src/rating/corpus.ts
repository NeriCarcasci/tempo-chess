/**
 * The calibration corpus: what the scale is supposed to say, written down.
 *
 * The formula is cheap to change and a published verdict is not. Once Forma has
 * told a stranger that a famous game is a 6.2, it has told them; so the
 * orderings here are the deliverable that guards the number, and they were
 * written from intent rather than read off the scorer's output. Where the
 * scorer disagrees with them, the policy moves, not the corpus.
 *
 * Two tiers, because they answer different questions.
 *
 * **Archetypes** are constructed decision streams. They test the *formula*: that
 * a mismatch sits below two average players, that demand is most of the
 * distance between a sterile game and a sharp one, that a sacrifice nobody
 * refutes is not charged as an error. They need no engine and no database, so
 * they run on every commit and fail the moment a constant is nudged carelessly.
 *
 * **Games** are real, named, and human-checkable. They test the *scale*: that
 * the ordering the formula produces is the ordering a strong player would
 * recognise. They need the pipeline's evidence, so the gate reports them as
 * pending until it is supplied rather than passing over them in silence. A gate
 * that quietly skips the half it cannot run is a gate that says everything is
 * fine.
 */

import { CONTINUATION_RATINGS } from "../models/continuation-rating.js";
import type { Color, Decision, GameRatingInput } from "./contract.js";

// ---------------------------------------------------------------------------
// Constructing a game
// ---------------------------------------------------------------------------

/**
 * Log-likelihoods peaking at one rung.
 *
 * Not a model of Maia. A shape whose maximum is known, so a corpus entry can
 * say "this side played like an 1800" and mean something the estimator can be
 * held to.
 */
function bands(peak: number): Record<number, number> {
  const out: Record<number, number> = {};
  for (const rung of CONTINUATION_RATINGS) out[rung] = -1 - ((rung - peak) / 400) ** 2;
  return out;
}

export interface SideSpec {
  /** The rung this side's choices look like. */
  plays: number;
  /** Expected score given away per decision, against best play. */
  lossPerMove: number;
  /**
   * Decisions on which this side plays a move the engine dislikes into a
   * position the opponent is unlikely to solve. The Tal case.
   */
  sacrifices?: {
    count: number;
    /** Objective expected score the sacrifice costs. */
    costs: number;
    /** Policy mass the opponent puts on the reply that holds. */
    opponentFindsIt: number;
    /** Actor-perspective value when the opponent does not hold. */
    ifMissed: number;
  };
}

export interface GameSpec {
  decisions: number;
  /** Expected score before each decision: 0.5 is a live game. */
  balance: number;
  /** Criticality at the deep-selected positions. */
  criticality: number;
  /** Share of deep-selected positions that were only-moves. */
  onlyMoveRate: number;
  /** Deep-selected positions in the game, capped by the selector at twelve. */
  deepPositions: number;
  white: SideSpec;
  black: SideSpec;
}

export function buildGame(spec: GameSpec): GameRatingInput {
  const decisions: Decision[] = [];
  const deepEvery = Math.max(1, Math.floor(spec.decisions / Math.max(1, spec.deepPositions)));
  let deepSeen = 0;
  const sacrificesLeft: Record<Color, number> = {
    white: spec.white.sacrifices?.count ?? 0,
    black: spec.black.sacrifices?.count ?? 0,
  };

  for (let index = 0; index < spec.decisions; index += 1) {
    const actor: Color = index % 2 === 0 ? "white" : "black";
    const side = actor === "white" ? spec.white : spec.black;

    const deepSearched = index % deepEvery === 0 && deepSeen < spec.deepPositions;
    if (deepSearched) deepSeen += 1;
    const onlyMove = deepSearched ? deepSeen <= spec.deepPositions * spec.onlyMoveRate : null;

    const sacrifice = side.sacrifices && sacrificesLeft[actor] > 0 ? side.sacrifices : null;
    if (sacrifice) sacrificesLeft[actor] -= 1;

    const loss = sacrifice ? sacrifice.costs : side.lossPerMove;

    decisions.push({
      ply: index + 1,
      actor,
      playedUci: "e2e4",
      phase: "middlegame",
      expectedScoreBefore: spec.balance,
      expectedScoreAfter: spec.balance - loss,
      criticality: deepSearched ? spec.criticality : null,
      onlyMove,
      deepSearched,
      book: false,
      legalMoveCount: 30,
      bandLogLikelihoods: bands(side.plays),
      reply: sacrifice
        ? {
            adequateReplyProbability: sacrifice.opponentFindsIt,
            unretainedProbabilityMass: 0,
            expectedScoreIfMissed: sacrifice.ifMissed,
            outOfDomain: false,
          }
        : null,
    });
  }

  return { decisions, deepPassRan: true, canonicalGameId: null };
}

// ---------------------------------------------------------------------------
// Archetypes
// ---------------------------------------------------------------------------

export interface Archetype {
  key: string;
  /** What a reader should understand this game to be. */
  description: string;
  spec: GameSpec;
}

/**
 * Ordered best to worst, and the order is the assertion.
 *
 * Three of these encode judgements worth stating out loud, because they are the
 * ones somebody will argue with:
 *
 * - `brilliancy` sits above `strong_grind`. A game carrying a sacrifice that
 *   held up in practice is a better game than a clean quiet one between the
 *   same players, and the metric should say so without being told about
 *   beauty.
 * - `sterile_draw` sits above `club_sharp`. Perfect play in a game that asked
 *   nothing still beats messy play in a game that asked plenty. The demand term
 *   costs the sterile game most of the scale, but it does not put it below a
 *   game full of errors.
 * - `mismatch` sits below `club_sharp`. Half the moves in that game were bad
 *   moves, and no strength on the other side buys them back.
 */
/**
 * Loss values are measured, not imagined.
 *
 * The first set assumed a club player gives away about 0.03 expected score per
 * live move. A rated 1550 pair on the live path gave away 0.084 and 0.114, and
 * Capablanca gave away 0.004. So the old `mutual_collapse`, meant to be two
 * players trading blunders, was cleaner than a real club game, and every
 * ordering below it was fitted to a fantasy.
 */
export const ARCHETYPES: readonly Archetype[] = [
  {
    key: "masterpiece",
    description: "Two masters, near-flawless, in a game that repeatedly demanded only-moves.",
    spec: {
      decisions: 70,
      balance: 0.5,
      criticality: 0.55,
      onlyMoveRate: 0.7,
      deepPositions: 12,
      white: { plays: 2400, lossPerMove: 0.003 },
      black: { plays: 2400, lossPerMove: 0.004 },
    },
  },
  {
    key: "brilliancy",
    description:
      "A master enters a long combination. The engine dislikes most of it; the opponent almost never finds the refutation.",
    spec: {
      decisions: 60,
      balance: 0.5,
      criticality: 0.5,
      onlyMoveRate: 0.5,
      deepPositions: 12,
      white: {
        plays: 2200,
        lossPerMove: 0.01,
        // Eight decisions inside one combination, a quarter of a point each.
        //
        // The count matters and the first attempt got it wrong. Four isolated
        // sacrifices wash out across thirty decisions, so an engine-only
        // reading still ranked the game correctly and the gate was proving
        // nothing. A real combination is a sequence — Kasparov–Topalov runs
        // fifteen moves the engine is unhappy about — and at that length the
        // engine-only reading condemns the game, which is the failure the
        // practical reading exists to reverse. The gate asserts the reversal.
        sacrifices: { count: 8, costs: 0.25, opponentFindsIt: 0.08, ifMissed: 0.92 },
      },
      black: { plays: 2200, lossPerMove: 0.012 },
    },
  },
  {
    key: "strong_grind",
    description: "Two strong players, clean, in a game with real but unspectacular tension.",
    spec: {
      decisions: 80,
      balance: 0.5,
      criticality: 0.25,
      onlyMoveRate: 0.2,
      deepPositions: 10,
      white: { plays: 2200, lossPerMove: 0.008 },
      black: { plays: 2200, lossPerMove: 0.009 },
    },
  },
  {
    key: "sterile_draw",
    description: "Two masters, perfect, in a game where nothing was ever at stake.",
    spec: {
      decisions: 40,
      balance: 0.5,
      criticality: 0.02,
      onlyMoveRate: 0,
      deepPositions: 4,
      white: { plays: 2400, lossPerMove: 0.001 },
      black: { plays: 2400, lossPerMove: 0.001 },
    },
  },
  {
    key: "club_sharp",
    description: "Two club players in a genuinely sharp game, both making real mistakes.",
    spec: {
      decisions: 60,
      balance: 0.5,
      criticality: 0.45,
      onlyMoveRate: 0.4,
      deepPositions: 12,
      white: { plays: 1600, lossPerMove: 0.08 },
      black: { plays: 1600, lossPerMove: 0.1 },
    },
  },
  {
    key: "mismatch",
    description: "A strong player against a weak one. Half the moves on the board are bad moves.",
    spec: {
      decisions: 50,
      balance: 0.5,
      criticality: 0.35,
      onlyMoveRate: 0.3,
      deepPositions: 10,
      white: { plays: 2200, lossPerMove: 0.01 },
      black: { plays: 1000, lossPerMove: 0.22 },
    },
  },
  {
    key: "mutual_collapse",
    description: "Two weak players trading blunders.",
    spec: {
      decisions: 50,
      balance: 0.5,
      criticality: 0.4,
      onlyMoveRate: 0.2,
      deepPositions: 10,
      white: { plays: 1000, lossPerMove: 0.25 },
      black: { plays: 1000, lossPerMove: 0.28 },
    },
  },
];

/**
 * Anchors the ordering alone cannot enforce.
 *
 * An ordering is satisfied by seven numbers crammed between 4.9 and 5.1, which
 * would be a scale that says nothing. These pin the ends and keep ten reserved
 * for something no constructed archetype is allowed to reach.
 */
export const ANCHORS = {
  masterpieceAtLeast: 9,
  mutualCollapseAtMost: 2,
  mismatchAtMost: 4,
  /** Nothing built by hand may claim the top of the scale. */
  nothingReaches: 10,
  /** The gap demand alone must open between identical play. */
  sterileBelowMasterpieceBy: 2.5,
  /**
   * What the practical reading must be worth on the brilliancy.
   *
   * This was once "it must overtake the quiet grind", on the belief that an
   * engine-only reading condemns a combination. Real data says otherwise: on
   * Kasparov against Topalov, the engine-only weighted loss for White is 0.0298
   * per live move, which is cleaner than a club game. A brilliancy is not
   * dragged to the bottom by an engine, because the sacrifices are few against a
   * whole game and much of what follows is already decided.
   *
   * So the correction is a real but modest effect on the headline, and a large
   * one on what individual moves are called. The assertion is now the thing that
   * is actually true, rather than the thing the first fixture was cranked up
   * until it showed.
   */
  practicalWorthAtLeast: 0.4,
} as const;

// ---------------------------------------------------------------------------
// Real games
// ---------------------------------------------------------------------------

export interface CorpusGame {
  key: string;
  /** How to find it: a Lichess study, a PGN in the fixtures, a game URL. */
  source: string;
  /** The band a strong player would expect, before we ran anything. */
  expected: readonly [number, number];
  note: string;
}

/**
 * The games the scale has to get right before a stranger sees it.
 *
 * Written down with expectations *first*, so the gate tests the formula rather
 * than fits it. The bands are wide on purpose: the claim is "this is a top game"
 * or "this is a poor one", not that anyone can tell 8.3 from 8.6.
 *
 * These have no evidence attached yet. The gate reports them as pending, with
 * the count, so the half that cannot run is visible rather than absent.
 */
export const CORPUS_GAMES: readonly CorpusGame[] = [
  {
    key: "kasparov-topalov-1999",
    source: "https://lichess.org/study — Wijk aan Zee 1999, round 4",
    expected: [8.5, 9.8],
    note: "The rook sacrifice is objectively unclear and practically overwhelming. If the practical reading works anywhere, it works here.",
  },
  {
    key: "byrne-fischer-1956",
    source: "Rosenwald Trophy, New York 1956",
    expected: [8, 9.5],
    note: "Fischer is 13 and the opponent is not weak. A metric that reads this as a mismatch is wrong.",
  },
  {
    key: "tal-larsen-1965",
    source: "Candidates semi-final, Bled 1965, game 10",
    expected: [7.5, 9.3],
    note: "The reference case for a sacrifice the engine dislikes and a grandmaster still could not answer.",
  },
  {
    key: "deep-blue-kasparov-1997-g6",
    source: "New York 1997, game 6",
    expected: [2, 5],
    note: "Nineteen moves and a known refuted sacrifice. Famous is not the same as well played, and the scale has to be able to say so.",
  },
  {
    key: "carlsen-caruana-2018-g12",
    source: "World Championship 2018, game 12",
    expected: [5, 7.5],
    note: "Clean, strong, and agreed drawn in a balanced position. The sterile-draw case with real players.",
  },
  {
    key: "amateur-1200-messy",
    source: "screened Lichess archive, to be pinned by fingerprint",
    expected: [1, 3.5],
    note: "Two 1200s, mutual blunders. The bottom anchor with real moves.",
  },
  {
    key: "amateur-1900-clean",
    source: "screened Lichess archive, to be pinned by fingerprint",
    expected: [3.5, 6],
    note: "A well-played club game. It must not reach the band the masterpieces occupy.",
  },
  {
    key: "mismatch-2100-vs-1100",
    source: "screened Lichess archive, to be pinned by fingerprint",
    expected: [1, 3.5],
    note: "The strong side plays well throughout. The rating still has to be low.",
  },
];
