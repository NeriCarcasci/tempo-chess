/**
 * May this be published?
 *
 * The database refuses a case study that is missing any of its grounds, and it
 * refuses on the first thing it finds. That is right for a backstop and wrong
 * for a person: an editor who fixes the licence only to be told about the
 * consent, then about the review, learns to click until it works.
 *
 * So this is the same question asked all at once, in one place, before the
 * insert. It is deliberately a duplicate of the trigger's rules — with one
 * addition the database cannot make, below — and the migration gate asserts
 * that both refuse the same candidates.
 */

import { REVIEW_CHECKLIST_KEYS, isValidSlug } from "./contract.js";
import type { PermissionBasis, ReviewDecision } from "./contract.js";

export interface ReadinessCandidate {
  slug: string;
  title: string;
  summary: string;
  redactionPolicyVersion: string;
  subject: { kind: string; hasAccountOwner: boolean };
  run: { status: string; outputManifestHash: string | null; belongsToSubject: boolean };
  publication: { belongsToSubject: boolean; pinsRun: boolean };
  source: {
    permissionBasis: PermissionBasis;
    licenceKey: string | null;
    licenceUrl: string | null;
    attributionText: string | null;
  };
  consent: {
    belongsToSubject: boolean;
    scope: string;
    withdrawnAt: Date | null;
    expiresAt: Date | null;
  } | null;
  review: {
    decision: ReviewDecision;
    checklist: Record<string, unknown>;
    belongsToSubject: boolean;
    pinsRun: boolean;
    redactionPolicyVersion: string;
  };
  /**
   * Does the public projection identify the player — by name, by handle, or by
   * being about somebody a reader can obviously recognise?
   *
   * Declared by the editor rather than inferred, because the honest answer is
   * often "yes, because everyone knows who played this game" and no string
   * comparison finds that. It is the one rule here the database cannot check,
   * which is the reason this module is not merely a copy of the trigger.
   */
  identifiesPlayerPublicly: boolean;
}

export interface Blocker {
  code: string;
  detail: string;
}

export interface Readiness {
  ready: boolean;
  blockers: Blocker[];
}

export function publicationReadiness(
  candidate: ReadinessCandidate,
  now = new Date(),
): Readiness {
  const blockers: Blocker[] = [];
  const block = (code: string, detail: string): void => {
    blockers.push({ code, detail });
  };

  if (!isValidSlug(candidate.slug)) {
    block("slug_invalid", "A slug is lower-case words joined by hyphens, 3 to 80 characters.");
  }
  if (candidate.title.trim().length < 3) block("title_missing", "A case study needs a title.");
  if (candidate.summary.trim().length < 20) {
    block("summary_missing", "A case study needs a summary a reader can judge it by.");
  }

  if (candidate.subject.kind !== "editorial" && candidate.subject.kind !== "case_study") {
    block(
      "subject_not_editorial",
      "Only an editorial or case-study subject may be published. A personal subject is somebody's private account.",
    );
  }
  if (candidate.subject.hasAccountOwner) {
    block("subject_has_owner", "A published subject cannot belong to an account holder.");
  }

  if (candidate.run.status !== "succeeded" || candidate.run.outputManifestHash === null) {
    block(
      "run_not_succeeded",
      "The pinned run must have succeeded and carry an output manifest. Publishing an unfinished run publishes a number no integrity check ever passed.",
    );
  }
  if (!candidate.run.belongsToSubject) {
    block("run_subject_mismatch", "The pinned run analysed a different subject.");
  }
  if (!candidate.publication.belongsToSubject || !candidate.publication.pinsRun) {
    block(
      "publication_mismatch",
      "The publication history row does not install this run for this subject.",
    );
  }

  if (candidate.source.permissionBasis === "licence") {
    if (!candidate.source.licenceKey || !candidate.source.licenceUrl) {
      block("licence_unnamed", "A licensed source must name its licence and where to read it.");
    }
    if (!candidate.source.attributionText) {
      block("attribution_missing", "A licensed source must carry the credit line it requires.");
    }
  }

  if (candidate.source.permissionBasis === "consent") {
    if (candidate.consent === null) {
      block("consent_missing", "A consent-based source needs a recorded consent.");
    } else {
      if (!candidate.consent.belongsToSubject) {
        block("consent_subject_mismatch", "The recorded consent is for a different subject.");
      }
      if (candidate.consent.withdrawnAt !== null) {
        block("consent_withdrawn", "Consent for this subject has been withdrawn.");
      }
      if (candidate.consent.expiresAt !== null && candidate.consent.expiresAt <= now) {
        block("consent_expired", "Consent for this subject has expired.");
      }
    }
  }

  // The rule with no database equivalent. Naming the player is a second
  // disclosure and needs the consent that covers it.
  if (candidate.identifiesPlayerPublicly && candidate.source.permissionBasis === "consent") {
    if (candidate.consent === null || candidate.consent.scope !== "publish_analysis_with_handle") {
      block(
        "handle_consent_missing",
        "This study identifies the player, and the recorded consent covers publishing the analysis but not their name.",
      );
    }
  }

  if (candidate.review.decision !== "approved") {
    block("review_not_approved", "The cited editorial review did not approve.");
  }
  const missing = REVIEW_CHECKLIST_KEYS.filter(
    (key) => candidate.review.checklist[key] !== true,
  );
  if (missing.length > 0) {
    block("review_incomplete", `The review did not confirm: ${missing.join(", ")}.`);
  }
  if (!candidate.review.belongsToSubject || !candidate.review.pinsRun) {
    block("review_mismatch", "The cited review is for a different subject or run.");
  }
  if (candidate.review.redactionPolicyVersion !== candidate.redactionPolicyVersion) {
    block(
      "redaction_policy_mismatch",
      "The review approved a different redaction policy version. A change to what is withheld is a change to what was approved.",
    );
  }

  return { ready: blockers.length === 0, blockers };
}
