/**
 * The shapes the screens actually name.
 *
 * `schema.d.ts` is generated from `server/openapi/v1.json`, which is itself
 * generated from the router and checked by CI — so it is the truth, and it is
 * also 4,000 lines of nested generics that nothing should import directly. This
 * file gives the handful of types a component signature wants, derived from it,
 * so a route change still breaks the build in the right place.
 *
 * ```bash
 * npm run api:types   # after any /v1 route change
 * ```
 */

import type { operations } from "./schema";

/**
 * The `data` member of a successful response, for one operation.
 *
 * 200 first, then 201, rather than indexing every status: the failure responses
 * carry `application/problem+json` and no `data`, so a single index signature
 * over all statuses collapses the whole thing to `never` — silently, and only
 * for some operations, which is worse than loudly.
 */
type Data<O extends keyof operations> = operations[O] extends { responses: infer R }
  ? R extends { 200: { content: { "application/json": { data: infer D } } } }
    ? D
    : R extends { 201: { content: { "application/json": { data: infer D } } } }
      ? D
      : never
  : never;

/** The request body of one operation. */
type Body<O extends keyof operations> = operations[O] extends {
  requestBody?: { content: { "application/json": infer B } };
}
  ? B
  : never;

// --- identity ---------------------------------------------------------------

export type Me = Data<"getMe">;
export type LinkedAccount = Me["accounts"][number];
export type LinkAccountBody = Body<"linkAccount">;

// --- onboarding -------------------------------------------------------------

export type OnboardingState = Data<"getOnboarding">;
export type NextAction = OnboardingState["nextAction"];
export type OnboardingCoverage = Data<"getOnboardingCoverage">;
export type BaselineReport = Data<"getBaselineReport">;
/**
 * Every measurement behind the published profile: estimates with their
 * intervals and sample sizes, findings with their evidence, the trajectory
 * bins, the rating profile. The baseline report names these by id; this is what
 * the ids point at.
 */
export type Dashboard = Data<"getDashboard">;
export type SkillEstimate = Dashboard["estimates"][number];
export type TrajectoryBin = Dashboard["trajectory"]["bins"][number];
export type DiagnosticSession = Data<"getDiagnosticSession">;

// --- goals ------------------------------------------------------------------

export type Goal = Data<"getGoal">;
export type GoalList = Data<"listGoals">;
export type StartOnboardingBody = Body<"startOnboarding">;
export type GoalTemplate = Data<"listGoalTemplates">[number];
export type CreatedGoal = Data<"createGoal">;
export type CreateGoalBody = Body<"createGoal">;
export type GoalPlan = Data<"getGoalPlan">;
export type GoalProgress = Data<"getGoalProgress">;
export type CommitmentBody = Body<"setGoalCommitment">;

// --- practice ---------------------------------------------------------------

export type PracticeQueue = Data<"getPracticeQueue">;
export type PracticeItem = PracticeQueue["items"][number];
export type PracticeAttempt = Data<"recordPracticeAttempt">;
export type PracticeAttemptBody = Body<"recordPracticeAttempt">;
export type PracticeRefill = Data<"refillPracticeQueue">;

// --- openings ---------------------------------------------------------------

export type OpeningExplorer = Data<"getOpeningExplorer">;
export type OpeningExplorerCoverage = OpeningExplorer["coverage"];
export type OpeningFamilySummary = OpeningExplorer["families"][number];
/** Null when the filtered sample contains no move; the caller must handle it. */
export type OpeningGraphV1 = NonNullable<OpeningExplorer["graph"]>;
export type OpeningGraphV1Node = OpeningGraphV1["nodes"][number];
export type OpeningGraphV1Edge = OpeningGraphV1["edges"][number];
export type OpeningBook = Data<"getOpeningBook">;
export type BookContinuation = OpeningBook["book"]["continuations"][number];
export type PlayerBookMove = OpeningBook["yourMoves"][number];

// --- games ------------------------------------------------------------------

export type Game = Data<"getGame">;
export type GameReview = Data<"getGameReview">;
export type GameAnalysisRequest = Data<"requestGameAnalysis">;

// --- play -------------------------------------------------------------------

export type OpponentCatalogue = Data<"listPlayOpponents">;
export type OpponentFamilyEntry = OpponentCatalogue["families"][number];
export type OpponentFamilyLevel = OpponentFamilyEntry["levels"][number];
export type OpponentFamily = OpponentFamilyEntry["family"];
export type OpponentMove = Data<"requestOpponentMove">;
export type OpponentMoveBody = Body<"requestOpponentMove">;
export type PlayLevelKey = OpponentFamilyLevel["key"];

// --- work -------------------------------------------------------------------

export type Workflow = Data<"getWorkflow">;
export type WorkflowList = Data<"listWorkflows">;

// --- access -----------------------------------------------------------------

/** The signed-in account's own request to join the closed beta. */
export type AccessRequest = Data<"getAccessRequest">;
export type AccessState = AccessRequest["state"];

/** The operator's view. Reachable only by an account with an operator grant. */
export type AdminAccessRequest = Data<"listAccessRequests">[number];
export type AdminAccount = Data<"listAccounts">[number];
export type AdminOperations = Data<"getOperations">;
export type AdminOnboardingRun = AdminOperations["onboarding"][number];
export type AdminWorkTally = AdminOperations["work"][number];
export type AdminSyncRun = AdminOperations["sync"][number];

// --- public -----------------------------------------------------------------

export type PublicStats = Data<"getPublicStats">;
export type PublicPlans = Data<"getPublicPlans">;
export type PublicPlan = PublicPlans["plans"][number];
export type PublicBetaSignupBody = Body<"createBetaSignup">;
export type CaseStudy = Data<"getCaseStudy">;
export type CaseStudySummary = Data<"listCaseStudies">[number];
export type DirectoryProfile = Data<"getDirectoryProfile">;

// --- the shapes that carry meaning ------------------------------------------

/**
 * A public figure: the number, or an honest refusal to give it.
 *
 * Never `number | null`. A suppressed cell is one Forma knows and has decided
 * not to publish because it is small enough to be a person, and the UI says
 * "fewer than ten" rather than drawing a zero.
 */
export type PublicFigure =
  | { disclosure: "exact"; value: number }
  | { disclosure: "suppressed"; below: number };

export const COVERAGE_STATES = ["insufficient", "limited", "sufficient"] as const;
export type CoverageState = (typeof COVERAGE_STATES)[number];

export const CLAIM_STATES = [
  "no_evidence",
  "early_signal",
  "improving",
  "target_met",
  "declined",
  "unavailable",
] as const;
export type ClaimState = (typeof CLAIM_STATES)[number];

export const ANALYSIS_STATES = [
  "published",
  "stale",
  "running",
  "failed",
  "unavailable",
] as const;
export type AnalysisState = (typeof ANALYSIS_STATES)[number];

export const WORKFLOW_STATES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelling",
  "cancelled",
] as const;
export type WorkflowState = (typeof WORKFLOW_STATES)[number];

/** A workflow that is still going, so the UI knows whether to keep polling. */
export function isLiveWorkflow(state: string): boolean {
  return state === "queued" || state === "running" || state === "cancelling";
}

/**
 * The version block a claim-bearing read carries.
 *
 * Every number Forma states about somebody comes with one. Showing at least the
 * date is not decoration: an estimate without "as of when" is a claim about the
 * present that was true about the past.
 */
export interface VersionBlock {
  publicationId: string;
  generatedAt: string;
  subjectSnapshotId: string | null;
  recipeVersionId: string | null;
  policyVersions: Record<string, string>;
}
