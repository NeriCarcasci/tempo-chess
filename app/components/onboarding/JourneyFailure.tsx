import type { ReactNode } from "react";
import { FAILURE_COPY, type FailureReason } from "../../lib/onboarding/copy";

/**
 * The journey stopped.
 *
 * Two sources, because the system has two ways of stopping and only one of them
 * marks the run:
 *
 *   * the run itself failed, with a named reason;
 *   * the *sync workflow* failed, which leaves the run `active` and its next
 *     action `wait` for ever. Without this branch the person waits for eternity
 *     with nothing on screen to say otherwise.
 *
 * The workflow's own error message is never rendered. It is a sanitized code
 * plus a string from the work ledger, and the rule for a 500's detail applies
 * here for the same reason: it is not written for a reader.
 */
export function JourneyFailure({
  reason,
  workflowFailed = false,
  retry,
}: {
  reason: FailureReason | null;
  workflowFailed?: boolean;
  retry?: ReactNode;
}) {
  const copy = reason
    ? FAILURE_COPY[reason]
    : workflowFailed
      ? {
          title: "Reading your games stopped",
          detail:
            "The import did not finish, so there is nothing to analyse yet. Your games are untouched on your chess site.",
          retryable: true,
        }
      : {
          title: "This journey stopped",
          detail: "It cannot go any further from here. Starting a new one is safe.",
          retryable: true,
        };

  return (
    <div className="problem-card" role="alert">
      <strong>{copy.title}</strong>
      <p>{copy.detail}</p>
      {/* Whatever the caller offered, always. `retryable` says whether *this
          journey* can be retried, which is a different question from whether
          there is a way forward — `no_linked_account` cannot be retried and
          has the most obvious next step of any of them. Gating on it left the
          only reachable failure with no button at all. */}
      {retry}
    </div>
  );
}
