import { entitlementName, sectionTitle } from "../../lib/onboarding/copy";

/**
 * Something the report has and did not show.
 *
 * Withheld items are filtered out of `items` entirely rather than nulled, so
 * without this the reader sees a shorter report and no reason. Named and
 * counted: "you may not see this" is a different sentence from "there is
 * nothing here", and only one of them is true.
 */
export function WithheldNote({
  entry,
}: {
  entry: { section: string; count: number; entitlementKey: string };
}) {
  return (
    <p className="redaction">
      <b>
        {entitlementName(entry.entitlementKey)} in {sectionTitle(entry.section).toLowerCase()}
      </b>{" "}
      — {entry.count} {entry.count === 1 ? "item" : "items"} on a paid plan.{" "}
      <a href="/pricing">See what is included</a>.
    </p>
  );
}
