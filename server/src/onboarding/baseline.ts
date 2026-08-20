import { createHash } from "node:crypto";

import {
  PLAN_ENTITLEMENTS,
  type EntitlementKey,
  type Plan,
  type ReportSection,
} from "./contract.js";
import { LIMITATION_TEXT } from "./coverage.js";
import type { CoverageDecision } from "./coverage.js";

/**
 * Building the baseline report, and redacting it honestly.
 *
 * Two rules shape everything here.
 *
 * The first is immutability: a baseline pins the snapshot, run and coverage
 * decision it was built from, and never follows the live pointer afterwards.
 * The manifest hash is what makes that checkable — re-derive it from the stored
 * items and either the report is what it says it is or it is not.
 *
 * The second is that redaction may remove depth and may never remove doubt.
 * Entitlements control how much detail a reader gets; they do not control
 * whether the reader is told the evidence is thin. Every coverage item carries
 * the `always` key, the database refuses one that does not, and
 * `redactForPlan` cannot drop it because it never sees a coverage item it is
 * allowed to remove.
 */

export interface ReportItemInput {
  section: ReportSection;
  itemKind: "finding" | "estimate" | "trajectory" | "coverage" | "narrative";
  findingId?: string | null;
  playerSkillEstimateId?: string | null;
  trajectorySnapshotId?: string | null;
  coverageDimensionKey?: string | null;
  renderedExplanationId?: string | null;
  entitlementKey: EntitlementKey;
}

export interface ReportItem extends ReportItemInput {
  displayOrder: number;
}

export interface BaselineInput {
  coverage: CoverageDecision;
  /** Published findings, already ranked by E15. */
  findings: readonly { id: string; findingType: string; priority: number }[];
  /** Estimates worth showing: the strongest and the weakest, by frame. */
  estimates: readonly { id: string; dimensionKey: string; estimate: number | null }[];
  trajectorySnapshotId: string | null;
  diagnosticSessionId: string | null;
}

/**
 * Lay out the report.
 *
 * Coverage comes second, immediately after the headline, and not at the bottom.
 * A report that states its limitations in a footer has technically disclosed
 * them; a report that states them before the conclusions has actually told you.
 */
export function buildReport(input: BaselineInput): ReportItem[] {
  const items: ReportItemInput[] = [];

  items.push({
    section: "headline",
    itemKind: "narrative",
    entitlementKey: "always",
  });

  // One item per limitation, each carrying `always`. This is the section a
  // paying reader and a free reader see identically.
  for (const limitation of input.coverage.limitations) {
    items.push({
      section: "coverage",
      itemKind: "coverage",
      coverageDimensionKey: limitation,
      entitlementKey: "always",
    });
  }
  for (const dimension of input.coverage.dimensions) {
    if (dimension.state === "sufficient") continue;
    items.push({
      section: "coverage",
      itemKind: "coverage",
      coverageDimensionKey: dimension.dimensionKey,
      entitlementKey: "always",
    });
  }

  for (const finding of input.findings) {
    const section: ReportSection =
      finding.findingType === "strength"
        ? "strengths"
        : finding.findingType === "insufficient_evidence"
          ? "coverage"
          : "constraints";
    items.push({
      section,
      itemKind: section === "coverage" ? "coverage" : "finding",
      findingId: section === "coverage" ? null : finding.id,
      coverageDimensionKey: section === "coverage" ? "insufficient_evidence" : null,
      // A finding about a gap is a coverage item and therefore always visible.
      // A finding about a strength is detail, and detail is what a plan buys.
      entitlementKey: section === "coverage" ? "always" : "free_summary",
    });
  }

  if (input.trajectorySnapshotId !== null) {
    items.push({
      section: "trajectory",
      itemKind: "trajectory",
      trajectorySnapshotId: input.trajectorySnapshotId,
      entitlementKey: "free_summary",
    });
  }

  for (const estimate of input.estimates) {
    items.push({
      section: "constraints",
      itemKind: "estimate",
      playerSkillEstimateId: estimate.id,
      // The per-dimension numbers behind a conclusion are depth, not doubt.
      entitlementKey: "pro_detail",
    });
  }

  if (input.diagnosticSessionId !== null) {
    items.push({
      section: "diagnostic",
      itemKind: "narrative",
      entitlementKey: "free_summary",
    });
  }

  items.push({
    section: "next_steps",
    itemKind: "narrative",
    entitlementKey: "free_summary",
  });

  // Display order is per section, matching the primary key, so two items in
  // different sections never collide and the order inside a section is the
  // order they were laid out in.
  const perSection = new Map<ReportSection, number>();
  return items.map((item) => {
    const order = perSection.get(item.section) ?? 0;
    perSection.set(item.section, order + 1);
    return { ...item, displayOrder: order };
  });
}

