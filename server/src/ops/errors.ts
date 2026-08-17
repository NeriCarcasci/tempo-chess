import type { RetryClass } from "./contract.js";

/**
 * The safe error a workflow shows its owner.
 *
 * Platform spec §8 requires dead work to surface "a safe workflow error and
 * operator diagnostic" — two different things for two different readers. The
 * operator diagnostic is the attempt history and the item's `error_code`; this
 * is the other half, and it is a closed map rather than a formatted string
 * because the only way a provider body reaches a user is a sentence that
 * interpolated one.
 */

export interface SafeWorkflowError {
  code: string;
  message: string;
}

const BY_CLASS: Readonly<Record<RetryClass, SafeWorkflowError>> = {
  transient: {
    code: "WORK_FAILED_TRANSIENT",
    message: "This work kept failing for a temporary reason and has stopped. You can start it again.",
  },
  rate_limit: {
    code: "WORK_FAILED_RATE_LIMIT",
    message: "A provider limited us for long enough that this work stopped. Try again later.",
  },
  invalid_input: {
    code: "WORK_FAILED_INVALID_INPUT",
    message: "Some of the input for this work could not be used, so it stopped.",
  },
  unsupported: {
    code: "WORK_FAILED_UNSUPPORTED",
    message: "Part of this work is not something Forma supports yet.",
  },
  unauthorized: {
    code: "WORK_FAILED_UNAUTHORIZED",
    message: "Forma no longer has permission to do part of this work.",
  },
  budget: {
    code: "WORK_FAILED_BUDGET",
    message: "This work reached its cost or size budget before it finished.",
  },
  permanent: {
    code: "WORK_FAILED_PERMANENT",
    message: "This work failed in a way that will not succeed on a retry.",
  },
};

export function safeWorkflowError(retryClass: RetryClass | null): SafeWorkflowError {
  return BY_CLASS[retryClass ?? "permanent"];
}
