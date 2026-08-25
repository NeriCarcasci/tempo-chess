/**
 * The goal surface on `/v1`.
 *
 * Three reads, in the order `Today` needs them: which goal is active, then its
 * progress. `server/src/v1/routes/goals.ts` keeps adherence, readiness and
 * real-game evidence as three separate fields — a client cannot render "80% of
 * the way there" from an activity counter, and neither of these types lets one
 * be mistaken for the other.
 */

import { v1Data, v1Maybe } from "./client";
import type { ClaimState } from "./types";

export interface GoalView {
  goalId: string;
  subjectId: string;
  status: "draft" | "active" | "achieved" | "abandoned" | "superseded";
  statedObjective: string;
  comparisonFrame: string;
  targetProvider: string | null;
  targetSpeed: string | null;
  horizonDays: number | null;
  uncalibratedCaveat: string | null;
  createdAt: string;
  activatedAt: string | null;
  closedAt: string | null;
  closeOutcome: string | null;
  closeNote: string | null;
}

export interface GoalMetricProgress {
  metricKey: string;
  currentValue: number | null;
  readiness: number | null;
  claimState: ClaimState | string;
  targetAchieved: boolean;
  unavailableReason: string | null;
}

export interface GoalProgress {
  state: "published" | "unavailable";
  metrics: GoalMetricProgress[];
  adherence: { ratio: number | null; note: string };
  realGameEvidence: number;
  practiceEvidence: number;
}

/** Every goal the caller has ever drafted or activated, newest first from the API. */
export async function listGoals(): Promise<GoalView[]> {
  return v1Data<GoalView[]>("/v1/goals");
}

/**
 * Progress on one goal, or null when nothing has been measured on it yet.
 *
 * `state: "unavailable"` and a 404 both collapse to null here: "no such goal"
 * and "nothing measured yet" are both "there is nothing to show" for a caller
 * that already resolved the goal id from `listGoals`.
 */
export async function getGoalProgress(goalId: string): Promise<GoalProgress | null> {
  const result = await v1Maybe<GoalProgress>(`/v1/goals/${goalId}/progress`);
  if (result === null || result.state === "unavailable") return null;
  return result;
}

/** The goal this account is actually working on, or null with nothing active. */
export function activeGoal(goals: readonly GoalView[]): GoalView | null {
  return goals.find((goal) => goal.status === "active") ?? null;
}
