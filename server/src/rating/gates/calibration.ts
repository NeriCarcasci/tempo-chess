/**
 * `npm run rating:calibration` — does the scale say what it is supposed to say?
 *
 * The unit tests check that the arithmetic is the arithmetic. This checks the
 * thing that actually protects the product: that a game a strong player would
 * call better rates higher than one they would call worse, and that the ends of
 * the scale mean what the copy says they mean.
 *
 * It fails loudly on the ordering and it *reports* on the real games rather
 * than skipping them, because a gate that silently passes over the half it
 * cannot run is a gate that says everything is fine.
 */

import {
  ANCHORS,
  ARCHETYPES,
  CORPUS_GAMES,
  buildGame,
  type Archetype,
} from "../corpus.js";
import { rateGame, type GameRating } from "../rating.js";
import { ratingMethodHash, RATING_METHOD } from "../contract.js";

const failures: string[] = [];

interface Scored {
  archetype: Archetype;
  rating: GameRating;
}

const scored: Scored[] = [];
for (const archetype of ARCHETYPES) {
  const result = rateGame(buildGame(archetype.spec));
  if (result.status !== "available") {
    failures.push(`${archetype.key}: rated unavailable (${result.reason})`);
    continue;
  }
  scored.push({ archetype, rating: result });
}

// ---------------------------------------------------------------------------
// The report comes first, so a failure is read with the numbers in view.
// ---------------------------------------------------------------------------

console.log(`game rating calibration — ${RATING_METHOD.key}/${RATING_METHOD.version}`);
console.log(`method hash ${ratingMethodHash().slice(0, 16)}`);
console.log("");
console.log("  rating  interval      quality  demand  white  black  archetype");
for (const entry of scored) {
  const { rating } = entry;
  const white = rating.white.strength.status === "available" ? rating.white.strength.rating : 0;
  const black = rating.black.strength.status === "available" ? rating.black.strength.rating : 0;
  console.log(
    `  ${rating.rating.toFixed(1).padStart(5)}` +
      `  ${`${rating.ratingLow.toFixed(1)}–${rating.ratingHigh.toFixed(1)}`.padStart(10)}` +
      `  ${rating.quality.toFixed(3).padStart(7)}` +
      `  ${(rating.demand.status === "available" ? rating.demand.demand : 0).toFixed(2).padStart(6)}` +
      `  ${String(white).padStart(5)}` +
      `  ${String(black).padStart(5)}` +
      `  ${entry.archetype.key}`,
  );
}
console.log("");

// ---------------------------------------------------------------------------
// The ordering
// ---------------------------------------------------------------------------

for (let index = 1; index < scored.length; index += 1) {
  const better = scored[index - 1]!;
  const worse = scored[index]!;
  if (better.rating.rating <= worse.rating.rating) {
    failures.push(
      `ordering: ${better.archetype.key} (${better.rating.rating}) must rate above ` +
        `${worse.archetype.key} (${worse.rating.rating})`,
    );
  }
}

// ---------------------------------------------------------------------------
// The anchors
// ---------------------------------------------------------------------------

function ratingOf(key: string): number | null {
  return scored.find((entry) => entry.archetype.key === key)?.rating.rating ?? null;
}

const masterpiece = ratingOf("masterpiece");
const grind = ratingOf("strong_grind");
const sterile = ratingOf("sterile_draw");
const mismatch = ratingOf("mismatch");
const collapse = ratingOf("mutual_collapse");

if (masterpiece !== null && masterpiece < ANCHORS.masterpieceAtLeast) {
  failures.push(`anchor: masterpiece rated ${masterpiece}, below ${ANCHORS.masterpieceAtLeast}`);
}
if (collapse !== null && collapse > ANCHORS.mutualCollapseAtMost) {
  failures.push(`anchor: mutual collapse rated ${collapse}, above ${ANCHORS.mutualCollapseAtMost}`);
}
if (mismatch !== null && mismatch > ANCHORS.mismatchAtMost) {
  failures.push(`anchor: mismatch rated ${mismatch}, above ${ANCHORS.mismatchAtMost}`);
}
for (const entry of scored) {
  if (entry.rating.rating >= ANCHORS.nothingReaches) {
    failures.push(`anchor: ${entry.archetype.key} reached ${entry.rating.rating}; ten is reserved`);
  }
}
if (masterpiece !== null && sterile !== null) {
  const gap = masterpiece - sterile;
  if (gap < ANCHORS.sterileBelowMasterpieceBy) {
    failures.push(
      `anchor: demand opened only ${gap.toFixed(1)} between a sterile game and a demanding one, ` +
        `wanted ${ANCHORS.sterileBelowMasterpieceBy}`,
    );
  }
}

