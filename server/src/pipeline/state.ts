import type { ImportStatus, TaskStatus } from "./types.js";

const IMPORT_TRANSITIONS: Record<ImportStatus, readonly ImportStatus[]> = {
  queued: ["ingesting", "cancelled", "failed"],
  ingesting: ["analyzing", "cancelled", "failed"],
  analyzing: ["completed", "cancelled", "failed"],
  completed: [],
  failed: ["queued"],
  cancelled: [],
};

const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ["running", "cancelled"],
  running: ["completed", "queued", "failed", "cancelled"],
  completed: [],
  failed: ["queued", "cancelled"],
  cancelled: [],
};

export function assertImportTransition(from: ImportStatus, to: ImportStatus): void {
  if (!IMPORT_TRANSITIONS[from].includes(to)) {
    throw new Error(`Invalid import transition: ${from} -> ${to}`);
  }
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!TASK_TRANSITIONS[from].includes(to)) {
    throw new Error(`Invalid task transition: ${from} -> ${to}`);
  }
}

export function classifyTaskFailure(attempts: number, maxAttempts: number): "queued" | "failed" {
  if (!Number.isInteger(attempts) || !Number.isInteger(maxAttempts) || attempts < 1 || maxAttempts < 1) {
    throw new Error("attempt counts must be positive integers");
  }
  return attempts < maxAttempts ? "queued" : "failed";
}

export function progressPercent(analyzed: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((analyzed / total) * 100)));
}
