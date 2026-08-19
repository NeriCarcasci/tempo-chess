import { Link, redirect, useLoaderData } from "react-router";
import type { Route } from "./+types/report";
import { OnboardingShell } from "../components/onboarding/OnboardingShell";
import { CoveragePanel } from "../components/onboarding/CoveragePanel";
import { WithheldNote } from "../components/onboarding/WithheldNote";
import { EmptyState } from "../components/v1/Honesty";
import { RouteError } from "../components/RouteError";
import { getCoverage, getOnboarding, getReport } from "../lib/onboarding/api";
import {
  humaniseDimension,
  limitationText,
  LIMITATION_TEXT,
  sectionTitle,
  sortSections,
} from "../lib/onboarding/copy";
import type { BaselineReport, OnboardingCoverage } from "../lib/v1/types";
import { requireSession } from "../lib/session";

/**
 * Your baseline report.
 *
 * Coverage leads, then what the report could say, then what it withheld. That
 * order is the argument: a reader who does not know how much evidence is behind
 * a claim cannot judge it.
 *
 * Two things this screen deliberately does not do.
 *
 * It does not offer an "activate" button. Activation needs a chosen goal and an
 * accepted commitment, and nothing in the product writes either yet, so the
 * button could never succeed — and a button that cannot succeed is exactly the
 * dishonesty this product is built against.
 *
 * It does not invent sentences. A report item carries ids and no text, and
 * there is no endpoint that turns a finding id into a sentence, so an item that
 * cannot be rendered is counted rather than described.
 */

export function meta() {
  return [{ title: "Your baseline report · Forma" }];
}

interface LoaderData {
  report: BaselineReport;
  coverage: OnboardingCoverage;
  redactions: { path: string; reason: string }[];
}

export async function clientLoader(): Promise<LoaderData> {
  await requireSession();
  const state = await getOnboarding();
  const reportId = state.baselineReportId ?? state.nextAction.reportId ?? null;
  if (!state.runId || !reportId) throw redirect("/onboarding");

  // Coverage first. Reading the report is a *write* — it records that it was
  // read, before the ETag is even compared — so a coverage failure must not
  // silently consume the one thing that can only happen once.
  const coverage = await getCoverage(state.runId);
  const result = await getReport(reportId);

  return {
    report: result.data,
    coverage,
    redactions: result.meta.redactions ?? [],
  };
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return <RouteError title="Could not open your report" error={error} />;
}

/**
 * A coverage item's key is one of three things — a limitation slug, a dimension
 * key, or the literal `insufficient_evidence` — and none of them is a sentence.
 * Printing it raw is exactly the failure the copy module exists to prevent.
 */
function coverageItemText(key: string | null): string {
  if (!key) return "Coverage";
  if (key in LIMITATION_TEXT) return limitationText(key);
  if (key === "insufficient_evidence") {
    return "There is not enough evidence here to say anything yet.";
  }
  return humaniseDimension(key);
}

export default function Report() {
  const { report, coverage } = useLoaderData<LoaderData>();

  const bySection = new Map<string, typeof report.items>();
  for (const item of report.items) {
    const list = bySection.get(item.section) ?? [];
    list.push(item);
    bySection.set(item.section, list);
  }
  // The server orders by section name, which is alphabetical rather than the
  // intended reading order.
  const sections = sortSections([...bySection.keys()]);

  const published = new Date(report.publishedAt).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  return (
    <OnboardingShell
      title="Your baseline report"
      sub="Built from your own games, and only as strong as what it could read."
      wide
    >
      <div className="onboarding-body">
        <CoveragePanel coverage={coverage} />

        {report.items.length === 0 ? (
          <EmptyState
            title="There is nothing Forma can say yet"
            detail="Your games were read and analysed, but nothing in them rose to something worth telling you. That is a statement about what Forma can currently read, not about how you play."
            action={
              <Link to="/today" className="chip-btn">
                Go to your hub
              </Link>
            }
          />
        ) : (
          sections.map((section) => {
            const items = bySection.get(section) ?? [];
            // Only coverage items have anything renderable today; the rest are
            // counted rather than described, because an id is not a sentence
            // and a made-up sentence is worse than an honest count.
            const describable = items.filter((item) => item.itemKind === "coverage");
            return (
              <section key={section} className="report-section">
                <h2>{sectionTitle(section)}</h2>
                {describable.length > 0 ? (
                  <ul className="coverage-limits">
                    {describable.map((item) => (
                      <li key={`${item.section}-${item.displayOrder}`}>
                        {coverageItemText(item.coverageDimensionKey)}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {items.length > describable.length ? (
                  <p className="report-count">
                    {items.length - describable.length}{" "}
                    {items.length - describable.length === 1 ? "finding" : "findings"} here have
                    no readable form yet.
                  </p>
                ) : null}
              </section>
            );
          })
        )}

        {report.withheld.length > 0 ? (
          <section className="report-section">
            <h2>Not shown on your plan</h2>
            {report.withheld.map((entry) => (
              <WithheldNote key={`${entry.section}-${entry.entitlementKey}`} entry={entry} />
            ))}
          </section>
        ) : null}

        <div className="report-meta">
          <p className="provenance">
            Published {published} · {report.plan === "pro" ? "Pro" : "Free"} plan
          </p>
          <p className="provenance" title={report.manifestSha256}>
            This report is immutable. It will not change under you.
          </p>
        </div>
      </div>
    </OnboardingShell>
  );
}
