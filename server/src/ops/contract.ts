/**
 * The E04 durable work contract, frozen in one place.
 *
 * Every vocabulary here is also a database check constraint in
 * `0014_e04_work_ledger.sql`. Two copies of a closed set is normally a smell;
 * here it is the point. The database refuses a row it does not recognise even
 * if a future call site invents a value, and this file is what the API, the
 * dispatcher, the workers and the OpenAPI document all read — so a value that
 * exists in one and not the other fails a test rather than reaching a row.
 *
 * Sources: plans/v1-platform-spec.md §8 (states and retry classes),
 * plans/database-architecture.md §14 (tables and columns),
 * plans/v1-api-contract.md §2.1 (the workflow resource).
 */

/** Platform spec §8. A terminal state never returns to a nonterminal one. */
export const WORKFLOW_STATES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelling",
  "cancelled",
] as const;
export type WorkflowState = (typeof WORKFLOW_STATES)[number];

export const TERMINAL_WORKFLOW_STATES = ["succeeded", "failed", "cancelled"] as const;

/** Platform spec §8. */
export const WORK_ITEM_STATUSES = [
  "blocked",
  "ready",
  "leased",
  "succeeded",
  "retry_wait",
  "dead",
  "cancelled",
] as const;
export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];

export const TERMINAL_WORK_ITEM_STATUSES = ["succeeded", "dead", "cancelled"] as const;

/** Database architecture §14.2. A capability, never a Cloud Run service name. */
export const RESOURCE_CLASSES = [
  "api_light",
  "ingestion",
  "cpu_engine",
  "cpu_model",
  "cpu_interactive_model",
  "gpu_model",
  "aggregation",
  "publication",
] as const;
export type ResourceClass = (typeof RESOURCE_CLASSES)[number];

/**
 * Platform spec §8's retry classification. The distinction that matters is not
 * "did it fail" but "would running it again plausibly succeed" — an invalid
 * input retried five times is five identical failures and a bill.
 */
export const RETRY_CLASSES = [
  "transient",
  "rate_limit",
  "invalid_input",
  "unsupported",
  "unauthorized",
  "budget",
  "permanent",
] as const;
export type RetryClass = (typeof RETRY_CLASSES)[number];

/** Workflow kinds. Closed, because a client filter must not name a new one. */
export const WORKFLOW_KINDS = [
  "account_sync",
  "game_import",
  "initial_examination",
  "game_analysis",
  "model_backfill",
  "subject_estimation",
  "maintenance",
  // E12. API contract §14's bounded interactive evaluation is a durable
  // operation with an owner and a work item, and it is not a game analysis --
  // labelling it one would make "how many game analyses ran today" wrong.
  "position_evaluation",
  // CPU human-policy work for scenario continuations. It is not an objective
  // evaluation and not evidence from a historical game.
  "position_continuation",
] as const;
export type WorkflowKind = (typeof WORKFLOW_KINDS)[number];

/**
 * How a ready item reaches a worker.
 *
 * `queue` goes through the outbox to Cloud Tasks. `in_process` is claimed by a
 * co-located runner and is never dispatched — the routing rollback described in
 * docs/platform/E04-work-ledger-contract.md §11, which changes transport
 * without abandoning a committed row.
 */
export const DISPATCH_MODES = ["queue", "in_process"] as const;
export type DispatchMode = (typeof DISPATCH_MODES)[number];

/** `superseded` means the item moved on before dispatch: not a dead letter. */
/**
 * Platform spec §7's initial queues, verbatim.
 *
 * Named on the work item by whoever created it. The provider split is a
 * property of the job — "sync this Lichess account" — not of the capability
 * that runs it, so deriving it from `resource_class` would have meant inventing
 * a routing rule the spec deliberately states per queue.
 */
export const QUEUES = [
  "provider-lichess",
  "provider-chesscom",
  "stockfish-screen",
  "stockfish-deep",
  "analysis",
  "maia-play",
  "maintenance",
] as const;
export type Queue = (typeof QUEUES)[number];

export const OUTBOX_STATES = ["pending", "published", "dead", "superseded"] as const;
export type OutboxState = (typeof OUTBOX_STATES)[number];

export const ATTEMPT_OUTCOMES = ["succeeded", "failed", "abandoned", "cancelled"] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

/** Mirrors the database defaults so a caller and a row cannot disagree. */
export const DEFAULT_MAX_ATTEMPTS = 5;
export const MAX_MAX_ATTEMPTS = 25;
export const DEFAULT_TIMEOUT_SECONDS = 300;
export const MIN_TIMEOUT_SECONDS = 5;
export const MAX_TIMEOUT_SECONDS = 3_600;
export const MAX_PAYLOAD_BYTES = 4_096;
export const MAX_ERROR_DETAIL_LENGTH = 500;

/** How many outbox rows one dispatch pass claims. Bounds the pass, not the queue. */
export const OUTBOX_DISPATCH_BATCH = 100;

/** How many expired leases one recovery pass reconciles. */
export const LEASE_RECOVERY_BATCH = 200;

export function isTerminalWorkflowState(state: WorkflowState): boolean {
  return (TERMINAL_WORKFLOW_STATES as readonly string[]).includes(state);
}

export function isTerminalWorkItemStatus(status: WorkItemStatus): boolean {
  return (TERMINAL_WORK_ITEM_STATUSES as readonly string[]).includes(status);
}
