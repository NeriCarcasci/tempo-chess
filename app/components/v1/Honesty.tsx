/**
 * The components that carry Forma's actual claim.
 *
 * The API is careful about the difference between "we do not know", "there is
 * nothing", "you may not see this" and "here is the number". That care survives
 * or dies in the interface, and it dies quietly: every one of those becomes an
 * empty div unless something renders them apart.
 *
 * They follow the sheet's own rules rather than inventing a second style.
 * Nothing here is fenced off with a 1px border — a card is a surface with
 * elevation, a tag is small type in a colour, and the display face stays on the
 * marketing site where it belongs. The styling lives in `app.css` beside the
 * rest of the product's classes, because a component that carries its own
 * inline palette is a component that drifts from the sheet the first time a
 * token changes.
 */

import type { ReactNode } from "react";
import type { ClaimState, CoverageState, PublicFigure, VersionBlock } from "../../lib/v1/types";
import type { Redaction } from "../../lib/v1/client";
import { describeProblem, ProblemError } from "../../lib/v1/problem";

// ---------------------------------------------------------------------------
// Coverage — how much evidence stands behind a claim
// ---------------------------------------------------------------------------

const COVERAGE_COPY: Record<CoverageState, { label: string; blurb: string; tone: string }> = {
  insufficient: {
    label: "Not enough yet",
    blurb: "There is too little here to say anything honestly.",
    tone: "tag-sub",
  },
  limited: {
    label: "Limited",
    blurb: "Enough for a first read, not enough to be sure.",
    tone: "tag-mistake",
  },
  // Not an absence. The evidence may be ample; the estimator will not place it
  // on a scale it was never calibrated for, which is a refusal and reads as one.
  out_of_range: {
    label: "Outside the calibrated band",
    blurb: "Your rating sits outside the range Forma has calibrated, so it will not put a figure here.",
    tone: "tag-sub",
  },
  sufficient: {
    label: "Sufficient",
    blurb: "Enough games behind this to stand on.",
    tone: "tag-win",
  },
};

