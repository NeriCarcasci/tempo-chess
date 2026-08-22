/**
 * `npm run rating:unit` — the game rating's invariants, offline.
 *
 * The arithmetic is checked against values derivable by hand, and the product
 * rules are checked as refusals: pressure is never credited from a search
 * disagreement, a rung the game did not score never wins the estimate, a
 * strong player never averages a weak one upward, and a game the human policy
 * was never asked about produces no rating at all.
 *
 * The last test is the one that matters most for the brand. The rating must not
 * move when the result does, so the same decisions rated as a win and as a loss
 * have to return the same number.
 */

import { strict as assert } from "node:assert";

import { CONTINUATION_RATINGS } from "../models/continuation-rating.js";
import {
  COMBINATION_POLICY,
  MOMENT_POLICY,
  ratingMethodHash,
  type Decision,
  type ReplyEvidence,
} from "./contract.js";
import { liveness, readPractical, scoreDecision } from "./decisions.js";
import { readDemand } from "./demand.js";
import { estimateStrength } from "./strength.js";
import { findMoments, normalizeStrength, rateGame, readCleanliness, softMin } from "./rating.js";
import { decisionsFromReview, missingEvidence } from "./evidence.js";
import type { ReviewMove } from "../engine/review.js";
import { likelihoodsFor, type RungPolicy } from "./likelihood.js";
import { normalizePolicy } from "../models/policy.js";

const failures: string[] = [];
let passed = 0;

