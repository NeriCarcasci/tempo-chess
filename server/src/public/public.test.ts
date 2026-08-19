/**
 * `npm run public:unit` — E20's invariants, offline.
 *
 * The load-bearing assertions: a suppressed cell cannot be recovered by
 * subtraction, a hidden profile is indistinguishable from an absent one, a
 * provider handle needs two opt-ins, a case study cannot be published without
 * every one of its grounds, withdrawing consent takes it down, and no public
 * projection carries a field from the forbidden list.
 */

import { strict as assert } from "node:assert";

import {
  DIRECTORY_MIN_QUERY_LENGTH,
  REDACTION_POLICY_VERSION,
  SMALL_CELL_THRESHOLD,
  escapeLikePrefix,
  forbiddenPublicFields,
  isValidHandle,
  isValidSlug,
  normalizeHandle,
} from "./contract.js";
import { publicFigure, suppressSmallCells } from "./suppression.js";
import {
  caseStudyRedactions,
  caseStudyView,
  directoryProfile,
  directoryRedactions,
  contentChecksum,
  isServable,
  type CaseStudyRecord,
  type DirectoryProfileRecord,
} from "./projection.js";
import { publicationReadiness, type ReadinessCandidate } from "./readiness.js";

const failures: string[] = [];
let passed = 0;