export function CoverageBadge({
  state,
  dimension,
  showBlurb = false,
}: {
  /** Widened deliberately: `overallState` is nullable and the set can grow. */
  state: CoverageState | string | null;
  /** What the coverage is *of*, when it is not the whole report. */
  dimension?: string;
  showBlurb?: boolean;
}) {
  // An unmapped or absent state is "we have not worked this out", which is the
  // truthful reading and also the safe one: indexing a closed map with an open
  // string and dereferencing it unguarded would take the whole page down.
  const copy = (state && COVERAGE_COPY[state as CoverageState]) || {
    label: "Not worked out yet",
    blurb: "Forma has not judged how much evidence stands behind this.",
    tone: "tag-sub",
  };
  return (
    <span>
      <span className={`tag ${copy.tone}`}>
        {copy.label}
        {dimension ? ` · ${dimension}` : ""}
      </span>
      {showBlurb ? <p className="tag-note">{copy.blurb}</p> : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// An estimate, with the interval it came with
// ---------------------------------------------------------------------------

/**
 * A number Forma produced, shown with its uncertainty.
 *
 * A point estimate on its own is a stronger claim than the one the estimator
 * made. When the value is null the component says so in words rather than
 * drawing a zero — an estimate of nothing and an estimate of zero are opposite
 * statements.
 */
export function Estimate({
  value,
  low,
  high,
  format = (n) => n.toFixed(2),
  unavailableReason,
}: {
  value: number | null;
  low?: number | null;
  high?: number | null;
  format?: (value: number) => string;
  unavailableReason?: string | null;
}) {
  if (value === null) {
    return (
      <span className="estimate-none">
        {unavailableReason === "metric_not_estimated"
          ? "Not measured in this report"
          : "Not enough evidence yet"}
      </span>
    );
  }
  const hasInterval = low !== null && low !== undefined && high !== null && high !== undefined;
  return (
    <span className="estimate">
      <b>{format(value)}</b>
      {hasInterval ? (
        <span>
          {format(low!)}–{format(high!)}
        </span>
      ) : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// A public figure — the number, or an honest refusal
// ---------------------------------------------------------------------------

export function Figure({ figure }: { figure: PublicFigure }) {
  if (figure.disclosure === "exact") {
    return <span className="figure">{figure.value.toLocaleString()}</span>;
  }
  // Withheld because the cell is small enough to be a person, not because it is
  // unknown. "Fewer than ten" is the true statement; "0" and "—" are not.
  return <span className="figure">fewer than {figure.below}</span>;
}

// ---------------------------------------------------------------------------
// Claim state — what the evidence supports, and what it does not
// ---------------------------------------------------------------------------

const CLAIM_COPY: Record<ClaimState, { label: string; tone: string }> = {
  target_met: { label: "Target met", tone: "tag-win" },
  improving: { label: "Improving", tone: "tag-signal" },
  early_signal: { label: "Early signal", tone: "tag-warn" },
  no_evidence: { label: "No evidence yet", tone: "tag-sub" },
  declined: { label: "Gone backwards", tone: "tag-loss" },
  unavailable: { label: "Not measured", tone: "tag-sub" },
};

/**
 * Only `target_met` may be drawn as success, and `declined` is always shown.
 *
 * A coaching product that reports only good news is an advertisement, and one
 * that lets an activity counter stand in for progress is worse: it teaches
 * somebody that doing the drills is the same as getting better.
 */
export function ClaimBadge({ state }: { state: ClaimState | string | null }) {
  const copy = (state && CLAIM_COPY[state as ClaimState]) || {
    label: "Not measured",
    tone: "tag-sub",
  };
  return <span className={`tag ${copy.tone}`}>{copy.label}</span>;
}

// ---------------------------------------------------------------------------
// The version block — which analysis said this, and when
// ---------------------------------------------------------------------------

export function VersionNote({
  version,
  gameCount,
}: {
  version: VersionBlock | null;
  gameCount?: number | null;
}) {
  if (!version) return <p className="provenance">Not yet analysed</p>;
  const when = new Date(version.generatedAt).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  return (
    <p className="provenance" title={`Publication ${version.publicationId}`}>
      Analysed {when}
      {gameCount ? ` · ${gameCount} games` : ""}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Redactions — named, never silently absent
// ---------------------------------------------------------------------------

/**
 * Something the response deliberately withheld.
 *
 * `entitlement` is a lock with a way out. `projection` is "this screen does not
 * carry that", which is a navigation problem rather than a paywall, and saying
 * so is the difference between a product that feels incomplete and one that
 * feels organised.
 */
export function RedactionNote({
  redaction,
  what,
  where,
}: {
  redaction: Redaction;
  /** What the field is, in the person's words. */
  what: string;
  /** For a projection: where it can be seen. */
  where?: ReactNode;
}) {
  if (redaction.reason === "entitlement") {
    return (
      <p className="redaction">
        <b>{what}</b> is part of a paid plan. <a href="/pricing">See what is included</a>.
      </p>
    );
  }
  return (
    <p className="redaction">
      <b>{what}</b> — not shown on this screen{where ? <>; see {where}</> : null}.
    </p>
  );
}

// ---------------------------------------------------------------------------
// Empty states — a sentence, never a blank
// ---------------------------------------------------------------------------

export function EmptyState({
  title,
  detail,
  action,
}: {
  title: string;
  detail: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-card">
      <strong>{title}</strong>
      <p>{detail}</p>
      {action}
    </div>
  );
}

/** The practice queue's three empty states, which are three different days. */
export function PracticeEmpty({
  reason,
  onRefill,
}: {
  reason: "nothing_due" | "no_material" | "queue_full" | null;
  onRefill?: ReactNode;
}) {
  if (reason === "nothing_due") {
    return (
      <EmptyState
        title="You are up to date"
        detail="Everything due has been practised. The next review comes back on its own; spacing it out is what makes it stick."
      />
    );
  }
  if (reason === "queue_full") {
    return (
      <EmptyState
        title="There is enough here already"
        detail="Clear some of what you have before taking on more. A queue that only grows stops being useful."
      />
    );
  }
  return (
    <EmptyState
      title="Nothing worth drilling yet"
      detail="Forma builds drills from positions in your own games where a better move was available. Play a few more and they will appear."
      action={onRefill}
    />
  );
}

// ---------------------------------------------------------------------------
// Failure — one surface, one vocabulary
// ---------------------------------------------------------------------------

export function ProblemNote({ error, retry }: { error: unknown; retry?: ReactNode }) {
  const problem =
    error instanceof ProblemError
      ? describeProblem(error)
      : { title: "Something went wrong", detail: "Try again in a moment." };
  const requestId = error instanceof ProblemError ? error.requestId : null;

  return (
    <div className="problem-card" role="alert">
      <strong>{problem.title}</strong>
      <p>{problem.detail}</p>
      {retry}
      {/* Lower case and selectable: a string somebody copies into an email. */}
      {requestId ? <p className="problem-ref">{requestId}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Work in progress — never a silent wait
// ---------------------------------------------------------------------------

/**
 * Something is running.
 *
 * `percent` is null while the total is unknown, and an indeterminate bar is the
 * honest rendering of that: a 0% bar that never moves for four minutes is worse
 * than no bar, because it looks broken.
 */
export function WorkingStrip({
  label,
  percent,
  detail,
}: {
  label: string;
  percent: number | null;
  detail?: string;
}) {
  return (
    <div className="working">
      <div className="working-head">
        <p>{label}</p>
        {percent === null ? null : <span>{Math.round(percent)}%</span>}
      </div>
      <div
        className="working-track"
        role="progressbar"
        aria-valuenow={percent ?? undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        {/* The width is the percentage. It was hardcoded to `0%`, which is how
            this strip spent every run of the examination sitting at zero while
            the figure beside it climbed — the one failure a progress bar cannot
            survive, because a bar that never moves reads as a bar that is
            broken. An indeterminate bar sets no width at all: the sweep
            animation owns the fill, and a width would pin it. */}
        <div
          className={`working-fill${percent === null ? " working-indeterminate" : ""}`}
          style={percent === null ? undefined : { width: `${Math.round(percent)}%` }}
        />
      </div>
      {detail ? <p className="working-detail">{detail}</p> : null}
    </div>
  );
}
