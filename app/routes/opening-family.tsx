/**
 * `/openings/:familySlug` — the same screen with one line open.
 *
 * Deliberately a re-export rather than a second module. The whole point of the
 * consolidation was that one product idea had been built twice; a family view
 * with its own layout would be the third. The loader reads the slug off the
 * path, opens that row, and fetches the family-focused graph so the walk
 * appears under the sheet.
 */
export { clientLoader, ErrorBoundary, meta, shouldRevalidate } from "./openings";
export { default } from "./openings";
