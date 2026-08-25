import { Today, type LeadTask } from "../components/Today";
import { buildCone } from "../lib/trajectory";
import type { TrajectoryBin } from "../lib/v1/types";
import type { Measure, TodayReport } from "../lib/v1/dashboard";
import type { RecentGame } from "../lib/v1/games";
import type { GoalProgress, GoalView } from "../lib/v1/goals";

/**
 * `/dev/today` — the hub, from a fixture, with no session behind it.
 *
 * Here for the same reason `/dev/graph` is: this page can only be judged whole,
 * and whole means a published report, a ranked stack, a lead line with a real
 * position on a board, and a goal with progress against it. Assembling that
 * against a live archive costs a database, an examination run and a wait, so
 * the layout otherwise gets worked on blind.
 *
 * The figures below are shaped like real ones and are claims about nobody. The
 * route is `noindex` and nothing in the product links to it.
 */

export function meta() {
  return [{ title: "Today · fixture · Forma" }, { name: "robots", content: "noindex" }];
}

const bin = (
  over: Partial<TrajectoryBin> & { phase: string; binOrdinal: number },
): TrajectoryBin => ({
  progressLow: over.binOrdinal / 4,
  progressHigh: (over.binOrdinal + 1) / 4,
  gamesContributing: 200,
  medianExpectedScore: 0.5,
  p25ExpectedScore: 0.5,
  p75ExpectedScore: 0.5,
  intervalLow: null,
  intervalHigh: null,
  phaseReachRate: 1,
  ...over,
});

/** Level and alike at move one, pulling apart through the middlegame, thinning into the endgame. */
const BINS: TrajectoryBin[] = [
  bin({ phase: "opening", binOrdinal: 0, medianExpectedScore: 0.518, p25ExpectedScore: 0.511, p75ExpectedScore: 0.524, intervalLow: 0.512, intervalHigh: 0.523, gamesContributing: 204 }),
  bin({ phase: "opening", binOrdinal: 1, medianExpectedScore: 0.508, p25ExpectedScore: 0.462, p75ExpectedScore: 0.571, intervalLow: 0.494, intervalHigh: 0.523, gamesContributing: 204 }),
  bin({ phase: "opening", binOrdinal: 2, medianExpectedScore: 0.502, p25ExpectedScore: 0.418, p75ExpectedScore: 0.606, intervalLow: 0.481, intervalHigh: 0.522, gamesContributing: 201 }),
  bin({ phase: "middlegame", binOrdinal: 0, medianExpectedScore: 0.497, p25ExpectedScore: 0.352, p75ExpectedScore: 0.641, intervalLow: 0.463, intervalHigh: 0.531, gamesContributing: 168, phaseReachRate: 0.82 }),
  bin({ phase: "middlegame", binOrdinal: 1, medianExpectedScore: 0.491, p25ExpectedScore: 0.188, p75ExpectedScore: 0.664, intervalLow: 0.442, intervalHigh: 0.54, gamesContributing: 164, phaseReachRate: 0.82 }),
  bin({ phase: "middlegame", binOrdinal: 2, medianExpectedScore: 0.486, p25ExpectedScore: 0.031, p75ExpectedScore: 0.679, intervalLow: 0.421, intervalHigh: 0.548, gamesContributing: 159, phaseReachRate: 0.82 }),
  bin({ phase: "endgame", binOrdinal: 0, medianExpectedScore: 0.494, p25ExpectedScore: 0.014, p75ExpectedScore: 0.724, intervalLow: 0.402, intervalHigh: 0.586, gamesContributing: 51, phaseReachRate: 0.25 }),
  bin({ phase: "endgame", binOrdinal: 1, medianExpectedScore: 0.501, p25ExpectedScore: 0.0, p75ExpectedScore: 0.812, intervalLow: 0.371, intervalHigh: 0.63, gamesContributing: 44, phaseReachRate: 0.25 }),
];

const measure = (over: Partial<Measure> & { baseKey: string; name: string }): Measure => ({
  role: null,
  definition: null,
  rate: null,
  intervalLow: null,
  intervalHigh: null,
  sample: 0,
  coverageStatus: "sufficient",
  unavailableReason: null,
  change: null,
  ...over,
});

