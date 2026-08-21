import { redirect } from "react-router";

/**
 * `/explorer` — folded into `/openings`.
 *
 * This route was the `/v1` half of a product idea the app had built twice: the
 * walk, on the canonical position graph, beside a legacy `/openings` that still
 * had the tear sheet, the family rows and the verdicts. Keeping both meant two
 * screens making claims from two different definitions of a mistake.
 *
 * `/openings` now reads the same `GET /v1/openings/explorer` and carries the
 * walk under the sheet on `/openings/:familySlug`, so there is nothing here that
 * is not there. The route survives as a redirect rather than being deleted:
 * `/explorer` has been linked from the product nav and from notes, and a 404 on
 * a URL somebody bookmarked is a worse answer than the page they were looking
 * for.
 */
export function clientLoader() {
  throw redirect("/openings");
}

/** Never rendered: the loader always redirects. */
export default function ExplorerRedirect() {
  return null;
}