/**
 * The manifest hash: a content address for the report.
 *
 * Covers the ordered items and their references, and nothing that changes
 * between runs. Re-deriving it from the stored rows is how a reader confirms
 * the report is the one that was published rather than one that drifted.
 */
export function manifestHash(items: readonly ReportItem[]): string {
  const canonical = items
    .map((item) =>
      [
        item.section,
        item.displayOrder,
        item.itemKind,
        item.findingId ?? "-",
        item.playerSkillEstimateId ?? "-",
        item.trajectorySnapshotId ?? "-",
        item.coverageDimensionKey ?? "-",
        item.entitlementKey,
      ].join("|"),
    )
    .sort();
  return createHash("sha256").update(canonical.join("\n")).digest("hex");
}

export interface RedactedReport {
  items: readonly ReportItem[];
  /** Items withheld, by section, so the reader knows something exists. */
  withheld: readonly { section: ReportSection; count: number; entitlementKey: EntitlementKey }[];
}

/**
 * Show a reader what their plan entitles them to.
 *
 * Withheld items are *counted and named*, never silently dropped. A free reader
 * is told "there are four more constraint details behind a plan", which is an
 * honest offer; a reader shown a report with no sign that anything is missing
 * has been told something false about how much Forma found.
 *
 * A coverage item can never be withheld. It carries `always`, every plan
 * includes `always`, and the database refuses a coverage item with any other
 * key — three independent places, because this is the rule most likely to be
 * quietly relaxed later by someone optimising a conversion funnel.
 */
export function redactForPlan(items: readonly ReportItem[], plan: Plan): RedactedReport {
  const allowed = new Set<EntitlementKey>(PLAN_ENTITLEMENTS[plan]);
  const visible = items.filter((item) => allowed.has(item.entitlementKey));
  const hidden = items.filter((item) => !allowed.has(item.entitlementKey));

  const grouped = new Map<string, { section: ReportSection; count: number; entitlementKey: EntitlementKey }>();
  for (const item of hidden) {
    const key = `${item.section}:${item.entitlementKey}`;
    const existing = grouped.get(key);
    if (existing) existing.count += 1;
    else grouped.set(key, { section: item.section, count: 1, entitlementKey: item.entitlementKey });
  }

  return {
    items: visible,
    withheld: [...grouped.values()].sort(
      (a, b) => a.section.localeCompare(b.section) || a.entitlementKey.localeCompare(b.entitlementKey),
    ),
  };
}

/**
 * The headline sentence, derived from coverage rather than from the findings.
 *
 * A report built on five games opens by saying so. Leading with a conclusion
 * and burying the sample size is the single easiest way to make an honest
 * system feel dishonest.
 */
export function headline(coverage: CoverageDecision): string {
  if (coverage.overallState === "insufficient") {
    return `We do not have enough of your games yet to say much. We looked at ${coverage.eligibleGames}.`;
  }
  if (coverage.overallState === "limited") {
    return `Here is what ${coverage.eligibleGames} of your games show. Some areas are still thin, and they are listed below.`;
  }
  return `Here is what ${coverage.eligibleGames} of your games show.`;
}

/** The sentences behind each limitation, for a caller rendering the section. */
export function limitationText(key: string): string {
  return (LIMITATION_TEXT as Record<string, string | undefined>)[key] ?? "";
}