const MEASURES: Measure[] = [
  measure({
    baseKey: "material_safety_respond",
    name: "Keeping your pieces safe",
    role: "Responding to it",
    definition:
      "Counted every time one of your pieces could be taken for nothing on the move after this one.",
    rate: 0.431, intervalLow: 0.411, intervalHigh: 0.45, sample: 1940,
    change: { from: 0.465, to: 0.4, delta: -0.06502, improvementProbability: 0.00348, movement: "declined", sample: 970 },
  }),
  measure({
    baseKey: "critical_moment_notice",
    name: "Positions that decide the game",
    role: "Noticing one",
    definition:
      "Counted at the positions where the best move and the second best differ most.",
    rate: 0.276, intervalLow: 0.249, intervalHigh: 0.305, sample: 812,
    change: { from: 0.301, to: 0.259, delta: -0.0418, improvementProbability: 0.113, movement: "slipping", sample: 402 },
  }),
  measure({
    baseKey: "critical_moment_play",
    name: "Positions that decide the game",
    role: "Playing it",
    rate: 0.184, intervalLow: 0.152, intervalHigh: 0.221, sample: 448,
    change: { from: 0.19, to: 0.181, delta: -0.009, improvementProbability: 0.41, movement: "unclear", sample: 219 },
  }),
  measure({
    baseKey: "endgame_technique",
    name: "Converting an endgame",
    rate: 0.522, intervalLow: 0.46, intervalHigh: 0.583, sample: 254,
    change: { from: 0.5, to: 0.54, delta: 0.041, improvementProbability: 0.86, movement: "gaining", sample: 121 },
  }),
  measure({
    baseKey: "tactics_capture",
    name: "Taking what is on offer",
    definition:
      "Counted every time material was hanging and could be taken without losing more back.",
    rate: 0.841, intervalLow: 0.818, intervalHigh: 0.862, sample: 1104,
    change: { from: 0.79, to: 0.87, delta: 0.0796, improvementProbability: 0.981, movement: "improved", sample: 553 },
  }),
  measure({
    baseKey: "king_safety_respond",
    name: "Keeping your king safe",
    role: "Responding to it",
    rate: null, unavailableReason: "insufficient_coverage", coverageStatus: "thin", sample: 41,
  }),
  measure({
    baseKey: "pawn_structure",
    name: "Pawn structure",
    rate: 0.612, intervalLow: 0.577, intervalHigh: 0.646, sample: 690,
  }),
];

const REPORT: TodayReport = {
  headline: "Your games are decided in the middlegame.",
  detail: "",
  finding:
    "You lose more material to a single unguarded piece than to any tactic, most often on the move right after your last minor piece comes out.",
  cone: buildCone(BINS),
  measured: 7,
  conclusions: 3,
  games: 204,
  rating: { rating: 1584, speed: "blitz", provider: "lichess" },
  measures: MEASURES,
  publishedAt: "2026-08-20T18:22:33.011Z",
};

const LEAD: LeadTask = {
  label: "London System",
  family: "London System",
  color: "white",
  variation: null,
  moveNo: 11,
  mistakes: 5,
  moves: 14,
  maxMove: 24,
  nodeKeys: ["r4rk1/pbq2ppp/1pnbpn2/2ppN3/3P4/2PBP1B1/PP1N1PPP/R2Q1RK1 w - -"],
};

const LAST_GAME: RecentGame = {
  id: "fixture-1",
  opponent: "nikolai_v",
  opponentRating: 1602,
  colour: "white",
  speed: "blitz",
  result: "black",
  outcome: "loss",
  playedAt: new Date(Date.now() - 5 * 3_600_000).toISOString(),
  providerUrl: "https://lichess.org/",
  initialFen: null,
  moves: [{ uci: "d2d4" }],
};

const GOAL: GoalView = {
  goalId: "fixture-goal",
  subjectId: "fixture-subject",
  status: "active",
  statedObjective: "Reach 1600 blitz on Lichess",
  comparisonFrame: "personal_current",
  targetProvider: "lichess",
  targetSpeed: "blitz",
  horizonDays: 90,
  uncalibratedCaveat: null,
  createdAt: "2026-06-01T09:00:00.000Z",
  activatedAt: "2026-06-01T09:00:00.000Z",
  closedAt: null,
  closeOutcome: null,
  closeNote: null,
};

const PROGRESS: GoalProgress = {
  state: "published",
  metrics: [
    { metricKey: "rating_blitz", currentValue: 1584, readiness: 0.72, claimState: "improving", targetAchieved: false, unavailableReason: null },
    { metricKey: "material_safety_respond", currentValue: 0.4, readiness: 0.31, claimState: "declining", targetAchieved: false, unavailableReason: null },
  ],
  adherence: {
    ratio: 0.8,
    note: "You have practised on 24 of the 30 days since you set this.",
  },
  realGameEvidence: 41,
  practiceEvidence: 216,
};

export default function PreviewToday() {
  return (
    <Today
      shape={{ bars: [], total: 0, peak: null }}
      lead={LEAD}
      empty={null}
      games={204}
      unanalysed={0}
      lastGame={LAST_GAME}
      run={null}
      report={REPORT}
      goal={GOAL}
      goalProgress={PROGRESS}
    />
  );
}
