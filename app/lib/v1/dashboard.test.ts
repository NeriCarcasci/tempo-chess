/**
 * The dashboard payload, pinned where reading it wrong is invisible.
 *
 * The wire shape has three traps and every one of them fails silently. The
 * dimension key carries a frame suffix, so a lookup against the catalogue misses
 * and the page prints a humanised slug at somebody. Every measure arrives
 * several times over, so a page that lists rows names the same thing three
 * times. And a finding whose text failed its own safety check arrives with a
 * null explanation, which renders as an empty card unless something counts it.
 */

import { describe, expect, test } from "vitest";
import {
  confidenceLabel,
  findingLabel,
  groupMeasures,
  headlineFinding,
  holdingsOf,
  movementOf,
  quotedRating,
  readableExplanation,
  splitDimensionKey,
  splitFindings,
  suppressionText,
  todayReport,
  unavailableText,
  widestSample,
} from "./dashboard";
import type { Dashboard, Finding, RatingProfile, SkillEstimate } from "./types";

/**
 * The words the API sends beside an estimate.
 *
 * They used to come from a table in the client, so a fixture only had to name a
 * dimension key and the right sentence appeared. They come off the wire now, so
 * a fixture that wants a row to read as "Defending a worse position" has to say
 * so -- which is the point: the page shows what it was sent, and a test that
 * could not get that wrong would not be testing it.
 */
const WIRE_COPY: Record<string, { name: string; definition: string }> = {
  material_safety_respond: {
    name: "Keeping your pieces safe",
    definition: "One of your pieces was available to be taken for less than it is worth.",
  },
  free_material_recognize: {
    name: "Taking what is offered",
    definition: "Your opponent left something available to be taken for less than it is worth.",
  },
  only_move_recognize: {
    name: "Finding the only move",
    definition: "Of the moves the engine examined, exactly one held.",
  },
  winning_conversion_convert: {
    name: "Converting a winning position",
    definition: "You reached a position that should win.",
  },
  worse_position_defence_respond: {
    name: "Defending a worse position",
    definition: "You were worse and had to keep the game alive.",
  },
};

const FRAMES = ["objective", "personal_current", "personal_baseline"];

/** The base key of a wire key, dropping the frame suffix the API appends. */
function baseOf(dimensionKey: string): string {
  for (const frame of FRAMES) {
    if (dimensionKey.endsWith(`_${frame}`)) {
      return dimensionKey.slice(0, -(frame.length + 1));
    }
  }
  return dimensionKey;
}

function wireCopy(dimensionKey: string) {
  const base = baseOf(dimensionKey);
  const known = WIRE_COPY[base];
  const match = /^(.*)_(recognize|execute|respond|convert)$/.exec(base);
  return {
    name: known?.name ?? "A measurement",
    copy: {
      conceptSlug: match?.[1] ?? null,
      role: match?.[2] ?? null,
      category: "tactical",
      roleLabel: "A measured role",
      definition: known?.definition ?? "",
      narrative: null,
    },
  };
}

const estimate = (over: Partial<SkillEstimate> & { dimensionKey: string }): SkillEstimate => ({
  displayName: wireCopy(over.dimensionKey).name,
  copy: wireCopy(over.dimensionKey).copy,
  phase: null,
  frame: "objective",
  windowKind: "lifetime",
  estimate: 0.5,
  intervalLow: 0.45,
  intervalHigh: 0.55,
  rawSampleSize: 200,
  effectiveSampleSize: 120,
  coverage: { success: 100, failure: 100, graded: 200, censored: 0 },
  coverageStatus: "sufficient",
  unavailableReason: null,
  delta: null,
  improvementProbability: null,
  ...over,
});

const finding = (over: Partial<Finding> & { id: string }): Finding => ({
  findingType: "foundational_miss",
  priority: 10,
  confidenceTier: "moderate",
  claim: {},
  adjustedProbability: 0.01,
  evidence: [],
  explanation: "You lose material to a capture you could have seen.",
  explanationState: "passed",
  ...over,
});