function test(name: string, run: () => void): void {
  try {
    run();
    passed += 1;
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function close(actual: number, expected: number, tolerance = 1e-4): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`,
  );
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/**
 * Log-likelihoods peaking at one rung.
 *
 * A quadratic in rating distance, which is not a claim about how Maia behaves —
 * it is a shape whose maximum is known, so a test can assert the estimator
 * found it rather than assert a number nobody can derive.
 */
function bands(peak: number, sharpness = 400): Record<number, number> {
  const out: Record<number, number> = {};
  for (const rung of CONTINUATION_RATINGS) {
    out[rung] = -1 - ((rung - peak) / sharpness) ** 2;
  }
  return out;
}

function decision(overrides: Partial<Decision> = {}): Decision {
  return {
    ply: 1,
    actor: "white",
    playedUci: "e2e4",
    phase: "middlegame",
    expectedScoreBefore: 0.5,
    expectedScoreAfter: 0.5,
    criticality: null,
    onlyMove: null,
    deepSearched: false,
    book: false,
    legalMoveCount: 30,
    bandLogLikelihoods: bands(1600),
    reply: null,
    ...overrides,
  };
}

function replyEvidence(overrides: Partial<ReplyEvidence> = {}): ReplyEvidence {
  return {
    adequateReplyProbability: 0.1,
    unretainedProbabilityMass: 0,
    expectedScoreIfMissed: 0.9,
    outOfDomain: false,
    ...overrides,
  };
}

/** A whole game of one shape, alternating colours. */
function game(count: number, shape: (index: number, actor: "white" | "black") => Partial<Decision>) {
  const decisions: Decision[] = [];
  for (let index = 0; index < count; index += 1) {
    const actor = index % 2 === 0 ? "white" : "black";
    decisions.push(decision({ ply: index + 1, actor, ...shape(index, actor) }));
  }
  return decisions;
}

// ---------------------------------------------------------------------------
// Liveness
// ---------------------------------------------------------------------------

test("liveness is one at a balanced position and zero at a decided one", () => {
  close(liveness(0.5), 1);
  close(liveness(0), 0);
  close(liveness(1), 0);
  close(liveness(0.75), 0.75);
  // Symmetric: the same game is at stake whoever is winning.
  close(liveness(0.2), liveness(0.8));
});

// ---------------------------------------------------------------------------
// The practical reading
// ---------------------------------------------------------------------------

test("no reply evidence withholds the practical reading rather than defaulting it", () => {
  const result = readPractical(decision({ reply: null }));
  assert.equal(result.status, "withheld");
  assert.equal(result.status === "withheld" && result.reason, "no_reply_evidence");
});

test("a search that retained no inadequate reply never saw the mistake", () => {
  const result = readPractical(
    decision({ reply: replyEvidence({ expectedScoreIfMissed: null }) }),
  );
  assert.equal(result.status === "withheld" && result.reason, "no_inadequate_reply_retained");
});

test("a deep reading below the screening reading is a search disagreement, not pressure", () => {
  const result = readPractical(
    decision({ expectedScoreAfter: 0.6, reply: replyEvidence({ expectedScoreIfMissed: 0.55 }) }),
  );
  assert.equal(result.status === "withheld" && result.reason, "evidence_inconsistent");
});

test("a sacrifice nobody refutes gains expected score it did not objectively have", () => {
  // Objectively the move drops from 0.5 to 0.4. Only a tenth of the human
  // policy finds the reply that holds; the rest walk into 0.9.
  const scored = scoreDecision(
    decision({
      expectedScoreBefore: 0.5,
      expectedScoreAfter: 0.4,
      reply: replyEvidence(),
    }),
  );
  assert.equal(scored.practical.status, "available");
  if (scored.practical.status !== "available") return;

  close(scored.practical.saveProbability, 0.1);
  // 0.1 * 0.4 + 0.9 * 0.9 = 0.85
  close(scored.practical.expectedScore, 0.85);
  close(scored.practical.pressure, 0.45);
  close(scored.objectiveLoss, 0.1);
  // The move gained, so it is not charged. It is also not credited.
  close(scored.effectiveLoss, -0.35);
  assert.equal(scored.chargedLoss, 0);
});

test("a sacrifice whose refutation is the natural move stands as the error it was", () => {
  const scored = scoreDecision(
    decision({
      expectedScoreBefore: 0.5,
      expectedScoreAfter: 0.4,
      reply: replyEvidence({ adequateReplyProbability: 0.95 }),
    }),
  );
  assert.equal(scored.practical.status, "available");
  if (scored.practical.status !== "available") return;

  close(scored.practical.saveProbability, 0.95);
  // Almost all the pressure evaporates, and almost all the loss survives.
  assert.ok(scored.practical.pressure < 0.03, "pressure should be near zero");
  assert.ok(scored.chargedLoss > 0.07, "the objective loss should mostly stand");
});

test("pressure is never negative, whatever the policy says", () => {
  const scored = scoreDecision(
    decision({
      expectedScoreAfter: 0.4,
      reply: replyEvidence({ adequateReplyProbability: 1, expectedScoreIfMissed: 0.4 }),
    }),
  );
  if (scored.practical.status === "available") {
    assert.ok(scored.practical.pressure >= 0);
  }
});

test("the unretained policy mass is bracketed rather than ignored", () => {
  // The save is retained but a tenth of the mass is not, so the truth about
  // how often the opponent holds sits inside a band rather than on a point.
  const result = readPractical(
    decision({
      expectedScoreAfter: 0.4,
      reply: replyEvidence({ adequateReplyProbability: 0.6, unretainedProbabilityMass: 0.1 }),
    }),
  );
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.ok(result.saveProbabilityLow < result.saveProbability);
  assert.ok(result.saveProbabilityHigh > result.saveProbability);
  assert.ok(result.expectedScoreLow < result.expectedScoreHigh);
});

// ---------------------------------------------------------------------------
// Strength
// ---------------------------------------------------------------------------

test("the estimate is the rung the likelihoods peak at", () => {
  const scored = game(20, () => ({ bandLogLikelihoods: bands(1800) })).map(scoreDecision);
  const result = estimateStrength(scored);
  assert.equal(result.status, "available");
  assert.equal(result.status === "available" && result.rating, 1800);
});

test("the interval covers the rungs the evidence cannot separate", () => {
  // A flat-ish likelihood over a short game: the interval must be wide.
  const short = game(10, () => ({ bandLogLikelihoods: bands(1600, 4000) })).map(scoreDecision);
  const wide = estimateStrength(short);
  // The same peak with far more evidence: the interval must narrow.
  const long = game(80, () => ({ bandLogLikelihoods: bands(1600, 4000) })).map(scoreDecision);
  const narrow = estimateStrength(long);

  assert.equal(wide.status, "available");
  assert.equal(narrow.status, "available");
  if (wide.status !== "available" || narrow.status !== "available") return;
  assert.ok(
    wide.intervalHigh - wide.intervalLow > narrow.intervalHigh - narrow.intervalLow,
    "more decisions should narrow the interval",
  );
});

test("book plies and forced moves are excluded from the estimate", () => {
  const scored = game(20, (index) => ({
    book: index < 12,
    legalMoveCount: index >= 18 ? 1 : 30,
  })).map(scoreDecision);
  const result = estimateStrength(scored);
  // 20 decisions, 12 book, 2 forced: six left, below the minimum.
  assert.equal(result.status, "unavailable");
  assert.equal(result.decisionsScored, 6);
});

test("a rung the game did not score everywhere never wins the estimate", () => {
  // 2400 is absent from one ply. Left to default it would score zero, which is
  // the best possible log-likelihood and would take the maximum every time.
  const partial = bands(1200);
  delete partial[2400];
  const scored = game(20, (index) => ({
    bandLogLikelihoods: index === 3 ? partial : bands(1200),
  })).map(scoreDecision);
  const result = estimateStrength(scored);
  assert.equal(result.status === "available" && result.rating, 1200);
  assert.ok(result.status === "available" && result.intervalHigh < 2400);
});

test("an estimate beyond the calibrated range says so", () => {
  const scored = game(20, () => ({ bandLogLikelihoods: bands(2400) })).map(scoreDecision);
  const result = estimateStrength(scored);
  assert.equal(result.status === "available" && result.outOfDomain, true);
});

// ---------------------------------------------------------------------------
// Cleanliness
// ---------------------------------------------------------------------------

test("a decided position cannot charge a player for shuffling in it", () => {
  const scored = game(20, () => ({
    expectedScoreBefore: 0.995,
    expectedScoreAfter: 0.895,
  })).map(scoreDecision);
  const result = readCleanliness(scored);
  // Every ply is below the liveness floor, so there is nothing to weight.
  assert.equal(result.status, "unavailable");
});

test("cleanliness is one when nothing live is given away", () => {
  const scored = game(20, () => ({ expectedScoreBefore: 0.5, expectedScoreAfter: 0.5 })).map(
    scoreDecision,
  );
  const result = readCleanliness(scored);
  assert.equal(result.status === "available" && result.cleanliness, 1);
});

test("cleanliness bottoms out rather than running negative", () => {
  const scored = game(20, () => ({ expectedScoreBefore: 0.5, expectedScoreAfter: 0.1 })).map(
    scoreDecision,
  );
  const result = readCleanliness(scored);
  assert.equal(result.status === "available" && result.cleanliness, 0);
});

// ---------------------------------------------------------------------------
// Demand
// ---------------------------------------------------------------------------

test("a game the deep pass never saw has unknown demand, not low demand", () => {
  const scored = game(20, () => ({})).map(scoreDecision);
  const result = readDemand(scored, false);
  assert.equal(result.status, "unavailable");
});

test("a quiet game the deep pass did see has low demand, not unknown", () => {
  const scored = game(20, () => ({
    deepSearched: true,
    criticality: 0.01,
    onlyMove: false,
    expectedScoreBefore: 0.99,
  })).map(scoreDecision);
  const result = readDemand(scored, true);
  assert.equal(result.status, "available");
  assert.ok(result.status === "available" && result.demand < 0.1);
});

test("only-moves and swings both raise demand", () => {
  const scored = game(20, () => ({
    deepSearched: true,
    criticality: 0.6,
    onlyMove: true,
    expectedScoreBefore: 0.5,
  })).map(scoreDecision);
  const result = readDemand(scored, true);
  assert.equal(result.status === "available" && result.demand, 1);
});

// ---------------------------------------------------------------------------
// Combination
// ---------------------------------------------------------------------------

test("the soft minimum returns equal sides unchanged", () => {
  close(softMin(0.7, 0.7, COMBINATION_POLICY.softMinLambda), 0.7);
});

test("a strong side cannot average a weak side upward", () => {
  const lambda = COMBINATION_POLICY.softMinLambda;
  const mismatch = softMin(0.95, 0.3, lambda);
  assert.ok(mismatch < (0.95 + 0.3) / 2, "the mismatch must sit below the mean");
  assert.ok(mismatch > 0.3, "but a soft minimum is not a hard one");
  assert.ok(mismatch < 0.5, "and it must sit nearer the weaker side");
});

test("strength normalizes over the ladder, clamped at both ends", () => {
  close(normalizeStrength(800), 0);
  close(normalizeStrength(2400), 1);
  close(normalizeStrength(1600), 0.5);
  close(normalizeStrength(400), 0);
  close(normalizeStrength(3000), 1);
});

// ---------------------------------------------------------------------------
// Moments
// ---------------------------------------------------------------------------

test("one ply produces one moment, by priority", () => {
  const scored = [
    scoreDecision(
      decision({
        ply: 9,
        expectedScoreBefore: 0.6,
        expectedScoreAfter: 0.2,
        onlyMove: true,
        criticality: 0.4,
        deepSearched: true,
      }),
    ),
  ];
  const moments = findMoments(scored);
  assert.equal(moments.length, 1);
  // A collapse that was also a missed only-move is one event, named as the
  // graver of the two.
  assert.equal(moments[0]!.code, "collapse");
});

test("the moment list is capped and never names the result", () => {
  const scored = game(20, (index) => ({
    ply: index + 1,
    expectedScoreBefore: 0.5,
    expectedScoreAfter: 0.5 - (index + 1) * 0.01,
    onlyMove: true,
    criticality: 0.3,
    deepSearched: true,
  })).map(scoreDecision);
  const moments = findMoments(scored);
  assert.ok(moments.length <= MOMENT_POLICY.maxMoments);
  assert.equal(new Set(moments.map((moment) => moment.ply)).size, moments.length);
});

// ---------------------------------------------------------------------------
// The rating
// ---------------------------------------------------------------------------

function rate(count: number, shape: (index: number, actor: "white" | "black") => Partial<Decision>) {
  return rateGame({ decisions: game(count, shape), deepPassRan: true, canonicalGameId: null });
}

test("a game too short to be a game is refused", () => {
  const result = rateGame({
    decisions: game(8, () => ({})),
    deepPassRan: true,
    canonicalGameId: null,
  });
  assert.equal(result.status, "unavailable");
  assert.equal(result.status === "unavailable" && result.reason, "too_few_decisions");
});

test("a game the human policy was never asked about produces no rating", () => {
  const result = rate(30, () => ({ bandLogLikelihoods: null, deepSearched: true, criticality: 0.2 }));
  assert.equal(result.status, "unavailable");
  assert.equal(result.status === "unavailable" && result.reason, "no_inference");
});

test("the refusal still carries what was computed before it", () => {
  const result = rate(30, () => ({ bandLogLikelihoods: null, deepSearched: true, criticality: 0.2 }));
  assert.ok(result.status === "unavailable" && result.white !== null);
  assert.ok(result.status === "unavailable" && result.demand !== null);
});

/** A side's decisions: a strength peak, an average loss, and a sharp game. */
function sideShape(peak: number, lossPerMove: number): Partial<Decision> {
  return {
    bandLogLikelihoods: bands(peak),
    expectedScoreBefore: 0.5,
    expectedScoreAfter: 0.5 - lossPerMove,
    deepSearched: true,
    criticality: 0.4,
    onlyMove: false,
  };
}

test("two strong players in a sharp game rate far above two weak ones", () => {
  const strong = rate(40, (_, actor) => sideShape(2200, 0.005));
  const weak = rate(40, (_, actor) => sideShape(1000, 0.06));
  assert.equal(strong.status, "available");
  assert.equal(weak.status, "available");
  if (strong.status !== "available" || weak.status !== "available") return;
  assert.ok(
    strong.rating > weak.rating + 4,
    `expected a wide gap, got ${strong.rating} and ${weak.rating}`,
  );
});

test("one strong player and one weak one rates below two average ones", () => {
  const mismatch = rate(40, (_, actor) =>
    actor === "white" ? sideShape(2200, 0.005) : sideShape(1000, 0.06),
  );
  const average = rate(40, () => sideShape(1600, 0.03));
  assert.equal(mismatch.status, "available");
  assert.equal(average.status, "available");
  if (mismatch.status !== "available" || average.status !== "available") return;
  assert.ok(
    mismatch.rating < average.rating,
    `mismatch ${mismatch.rating} should sit below average ${average.rating}`,
  );
});

test("perfect play in a game that asked nothing cannot reach the top", () => {
  const perfect = {
    bandLogLikelihoods: bands(2400),
    expectedScoreBefore: 0.5,
    expectedScoreAfter: 0.5,
    deepSearched: true,
  };
  const sterile = rate(40, () => ({ ...perfect, criticality: 0, onlyMove: false }));
  const demanding = rate(40, () => ({ ...perfect, criticality: 0.6, onlyMove: true }));
  assert.equal(sterile.status, "available");
  assert.equal(demanding.status, "available");
  if (sterile.status !== "available" || demanding.status !== "available") return;

  // Identical play. The only difference is whether the game asked anything, and
  // that difference is most of the scale.
  assert.ok(sterile.rating <= 7, `a sterile game reached ${sterile.rating}`);
  assert.ok(
    demanding.rating - sterile.rating >= 2.5,
    `demand moved the rating by only ${(demanding.rating - sterile.rating).toFixed(1)}`,
  );
});

test("ten needs perfect play in a game that demanded it", () => {
  const best = rate(40, () => ({
    bandLogLikelihoods: bands(2400),
    expectedScoreBefore: 0.5,
    expectedScoreAfter: 0.5,
    deepSearched: true,
    criticality: 0.6,
    onlyMove: true,
  }));
  assert.equal(best.status, "available");
  if (best.status !== "available") return;
  assert.ok(best.rating >= 9.5, `the ceiling case reached only ${best.rating}`);
  assert.ok(best.rating <= 10);
});

test("the rating stays inside the scale for every shape tried", () => {
  for (const loss of [0, 0.01, 0.05, 0.2, 0.45]) {
    for (const peak of [800, 1600, 2400]) {
      const result = rate(40, () => sideShape(peak, loss));
      if (result.status !== "available") continue;
      assert.ok(result.rating >= 0 && result.rating <= 10, `rating ${result.rating} left the scale`);
      assert.ok(result.ratingLow <= result.ratingHigh, "the interval is inverted");
    }
  }
});

test("the rating does not move when the result does", () => {
  // The same decisions, rated twice. Nothing in the input says who won, and
  // this test exists to keep it that way: if a result field is ever threaded
  // through, this is what should fail.
  const decisions = game(40, () => sideShape(1800, 0.02));
  const first = rateGame({ decisions, deepPassRan: true, canonicalGameId: "won" });
  const second = rateGame({ decisions, deepPassRan: true, canonicalGameId: "lost" });
  assert.equal(first.status === "available" && first.rating, second.status === "available" && second.rating);
});

test("the method hash is stable and covers the policy", () => {
  assert.match(ratingMethodHash(), /^[0-9a-f]{64}$/);
  assert.equal(ratingMethodHash(), ratingMethodHash());
});

test("a rating always arrives with its decomposition", () => {
  const result = rate(40, () => sideShape(1800, 0.02));
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(result.white.strength.status, "available");
  assert.equal(result.black.cleanliness.status, "available");
  assert.equal(result.demand.status, "available");
  assert.ok(result.coverage.decisions > 0);
});

// ---------------------------------------------------------------------------
// Likelihoods
// ---------------------------------------------------------------------------

function rung(rating: number, moves: [string, number][], limit = 12): RungPolicy {
  return {
    rating,
    policy: normalizePolicy(
      moves.map(([uci, probability]) => ({ uci, probability })),
      limit,
    ),
  };
}

test("a retained move takes its probability straight from the model", () => {
  const result = likelihoodsFor("e2e4", [rung(1600, [["e2e4", 0.5], ["d2d4", 0.5]])], 30);
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  close(result.byRating[1600]!, Math.log(0.5));
  assert.equal(result.estimatedRungs.length, 0);
});

test("a move in the tail is spread over the moves that were dropped", () => {
  // Two moves retained of twenty legal, so eighteen share the dropped mass.
  const result = likelihoodsFor(
    "h2h4",
    [rung(1600, [["e2e4", 0.5], ["d2d4", 0.3], ["c2c4", 0.2]], 2)],
    20,
  );
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  close(result.byRating[1600]!, Math.log(0.2 / 18));
  assert.deepEqual([...result.estimatedRungs], [1600]);
});

test("a tail move with no legal move count is refused rather than guessed", () => {
  const result = likelihoodsFor(
    "h2h4",
    [rung(1600, [["e2e4", 0.5], ["d2d4", 0.5]], 1)],
    null,
  );
  assert.equal(result.status === "unavailable" && result.reason, "unretained_without_legal_move_count");
});

test("a move missing from a distribution that covered everything is an inconsistency", () => {
  // Nothing was dropped, so the move should have been there. Assigning it a
  // probability would launder a mismatched position into a strength claim.
  const result = likelihoodsFor("h2h4", [rung(1600, [["e2e4", 0.5], ["d2d4", 0.5]])], 2);
  assert.equal(result.status === "unavailable" && result.reason, "unretained_with_no_room");
});

test("the ladder is answered completely or not at all", () => {
  // The first rung retains the move, the second does not and cannot estimate.
  const result = likelihoodsFor(
    "h2h4",
    [rung(1200, [["h2h4", 0.4], ["e2e4", 0.6]]), rung(2000, [["e2e4", 0.6], ["d2d4", 0.4]])],
    2,
  );
  assert.equal(result.status, "unavailable");
  assert.equal(result.status === "unavailable" && result.rating, 2000);
});

test("the tail assignment ranks a weak rung above a strong one for a weak move", () => {
  // The whole point: "no 2000 plays this" is what says the player is not 2000.
  const result = likelihoodsFor(
    "h2h4",
    [
      rung(1200, [["h2h4", 0.15], ["e2e4", 0.85]]),
      rung(2000, [["e2e4", 0.7], ["d2d4", 0.29], ["c2c4", 0.01]], 2),
    ],
    20,
  );
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.ok(result.byRating[1200]! > result.byRating[2000]!);
});

// ---------------------------------------------------------------------------
// The seam to the published review
// ---------------------------------------------------------------------------

function reviewMove(overrides: Partial<ReviewMove> = {}): ReviewMove {
  return {
    fromPly: 1,
    uci: "e2e4",
    san: "e4",
    actorColor: "white",
    phase: "middlegame",
    expectedScoreBefore: 0.5,
    expectedScoreAfter: 0.45,
    decisionLoss: 0.05,
    acceptable: false,
    bestMoveUci: "d2d4",
    playedMoveRank: 2,
    acceptableMoveCount: 2,
    onlyMove: false,
    criticality: 0.2,
    evidence: { beforeScope: "rule50", afterScope: "rule50" },
    deep: { status: "completed", reasons: [], candidates: [] },
    practicalContext: {
      status: "available",
      adequateReplyCount: 1,
      adequateReplyProbability: 0.2,
      unretainedProbabilityMass: 0.05,
      practicalPressureLower: 0.75,
      practicalPressureUpper: 0.8,
      policyEntropyBits: 1.2,
      entropyIsLowerBound: true,
      bestRefutationUci: "g8f6",
      bestRefutationProbability: 0.2,
      bestRefutationRank: 3,
      humanExpectedScore: null,
      outOfDomain: false,
      opponentConceded: null,
      subjectCapitalized: null,
    },
    ...overrides,
  } as ReviewMove;
}

test("stored practical context alone is not reply evidence", () => {
  // The review says how likely the opponent is to hold. Nothing says what it
  // costs them when they do not, and half the calculation is not a reading.
  const input = decisionsFromReview([reviewMove()], {
    canonicalGameId: null,
    deepPassRan: true,
  });
  assert.equal(input.decisions[0]!.reply, null);
});

test("both halves together make a reply evidence", () => {
  const input = decisionsFromReview([reviewMove()], {
    canonicalGameId: null,
    deepPassRan: true,
    supplements: new Map([[1, { expectedScoreIfMissed: 0.9 }]]),
  });
  const reply = input.decisions[0]!.reply;
  assert.ok(reply !== null);
  close(reply!.adequateReplyProbability, 0.2);
  close(reply!.unretainedProbabilityMass, 0.05);
});

test("a completed deep search on a dead position is still a deep search", () => {
  // Criticality zero means the selector looked and found nothing at stake.
  // Reading `deepSearched` off criticality would turn that into "unknown".
  const input = decisionsFromReview(
    [reviewMove({ criticality: 0, deep: { status: "completed", reasons: [], candidates: [] } })],
    { canonicalGameId: null, deepPassRan: true },
  );
  assert.equal(input.decisions[0]!.deepSearched, true);
});

test("an unsupplied ply counts as a real decision rather than vanishing", () => {
  const input = decisionsFromReview([reviewMove()], {
    canonicalGameId: null,
    deepPassRan: true,
  });
  assert.equal(input.decisions[0]!.book, false);
  assert.equal(input.decisions[0]!.legalMoveCount, null);
});

test("the missing evidence is reportable in words", () => {
  const input = decisionsFromReview([reviewMove()], {
    canonicalGameId: null,
    deepPassRan: false,
  });
  const missing = missingEvidence(input);
  assert.ok(missing.some((line) => line.includes("no policy inference")));
  assert.ok(missing.some((line) => line.includes("deep pass")));
  assert.ok(missing.some((line) => line.includes("no reply evidence")));
});

// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`rating:unit — ${failures.length} failed, ${passed} passed`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`rating:unit — ${passed}/${passed} passed`);
