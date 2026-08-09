import { invalidateCache } from "./loaderCache";
import { api, apiFetch } from "./api";

/**
 * Study-progress data: repertoire choices, drill results, and lesson tracking.
 *
 * These still pass a username, but it is no longer what identifies the caller —
 * the API derives that from the access token and rejects a username that isn't
 * linked to the signed-in account. It stays in the signature because a user can
 * link more than one chess account and needs to say which one they mean.
 */

export interface RepertoireOpening {
  color: "white" | "black";
  family: string;
  addedAt: string;
}

export interface RepertoireStat {
  color: "white" | "black";
  family: string;
  sessions: number;
  correct: number;
  total: number;
  reveals: number;
  accuracy: number | null;
  lastPracticed: string | null;
}

export interface RepertoireData {
  openings: RepertoireOpening[];
  stats: RepertoireStat[];
}

export interface LessonProgress {
  slug: string;
  completedSteps: number;
  totalSteps: number;
  bestScore: number;
  completedAt: string | null;
}

export function fetchRepertoire(username: string): Promise<RepertoireData> {
  return api<RepertoireData>(`/repertoire?username=${encodeURIComponent(username)}`);
}

export async function toggleRepertoireOpening(
  username: string,
  color: "white" | "black",
  family: string,
  enabled: boolean,
): Promise<void> {
  invalidateCache("account:");
  await apiFetch("/repertoire", { json: { username, color, family, enabled } });
}

export async function recordTrainingResult(input: {
  username: string;
  color: "white" | "black";
  family: string | null;
  lineUci: string;
  correct: number;
  total: number;
  reveals: number;
}): Promise<void> {
  invalidateCache("account:");
  try {
    await apiFetch("/training/results", { json: input });
  } catch {
    /* practice tracking is best-effort — never block the UI on it */
  }
}

export interface PracticeActivity {
  streak: number;
  practicedToday: boolean;
  activeDays30: number;
  totalSessions: number;
}

const NO_ACTIVITY: PracticeActivity = {
  streak: 0,
  practicedToday: false,
  activeDays30: 0,
  totalSessions: 0,
};

export async function fetchActivity(username: string): Promise<PracticeActivity> {
  try {
    return await api<PracticeActivity>(
      `/training/activity?username=${encodeURIComponent(username)}`,
    );
  } catch (error) {
    if (error instanceof Response) throw error; // let a 401 redirect through
    return NO_ACTIVITY;
  }
}

export interface MistakeDrill {
  positionKey: string;
  fen: string;
  playedUci: string;
  playedSan: string;
  bestUci: string;
  openingName: string | null;
  ply: number;
  lossCp: number | null;
}

export async function fetchMistakes(
  username: string,
  color: "white" | "black",
): Promise<MistakeDrill[]> {
  try {
    const body = await api<{ drills: MistakeDrill[] }>(
      `/training/mistakes?username=${encodeURIComponent(username)}&color=${color}`,
    );
    return body.drills;
  } catch (error) {
    if (error instanceof Response) throw error;
    return [];
  }
}

export async function fetchLessonProgress(username: string): Promise<LessonProgress[]> {
  try {
    const body = await api<{ progress: LessonProgress[] }>(
      `/lessons/progress?username=${encodeURIComponent(username)}`,
    );
    return body.progress;
  } catch (error) {
    if (error instanceof Response) throw error;
    return [];
  }
}

export async function saveLessonProgress(input: {
  username: string;
  slug: string;
  completedSteps: number;
  totalSteps: number;
  bestScore: number;
  completed: boolean;
}): Promise<void> {
  invalidateCache("account:");
  try {
    await apiFetch("/lessons/progress", { json: input });
  } catch {
    /* best-effort */
  }
}