describe("dimension keys", () => {
  test("the frame suffix is stripped, and the two ending in `current` are not confused", () => {
    // `peer_current` and `personal_current` both end in `current`. A shortest
    // match leaves `personal` glued to the base key, the catalogue lookup
    // misses, and the row silently falls back to a humanised slug.
    expect(splitDimensionKey("material_safety_respond_personal_current")).toEqual({
      baseKey: "material_safety_respond",
      frame: "personal_current",
    });
    expect(splitDimensionKey("material_safety_respond_peer_current")).toEqual({
      baseKey: "material_safety_respond",
      frame: "peer_current",
    });
    expect(splitDimensionKey("only_move_recognize_objective")).toEqual({
      baseKey: "only_move_recognize",
      frame: "objective",
    });
  });

  test("a key with no recognised frame comes back whole rather than truncated", () => {
    expect(splitDimensionKey("something_new_recognize")).toEqual({
      baseKey: "something_new_recognize",
      frame: null,
    });
  });

  test("any concept and role round-trips through a wire key", () => {
    // Written against the catalogue when the client carried one. It is an open
    // set on the server now, so the property is stated over shapes rather than
    // over a list this build happens to know -- including a slug with an
    // underscore in it, which is what breaks a naive split.
    for (const base of [
      "material_safety_respond",
      "critical_moment_execute",
      "winning_conversion_convert",
      "removal_of_defender_execute",
      "something_nobody_shipped_yet_respond",
    ]) {
      expect(splitDimensionKey(`${base}_objective`).baseKey).toBe(base);
    }
  });
});

describe("grouping the estimates", () => {
  const rows: SkillEstimate[] = [
    estimate({ dimensionKey: "material_safety_respond_objective", estimate: 0.42, rawSampleSize: 1698 }),
    estimate({
      dimensionKey: "material_safety_respond_personal_current",
      frame: "personal_current",
      windowKind: "recent_form",
      estimate: 0.47,
      delta: 0.06,
      improvementProbability: 0.82,
      rawSampleSize: 849,
    }),
    estimate({
      dimensionKey: "material_safety_respond_personal_current",
      frame: "personal_current",
      windowKind: "baseline",
      estimate: 0.41,
      rawSampleSize: 849,
    }),
    estimate({
      dimensionKey: "winning_conversion_convert_objective",
      estimate: null,
      intervalLow: null,
      intervalHigh: null,
      unavailableReason: "below_minimum_sample",
      coverageStatus: "insufficient",
      rawSampleSize: 41,
      coverage: { success: 0, failure: 0, graded: 0, censored: 41 },
    }),
  ];

  test("many rows become one group per measure, under a human name", () => {
    const groups = groupMeasures(rows);
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.name)).toContain("Keeping your pieces safe");
    for (const group of groups) {
      expect(group.name).not.toContain("_");
      expect(group.name).not.toContain("(");
    }
  });

  test("the headline is the objective frame over the whole window", () => {
    const group = groupMeasures(rows).find((entry) => entry.baseKey === "material_safety_respond")!;
    expect(group.headline.frame).toBe("objective");
    expect(group.headline.windowKind).toBe("lifetime");
    expect(group.headline.estimate).toBe(0.42);
    // The other two are kept, because the change between them is a real thing
    // to say and dropping them would lose it.
    expect(group.recent?.delta).toBe(0.06);
    expect(group.baseline?.estimate).toBe(0.41);
    expect(group.rows).toHaveLength(3);
  });

  test("a measure with no objective row still gets a group", () => {
    // Dropping it would turn a frame the estimator skipped into a chance that
    // never happened.
    const groups = groupMeasures([
      estimate({
        dimensionKey: "only_move_recognize_personal_current",
        frame: "personal_current",
        windowKind: "recent_form",
      }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.name).toBe("Finding the only move");
  });

  test("a run that wrote twice prefers the row that carries a number", () => {
    const groups = groupMeasures([
      estimate({ dimensionKey: "free_material_recognize_objective", estimate: null, unavailableReason: "no_observations" }),
      estimate({ dimensionKey: "free_material_recognize_objective", estimate: 0.84 }),
    ]);
    expect(groups[0]!.headline.estimate).toBe(0.84);
  });

  test("claims Forma can stand behind lead", () => {
    expect(groupMeasures(rows).map((group) => group.headline.coverageStatus)).toEqual([
      "sufficient",
      "insufficient",
    ]);
  });

  test("the widest sample is a denominator, and is null when there is nothing", () => {
    expect(widestSample(groupMeasures(rows))).toBe(1698);
    expect(widestSample([])).toBeNull();
  });

  test("the censored count is never folded into the failures", () => {
    const group = groupMeasures(rows).find((entry) => entry.baseKey === "winning_conversion_convert")!;
    expect(group.headline.coverage.censored).toBe(41);
    expect(group.headline.coverage.failure).toBe(0);
    expect(group.headline.coverage.graded).toBe(0);
    expect(group.censoring).toContain("set aside rather than counted against you");
  });
});