function test(name: string, run: () => void): void {
  try {
    run();
    passed += 1;
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const NOW = new Date("2026-08-19T12:00:00Z");
const daysFrom = (days: number): Date => new Date(NOW.getTime() + days * 86_400_000);

// ---------------------------------------------------------------------------
// Small-cell suppression
// ---------------------------------------------------------------------------

test("a cell under the threshold is withheld and a cell over it is not", () => {
  const result = suppressSmallCells([
    { key: "lichess", count: 4 },
    { key: "chesscom", count: 900 },
  ]);
  const lichess = result.cells.find((cell) => cell.key === "lichess")!;
  const chesscom = result.cells.find((cell) => cell.key === "chesscom")!;
  assert.equal(lichess.figure.disclosure, "suppressed");
  // Rule 2: with the total published, `lichess` would be 904 - 900.
  assert.equal(chesscom.figure.disclosure, "suppressed");
  assert.deepEqual([...result.suppressedKeys].sort(), ["chesscom", "lichess"]);
});

test("a withheld cell cannot be recovered by subtracting the published ones", () => {
  const cells = [
    { key: "a", count: 3 },
    { key: "b", count: 50 },
    { key: "c", count: 70 },
  ];
  const result = suppressSmallCells(cells);
  const published = result.cells.filter((cell) => cell.figure.disclosure === "exact");
  const publishedSum = published.reduce(
    (sum, cell) => sum + (cell.figure.disclosure === "exact" ? cell.figure.value : 0),
    0,
  );
  const total = result.total;
  assert.equal(total.disclosure, "exact");
  const remainder = (total as { value: number }).value - publishedSum;
  // The remainder covers two withheld cells, so it names neither of them.
  assert.equal(result.suppressedKeys.length >= 2, true);
  assert.equal(remainder > 0, true);
});

test("zero is published, because it names nobody", () => {
  const result = suppressSmallCells([
    { key: "lichess", count: 0 },
    { key: "chesscom", count: 40 },
  ]);
  assert.deepEqual(result.cells[0]!.figure, { disclosure: "exact", value: 0 });
  assert.deepEqual(result.suppressedKeys, []);
  assert.deepEqual(result.total, { disclosure: "exact", value: 40 });
});

test("a lone small cell suppresses the total as well", () => {
  const result = suppressSmallCells([{ key: "lichess", count: 3 }]);
  assert.equal(result.cells[0]!.figure.disclosure, "suppressed");
  assert.equal(result.total.disclosure, "suppressed");
});

test("a zero cell is not used to hide behind when a real one is available", () => {
  const result = suppressSmallCells([
    { key: "a", count: 2 },
    { key: "b", count: 0 },
    { key: "c", count: 30 },
  ]);
  const complement = result.cells.find((cell) => cell.key === "c")!;
  assert.equal(complement.figure.disclosure, "suppressed");
  assert.equal(result.cells.find((cell) => cell.key === "b")!.figure.disclosure, "exact");
});

test("the threshold is a constant, not a number chosen per call site", () => {
  assert.equal(SMALL_CELL_THRESHOLD, 10);
  assert.deepEqual(publicFigure(SMALL_CELL_THRESHOLD), {
    disclosure: "exact",
    value: SMALL_CELL_THRESHOLD,
  });
  assert.equal(publicFigure(SMALL_CELL_THRESHOLD - 1).disclosure, "suppressed");
});

test("a suppressed figure says what it is, not that we do not know", () => {
  const figure = publicFigure(2);
  assert.equal(figure.disclosure, "suppressed");
  assert.equal((figure as { below: number }).below, SMALL_CELL_THRESHOLD);
});

// ---------------------------------------------------------------------------
// The directory
// ---------------------------------------------------------------------------

const profile = (over: Partial<DirectoryProfileRecord> = {}): DirectoryProfileRecord => ({
  handle: "annika",
  displayName: "Annika",
  avatarUrl: null,
  isDiscoverable: true,
  showProviderHandles: false,
  providerHandles: [{ provider: "lichess", handle: "annika_plays" }],
  ...over,
});

test("an undiscoverable profile projects to nothing at all", () => {
  assert.equal(directoryProfile(profile({ isDiscoverable: false })), null);
});

test("a provider handle needs the profile's opt-in, not just the account's", () => {
  const hidden = directoryProfile(profile())!;
  assert.deepEqual(hidden.providerHandles, []);
  const shown = directoryProfile(profile({ showProviderHandles: true }))!;
  assert.deepEqual(shown.providerHandles, [{ provider: "lichess", handle: "annika_plays" }]);
});

test("withholding provider handles is named in the redaction block", () => {
  assert.deepEqual(directoryRedactions(profile()), [
    { path: "data.providerHandles", reason: "projection" },
  ]);
  assert.deepEqual(directoryRedactions(profile({ showProviderHandles: true })), []);
});

test("a public profile carries no forbidden field", () => {
  const view = directoryProfile(profile({ showProviderHandles: true }))!;
  assert.deepEqual(forbiddenPublicFields(view), []);
  assert.equal("userId" in view, false);
});

test("the directory query floor is two characters", () => {
  assert.equal(DIRECTORY_MIN_QUERY_LENGTH, 2);
});

test("a like wildcard in a query is escaped rather than honoured", () => {
  assert.equal(escapeLikePrefix("%"), "\\%");
  assert.equal(escapeLikePrefix("a_b"), "a\\_b");
  assert.equal(escapeLikePrefix("100%_off\\"), "100\\%\\_off\\\\");
});

test("handles normalize by case and trim, and nothing else", () => {
  assert.equal(normalizeHandle("  AnniKa "), "annika");
  assert.equal(isValidHandle("annika"), true);
  assert.equal(isValidHandle("a"), false);
  assert.equal(isValidHandle("bad handle"), false);
  assert.equal(isValidHandle("-leading"), false);
});

// ---------------------------------------------------------------------------
// Case-study projection
// ---------------------------------------------------------------------------

const record = (over: Partial<CaseStudyRecord> = {}): CaseStudyRecord => ({
  slug: "the-immortal-game",
  publicState: "published",
  title: "The Immortal Game, read by Forma",
  summary: "What a modern read of a famous attacking game does and does not tell you.",
  caveats: ["One game is not an estimate of anybody's strength."],
  contentSha256: "a".repeat(64),
  publishedAt: new Date("2026-08-01T00:00:00Z"),
  withdrawnAt: null,
  redactionPolicyVersion: REDACTION_POLICY_VERSION,
  subjectLabel: "Anderssen, 1851",
  subjectKind: "editorial",
  runId: "11111111-1111-4111-8111-111111111111",
  publicationId: "22222222-2222-4222-8222-222222222222",
  publicationAt: new Date("2026-07-31T00:00:00Z"),
  recipeVersionId: "33333333-3333-4333-8333-333333333333",
  sourceKind: "historic_archive",
  sourceTitle: "London 1851 game collection",
  sourcePublisher: "Public archive",
  sourceUrl: "https://example.org/london-1851",
  sourceRetrievedAt: new Date("2026-06-01T00:00:00Z"),
  permissionBasis: "public_domain",
  licenceKey: null,
  licenceUrl: null,
  attributionText: null,
  reviewedAt: new Date("2026-07-31T12:00:00Z"),
  consentRecorded: false,
  consentWithdrawnAt: null,
  consentExpiresAt: null,
  ...over,
});

test("a published study with standing consent is servable", () => {
  assert.equal(isServable(record(), NOW), true);
  assert.equal(
    isServable(record({ consentRecorded: true, consentExpiresAt: daysFrom(30) }), NOW),
    true,
  );
});

test("withdrawn consent takes a study down on the next read, not on the next job", () => {
  const withdrawn = record({ consentRecorded: true, consentWithdrawnAt: daysFrom(-1) });
  assert.equal(withdrawn.publicState, "published");
  assert.equal(isServable(withdrawn, NOW), false);
});

test("expired consent takes a study down too", () => {
  assert.equal(
    isServable(record({ consentRecorded: true, consentExpiresAt: daysFrom(-1) }), NOW),
    false,
  );
});

test("a withdrawn study is not servable whatever else is true of it", () => {
  assert.equal(isServable(record({ publicState: "withdrawn", withdrawnAt: NOW }), NOW), false);
  assert.equal(isServable(record({ publicState: "draft", publishedAt: null }), NOW), false);
});

test("the public view carries the source, the basis and the publication behind it", () => {
  const view = caseStudyView(record());
  assert.equal(view.source.kind, "historic_archive");
  assert.equal(view.permissionBasis, "public_domain");
  assert.equal(view.version.publicationId, "22222222-2222-4222-8222-222222222222");
  assert.equal(view.version.redactionPolicyVersion, REDACTION_POLICY_VERSION);
  assert.equal(view.editorial, true);
  assert.equal(view.caveats.length, 1);
});

test("a licensed source publishes its licence and its credit line", () => {
  const view = caseStudyView(
    record({
      permissionBasis: "licence",
      licenceKey: "cc-by-4.0",
      licenceUrl: "https://creativecommons.org/licenses/by/4.0/",
      attributionText: "Games courtesy of the archive.",
    }),
  );
  assert.deepEqual(view.source.licence, {
    key: "cc-by-4.0",
    url: "https://creativecommons.org/licenses/by/4.0/",
  });
  assert.equal(view.source.attribution, "Games courtesy of the archive.");
});

test("the public view carries no forbidden field, consent included", () => {
  const view = caseStudyView(record({ consentRecorded: true }));
  assert.deepEqual(forbiddenPublicFields(view), []);
  assert.equal(JSON.stringify(view).includes("consentArtifact"), false);
});

test("the redaction block names what the surface does not carry", () => {
  const paths = caseStudyRedactions(record({ consentRecorded: true })).map((r) => r.path);
  assert.deepEqual(paths, ["data.subject.account", "data.analysis", "data.consent"]);
});

test("the forbidden-field scanner finds a leak at any depth and names it", () => {
  const leak = { items: [{ nested: { linkedAccountId: "x" } }] };
  assert.deepEqual(forbiddenPublicFields(leak), ["data.items[0].nested.linkedAccountId"]);
});

test("slugs are lower-case words joined by hyphens", () => {
  assert.equal(isValidSlug("the-immortal-game"), true);
  assert.equal(isValidSlug("The-Immortal"), false);
  assert.equal(isValidSlug("no"), false);
  assert.equal(isValidSlug("trailing-"), false);
  assert.equal(isValidSlug("a".repeat(81)), false);
});

// ---------------------------------------------------------------------------
// Publication readiness
// ---------------------------------------------------------------------------

const candidate = (over: Partial<ReadinessCandidate> = {}): ReadinessCandidate => ({
  slug: "the-immortal-game",
  title: "The Immortal Game, read by Forma",
  summary: "What a modern read of a famous attacking game does and does not tell you.",
  redactionPolicyVersion: REDACTION_POLICY_VERSION,
  subject: { kind: "editorial", hasAccountOwner: false },
  run: { status: "succeeded", outputManifestHash: "b".repeat(64), belongsToSubject: true },
  publication: { belongsToSubject: true, pinsRun: true },
  source: {
    permissionBasis: "public_domain",
    licenceKey: null,
    licenceUrl: null,
    attributionText: null,
  },
  consent: null,
  review: {
    decision: "approved",
    checklist: {
      source_verified: true,
      licence_verified: true,
      consent_verified: true,
      redactions_verified: true,
      facts_unchanged: true,
    },
    belongsToSubject: true,
    pinsRun: true,
    redactionPolicyVersion: REDACTION_POLICY_VERSION,
  },
  identifiesPlayerPublicly: false,
  ...over,
});

const codes = (result: { blockers: { code: string }[] }): string[] =>
  result.blockers.map((blocker) => blocker.code);

test("a complete candidate is ready", () => {
  const result = publicationReadiness(candidate(), NOW);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.ready, true);
});

test("a personal subject can never be published", () => {
  const result = publicationReadiness(
    candidate({ subject: { kind: "personal", hasAccountOwner: true } }),
    NOW,
  );
  assert.equal(result.ready, false);
  assert.equal(codes(result).includes("subject_not_editorial"), true);
  assert.equal(codes(result).includes("subject_has_owner"), true);
});

test("an unfinished run cannot be published", () => {
  const result = publicationReadiness(
    candidate({ run: { status: "running", outputManifestHash: null, belongsToSubject: true } }),
    NOW,
  );
  assert.equal(codes(result).includes("run_not_succeeded"), true);
});

test("a licensed source must name its licence and carry its credit line", () => {
  const result = publicationReadiness(
    candidate({
      source: {
        permissionBasis: "licence",
        licenceKey: null,
        licenceUrl: null,
        attributionText: null,
      },
    }),
    NOW,
  );
  assert.deepEqual(codes(result).sort(), ["attribution_missing", "licence_unnamed"]);
});

test("a consent-based source without a consent record is refused", () => {
  const result = publicationReadiness(
    candidate({
      source: {
        permissionBasis: "consent",
        licenceKey: null,
        licenceUrl: null,
        attributionText: null,
      },
      consent: null,
    }),
    NOW,
  );
  assert.equal(codes(result).includes("consent_missing"), true);
});

test("withdrawn and expired consent are both refusals, with different reasons", () => {
  const consentSource = {
    permissionBasis: "consent" as const,
    licenceKey: null,
    licenceUrl: null,
    attributionText: null,
  };
  const withdrawn = publicationReadiness(
    candidate({
      source: consentSource,
      consent: {
        belongsToSubject: true,
        scope: "publish_analysis",
        withdrawnAt: daysFrom(-1),
        expiresAt: null,
      },
    }),
    NOW,
  );
  assert.equal(codes(withdrawn).includes("consent_withdrawn"), true);
  const expired = publicationReadiness(
    candidate({
      source: consentSource,
      consent: {
        belongsToSubject: true,
        scope: "publish_analysis",
        withdrawnAt: null,
        expiresAt: daysFrom(-1),
      },
    }),
    NOW,
  );
  assert.equal(codes(expired).includes("consent_expired"), true);
});

test("naming the player needs the consent that covers naming them", () => {
  const consentSource = {
    permissionBasis: "consent" as const,
    licenceKey: null,
    licenceUrl: null,
    attributionText: null,
  };
  const narrow = publicationReadiness(
    candidate({
      source: consentSource,
      identifiesPlayerPublicly: true,
      consent: {
        belongsToSubject: true,
        scope: "publish_analysis",
        withdrawnAt: null,
        expiresAt: null,
      },
    }),
    NOW,
  );
  assert.equal(codes(narrow).includes("handle_consent_missing"), true);
  const wide = publicationReadiness(
    candidate({
      source: consentSource,
      identifiesPlayerPublicly: true,
      consent: {
        belongsToSubject: true,
        scope: "publish_analysis_with_handle",
        withdrawnAt: null,
        expiresAt: null,
      },
    }),
    NOW,
  );
  assert.equal(wide.ready, true);
});

test("an approval with a box unticked is not an approval", () => {
  const result = publicationReadiness(
    candidate({
      review: {
        decision: "approved",
        checklist: {
          source_verified: true,
          licence_verified: true,
          consent_verified: true,
          redactions_verified: true,
          facts_unchanged: false,
        },
        belongsToSubject: true,
        pinsRun: true,
        redactionPolicyVersion: REDACTION_POLICY_VERSION,
      },
    }),
    NOW,
  );
  assert.equal(result.ready, false);
  assert.equal(codes(result).includes("review_incomplete"), true);
});

test("a review of a different redaction policy does not carry over", () => {
  const result = publicationReadiness(
    candidate({
      review: {
        ...candidate().review,
        redactionPolicyVersion: "2026-01-a",
      },
    }),
    NOW,
  );
  assert.equal(codes(result).includes("redaction_policy_mismatch"), true);
});

test("every reason comes back at once, not the first one", () => {
  const result = publicationReadiness(
    candidate({
      slug: "NOPE",
      subject: { kind: "personal", hasAccountOwner: true },
      run: { status: "failed", outputManifestHash: null, belongsToSubject: false },
    }),
    NOW,
  );
  assert.equal(result.blockers.length >= 5, true);
  for (const blocker of result.blockers) {
    assert.equal(blocker.detail.length > 10, true, `${blocker.code} has no explanation`);
  }
});

// ---------------------------------------------------------------------------
// The reviewed checksum
// ---------------------------------------------------------------------------

test("the checksum is over the public words, not over the row", () => {
  const base = {
    slug: "a-study",
    title: "A study",
    summary: "A summary long enough to be a summary.",
    caveats: ["One."],
    redactionPolicyVersion: REDACTION_POLICY_VERSION,
  };
  assert.equal(contentChecksum(base), contentChecksum({ ...base }));
  assert.notEqual(contentChecksum(base), contentChecksum({ ...base, caveats: [] }));
  assert.notEqual(
    contentChecksum(base),
    contentChecksum({ ...base, redactionPolicyVersion: "2026-01-a" }),
  );
  assert.match(contentChecksum(base), /^[0-9a-f]{64}$/);
});

// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`public:unit — ${failures.length} failed, ${passed} passed`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`public:unit — ${passed}/${passed} passed`);