// ---------------------------------------------------------------------------
// What the sacrifice case has to prove
// ---------------------------------------------------------------------------

const brilliancy = scored.find((entry) => entry.archetype.key === "brilliancy");
if (brilliancy) {
  const moments = brilliancy.rating.moments;
  if (!moments.some((moment) => moment.code === "pressure_created")) {
    failures.push(
      "brilliancy: the sacrifices created no named pressure, so the practical reading is not reaching the summary",
    );
  }
  if (brilliancy.rating.coverage.practicalDecisions === 0) {
    failures.push("brilliancy: no decision carried a practical reading");
  }
}

// A brilliancy scored against the engine alone must rate *worse*, or the
// practical reading is not doing anything and the Tal problem is unsolved.
const withoutPractical = ARCHETYPES.find((entry) => entry.key === "brilliancy");
if (withoutPractical && brilliancy) {
  const stripped = buildGame(withoutPractical.spec);
  const objectiveOnly = rateGame({
    ...stripped,
    decisions: stripped.decisions.map((decision) => ({ ...decision, reply: null })),
  });
  if (objectiveOnly.status !== "available") {
    failures.push("brilliancy: the objective-only comparison did not rate");
  } else if (objectiveOnly.rating >= brilliancy.rating.rating) {
    failures.push(
      `brilliancy: the practical reading changed nothing (${objectiveOnly.rating} against ` +
        `${brilliancy.rating.rating}); a sacrifice nobody refutes must not be charged as an error`,
    );
  } else if (grind !== null && objectiveOnly.rating >= grind) {
    // If the engine-only reading already ranks the brilliancy correctly, this
    // gate is not testing the Tal problem: it is testing a game that happens to
    // rate well either way. The fixture has to be one an engine gets wrong.
    failures.push(
      `brilliancy: an engine-only reading already ranks it above the quiet grind ` +
        `(${objectiveOnly.rating} against ${grind}), so the reversal is untested`,
    );
  } else {
    console.log(
      `  the sacrifices are worth ${(brilliancy.rating.rating - objectiveOnly.rating).toFixed(1)} ` +
        `of rating against an engine-only reading (${objectiveOnly.rating} → ${brilliancy.rating.rating})`,
    );
    console.log("");
  }
}

// ---------------------------------------------------------------------------
// What this gate is not evidence for
// ---------------------------------------------------------------------------

// Every archetype gives every ply the same likelihood shape, so the estimator
// sees a game with no variance in it and the interval collapses onto one rung.
// Real games do not look like that. Saying so here keeps a reader from taking
// these intervals as a demonstration that the interval works.
if (scored.every((entry) => entry.rating.ratingLow === entry.rating.ratingHigh)) {
  console.log("  Every interval above is a point. The fixtures are noiseless by construction,");
  console.log("  so the interval is carried through here but not exercised. Real evidence is");
  console.log("  what will test it.");
  console.log("");
}

// ---------------------------------------------------------------------------
// The half that cannot run yet
// ---------------------------------------------------------------------------

console.log(`  ${CORPUS_GAMES.length} real games are written down and none are scored yet:`);
for (const entry of CORPUS_GAMES) {
  console.log(`    pending  ${entry.expected[0]}–${entry.expected[1]}  ${entry.key}`);
}
console.log("");
console.log("  Their evidence needs the pipeline: MultiPV at the reply position and a");
console.log("  policy inference conditioned on the opponent. Until then this gate proves");
console.log("  the formula's orderings, not the scale's.");
console.log("");

// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`rating:calibration — ${failures.length} failed`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`rating:calibration — ${scored.length} archetypes ordered, ${CORPUS_GAMES.length} games pending`);