describe("absences", () => {
  test("every reason the contract declares reads as a different sentence", () => {
    const reasons = [
      "no_observations",
      "all_evidence_censored",
      "below_minimum_sample",
      "outside_calibrated_range",
      "estimator_unavailable",
    ];
    const sentences = reasons.map(unavailableText);
    expect(new Set(sentences).size).toBe(reasons.length);
    // "Not enough evidence" and "measured at zero" are opposite statements and
    // neither may read as the other.
    expect(unavailableText("no_observations")).not.toContain("0");
    expect(unavailableText("all_evidence_censored")).toContain("not a failure on your part");
  });

  test("a reason this build has never seen is described, never printed raw", () => {
    expect(unavailableText("some_new_reason")).not.toContain("some_new_reason");
    expect(unavailableText(null).length).toBeGreaterThan(20);
  });

  test("a suppression reason that arrives as a slug is described, not printed", () => {
    // `suppressed_reason` is free text and nothing writes it yet, so the first
    // producer decides whether it is a sentence or an enum value.
    expect(suppressionText("outside_calibrated_range")).not.toContain("_");
    expect(suppressionText("Your pool has too few rated players to calibrate.")).toBe(
      "Your pool has too few rated players to calibrate.",
    );
  });

  test("a finding type this build has never seen is a plain noun, not a slug", () => {
    expect(findingLabel("brand_new_type")).toBe("A conclusion");
    expect(findingLabel("foundational_miss")).not.toContain("_");
    expect(confidenceLabel("unheard_of")).not.toContain("_");
  });
});

describe("findings", () => {
  const findings: Finding[] = [
    finding({ id: "f1", priority: 5 }),
    finding({ id: "f2", priority: 30, explanation: null, explanationState: "held" }),
    finding({ id: "f3", priority: 20, findingType: "strength", explanation: "You take what is offered." }),
    finding({ id: "f4", priority: 90, findingType: "insufficient_evidence", explanation: "Not enough here yet." }),
  ];

  test("a conclusion with no text is counted, never described", () => {
    const split = splitFindings(findings);
    expect(split.readable.map((entry) => entry.id)).toEqual(["f4", "f3", "f1"]);
    expect(split.silent).toBe(1);
  });

  test("the headline conclusion is never a gap finding", () => {
    // "There is not enough evidence about you" is true and is not a reason to
    // open a report.
    expect(headlineFinding(findings)!.id).toBe("f3");
  });

  test("nothing readable means no headline at all", () => {
    expect(headlineFinding([finding({ id: "x", explanation: null })])).toBeNull();
  });
});

describe("the rating quoted when a page has room for one", () => {
  const profile = (pools: RatingProfile["pools"]): RatingProfile => ({
    state: "published",
    pools,
    note: "Ratings from different pools are not comparable.",
  });
  const pool = (speed: string, observedRating: number | null, provider = "lichess") => ({
    provider,
    pool: `${provider}_${speed}`,
    speed,
    observedRating,
    scaleEstimate: null,
    intervalLow: null,
    intervalHigh: null,
    inSupportedRange: true,
    suppressedReason: null,
  });

  test("the pool is chosen by a stated order, not by which number is largest", () => {
    // Picking the biggest figure is flattery dressed as a measurement.
    const chosen = quotedRating(profile([pool("bullet", 2100), pool("blitz", 1642)]))!;
    expect(chosen.speed).toBe("blitz");
    expect(chosen.rating).toBe(1642);
  });

  test("a pool with no recorded rating is not quoted", () => {
    expect(quotedRating(profile([pool("blitz", null)]))).toBeNull();
    expect(quotedRating({ state: "unavailable", pools: [], note: "" })).toBeNull();
  });
});

describe("what the hub says", () => {
  const dashboard = (over: Partial<Dashboard> = {}): Dashboard =>
    ({
      subjectId: "s1",
      publicationId: "pub-1",
      runId: "run-1",
      publishedAt: "2026-08-01T00:00:00Z",
      sections: {
        estimates: "published",
        findings: "published",
        trajectory: "published",
        ratingProfile: "published",
        goal: "unavailable",
        connections: "unavailable",
      },
      estimates: [
        estimate({ dimensionKey: "material_safety_respond_objective" }),
        estimate({ dimensionKey: "only_move_recognize_objective", estimate: null, unavailableReason: "no_observations" }),
      ],
      findings: [finding({ id: "f1" })],
      trajectory: {
        state: "published",
        snapshotId: "snap-1",
        includedGameCount: 200,
        bins: [
          {
            phase: "opening",
            binOrdinal: 0,
            progressLow: 0,
            progressHigh: 0.5,
            gamesContributing: 200,
            medianExpectedScore: 0.52,
            p25ExpectedScore: 0.51,
            p75ExpectedScore: 0.52,
            intervalLow: null,
            intervalHigh: null,
            phaseReachRate: 1,
          },
          {
            phase: "middlegame",
            binOrdinal: 0,
            progressLow: 0,
            progressHigh: 0.5,
            gamesContributing: 160,
            medianExpectedScore: 0.5,
            p25ExpectedScore: 0,
            p75ExpectedScore: 0.667,
            intervalLow: null,
            intervalHigh: null,
            phaseReachRate: 0.8,
          },
        ],
        unreachedPhases: ["endgame"],
      },
      ratingProfile: { state: "unavailable", pools: [], note: "" },
      coverageWarnings: [],
      version: { recipeVersionId: "r1", snapshotId: "snap-1", estimatorVersions: ["e1"] },
      ...over,
    }) as Dashboard;

  test("what is inside is a count of rows that came back, not a new claim", () => {
    expect(holdingsOf(dashboard())).toEqual({
      measured: 1,
      unmeasured: 1,
      conclusions: 1,
      trajectoryGames: 200,
      phases: 2,
    });
  });

  test("the hub headline is the graph's own conclusion, and it carries the graph", () => {
    const report = todayReport(dashboard())!;
    expect(report.headline).toBe("Your games are decided in the middlegame.");
    expect(report.cone?.phases).toHaveLength(2);
    expect(report.games).toBe(200);
  });

  test("nothing drawn, nothing readable and nothing measured is no report at all", () => {
    // A row that cannot state its reason does not render. That is the hub's
    // rule and it applies to the thing at the top of it too.
    const empty = dashboard({
      trajectory: { state: "unavailable", snapshotId: null, includedGameCount: 0, bins: [], unreachedPhases: [] },
      findings: [finding({ id: "f1", explanation: null })],
      estimates: [],
    });
    expect(todayReport(empty)).toBeNull();
  });

  test("measured areas alone are enough to publish the page", () => {
    // The measures are the page's spine now. A report with seven measured
    // areas has plenty to say even when the trajectory is missing and every
    // finding was held back, and returning null would blank a live screen.
    const noGraph = dashboard({
      trajectory: { state: "unavailable", snapshotId: null, includedGameCount: 0, bins: [], unreachedPhases: [] },
      findings: [finding({ id: "f1", explanation: null })],
    });
    const report = todayReport(noGraph);
    expect(report).not.toBeNull();
    expect(report!.measures.length).toBeGreaterThan(0);
  });
});

describe("readableExplanation", () => {
  const finding = (explanation: string | null) =>
    ({ explanation } as unknown as Parameters<typeof readableExplanation>[0]);

  test("holds back a sentence carrying a database key", () => {
    // The exact text a live report showed a customer. It is stored prose from a
    // publication written before the renderer was repaired, so no amount of
    // correct server code removes it — only a re-run does, and until then the
    // client must not print it.
    expect(
      readableExplanation(
        finding("critical_moment_recognize_objective is costing you: 22% of your chances."),
      ),
    ).toBeNull();
  });

  test("passes the sentence the repaired renderer writes", () => {
    // The moment a re-render lands this appears with no code change.
    expect(
      readableExplanation(
        finding("You are losing ground on positions that decide the game. Over 1049 chances."),
      ),
    ).toMatch(/losing ground on positions that decide the game/);
  });

  test("an absent explanation is absent, not an empty string", () => {
    expect(readableExplanation(finding(null))).toBeNull();
    expect(readableExplanation(finding("   "))).toBeNull();
  });
});

describe("movementOf", () => {
  test("mirrors the estimator's own thresholds rather than choosing new ones", () => {
    expect(movementOf(0)).toBe("declined");
    expect(movementOf(0.05)).toBe("declined");
    expect(movementOf(0.2)).toBe("slipping");
    expect(movementOf(0.5)).toBe("unclear");
    expect(movementOf(0.8)).toBe("gaining");
    expect(movementOf(0.95)).toBe("improved");
  });

  test("no posterior is not a claim of no change", () => {
    expect(movementOf(null)).toBe("unclear");
  });
});
