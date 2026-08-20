/**
 * `npm run public:security` — what an anonymous caller can get out of the
 * public surface.
 *
 * The interesting failures on a public API are not "it let me in". They are:
 * a field nobody meant to publish riding along in a body, a 404 that is
 * distinguishable from a 403 and therefore answers "does this person have an
 * account", a rate limit that lets somebody walk the alphabet, and a log line
 * that quietly builds a record of who looked up whom.
 *
 * So the assertions here are made against real HTTP responses from the real
 * kernel, scanned rather than eyeballed.
 */

import assert from "node:assert/strict";
import postgres from "postgres";
import { GateReport, startKernelHarness } from "../../v1/gates/harness.js";
import { grantRolePasswords } from "../../platform/harness/postgres.js";
import { forbiddenPublicFields } from "../contract.js";
import { insertCaseStudy, seedEditorial } from "./fixture.js";

const report = new GateReport("E20 public projections security gate");
const harness = await startKernelHarness();
const owner = postgres(harness.db.adminUrl, { max: 4, prepare: false, onnotice: () => {} });

/**
 * Every request carries a caller address, because the rate limit counts against
 * one and a gate that sent none would be exercising a different code path than
 * the internet will.
 */
const get = async (
  path: string,
  headers: Record<string, string> = {},
  address = "203.0.113.10",
): Promise<Response> =>
  harness.app.request(`http://gate${path}`, {
    headers: { "cf-connecting-ip": address, ...headers },
  });
const body = async (response: Response): Promise<any> => response.json();

const fixture = await seedEditorial(owner, { permissionBasis: "consent" });
await insertCaseStudy(owner, fixture, { slug: "a-club-players-year" });
await insertCaseStudy(owner, fixture, { slug: "a-withdrawn-study", publicState: "withdrawn" });

const [visible] = await owner<{ user_id: string }[]>`
  insert into app.profiles (user_id) values (gen_random_uuid()) returning user_id
`;
const [hidden] = await owner<{ user_id: string }[]>`
  insert into app.profiles (user_id) values (gen_random_uuid()) returning user_id
`;
await owner`
  insert into social.public_player_profiles (
    user_id, handle, display_name, is_discoverable, show_provider_handles
  ) values (${visible!.user_id}, 'annika', 'Annika', true, true)
`;
await owner`
  insert into social.public_player_profiles (user_id, handle, is_discoverable)
  values (${hidden!.user_id}, 'annibal', false)
`;
const [identity] = await owner<{ id: string }[]>`
  insert into app.provider_identities (
    provider_id, provider_identity_key, key_basis, current_display_username,
    current_normalized_username
  ) values (2, 'gate-security', 'username', 'annika_plays', 'annika_plays')
  returning id
`;
await owner`
  insert into app.linked_accounts (owner_user_id, provider_identity_id, provider_handle_discoverable)
  values (${visible!.user_id}, ${identity!.id}, true)
`;

report.section("the read behind the routes");

await report.check("the case-study read resolves the record the routes project", async () => {
  const { readPublishedCaseStudy } = await import("../editorial.js");
  const record = await readPublishedCaseStudy("a-club-players-year");
  assert.notEqual(record, null, "the published study did not come back");
  assert.equal(record!.publicState, "published");
  // A timestamp arrives from this connection as a string, because drizzle
  // replaces postgres.js's date parsers on construction. The read has to hand
  // the routes a Date whatever the driver is doing.
  assert.equal(record!.publishedAt instanceof Date, true, "published_at is not a date");
  assert.equal(record!.publicationAt instanceof Date, true, "the publication date is not a date");
  assert.equal(record!.consentRecorded, true);
  assert.equal(Array.isArray(record!.caveats), true);
});

report.section("what a public body may carry");

await report.check("no public body carries a forbidden field", async () => {
  const bodies = await Promise.all(
    [
      "/v1/case-studies",
      "/v1/case-studies/a-club-players-year",
      "/v1/directory/players?query=ann",
      "/v1/directory/players/annika",
      "/v1/public/stats",
      "/v1/public/plans",
    ].map(async (path) => ({ path, payload: await body(await get(path)) })),
  );
  for (const { path, payload } of bodies) {
    const found = forbiddenPublicFields(payload.data);
    assert.deepEqual(found, [], `${path} published ${found.join(", ")}`);
  }
});

await report.check("no public body carries an internal identifier by accident", async () => {
  const study = await body(await get("/v1/case-studies/a-club-players-year"));
  const serialized = JSON.stringify(study);
  // The subject, the source, the review and the consent are all internal rows.
  // Their ids are not part of the projection, and the run and publication ids
  // deliberately are: a public claim has to say which analysis produced it.
  assert.equal(serialized.includes(fixture.subjectId), false);
  assert.equal(serialized.includes(fixture.sourceId), false);
  assert.equal(serialized.includes(fixture.reviewId), false);
  assert.equal(serialized.includes(fixture.consentId!), false);
  assert.equal(serialized.includes(fixture.reviewerUserId), false);
  assert.equal(serialized.includes(fixture.runId), true);
});

report.section("hidden is hidden");

await report.check("a hidden profile answers exactly like an unused handle", async () => {
  const hiddenResponse = await get("/v1/directory/players/annibal");
  const unknownResponse = await get("/v1/directory/players/nobodyhere");
  assert.equal(hiddenResponse.status, unknownResponse.status);
  assert.equal(hiddenResponse.status, 404);
  const a = await body(hiddenResponse);
  const b = await body(unknownResponse);
  // Everything but the correlation identifiers has to match, or the difference
  // is the answer to "does this person have an account".
  assert.equal(a.title, b.title);
  assert.equal(a.detail, b.detail);
  assert.equal(a.status, b.status);
});

await report.check("a withdrawn study answers exactly like one that never existed", async () => {
  const withdrawn = await get("/v1/case-studies/a-withdrawn-study");
  const missing = await get("/v1/case-studies/never-published-this");
  assert.equal(withdrawn.status, 404);
  assert.equal(missing.status, 404);
  const a = await body(withdrawn);
  const b = await body(missing);
  assert.equal(a.detail, b.detail);
});

await report.check("a signed-in caller sees the same public surface as anybody else", async () => {
  const anonymous = await body(await get("/v1/case-studies"));
  const bearer = await body(
    await get("/v1/case-studies", { authorization: "Bearer not-a-real-token" }),
  );
  assert.deepEqual(bearer.data, anonymous.data);
});

report.section("enumeration");

await report.check("the directory limit is tight enough to matter", async () => {
  const policy = harness.rateLimit.POLICIES.directorySearch;
  assert.equal(policy.max <= 30, true);
  assert.equal(policy.windowSeconds, 60);
  let limited = false;
  for (let attempt = 0; attempt < policy.max + 2; attempt += 1) {
    const response = await get("/v1/directory/players?query=ann", {}, "203.0.113.77");
    if (response.status === 429) {
      limited = true;
      break;
    }
  }
  assert.equal(limited, true, "the directory never rate limited");
});

await report.check("the directory is never cached by a shared cache", async () => {
  const response = await get("/v1/directory/players/annika");
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
});

report.section("logging");

await report.check("a lookup does not write the handle to the log", async () => {
  const lines: unknown[] = [];
  harness.telemetry.setObservationSink((line: unknown) => lines.push(line));
  try {
    await get("/v1/directory/players/annika");
    await get("/v1/directory/players?query=anni");
  } finally {
    harness.telemetry.setObservationSink(null);
  }
  assert.equal(lines.length > 0, true, "nothing was observed at all");
  const serialized = JSON.stringify(lines);
  assert.equal(serialized.includes("annika"), false, "a looked-up handle reached the log");
  assert.equal(serialized.includes("query="), false, "a search term reached the log");
  assert.equal(serialized.includes("/v1/directory/players/:handle"), true);
});

report.section("least privilege, over the wire");

{
  await grantRolePasswords(harness.db, ["forma_api", "forma_ops"]);
  const api = postgres(harness.db.urlFor("forma_api"), {
    max: 2,
    prepare: false,
    onnotice: () => {},
  });
  try {
    await report.check("the API role cannot publish, withdraw or approve", async () => {
      for (const attempt of [
        () => api`update social.case_study_publications set public_state = 'published'`,
        () => api`
          insert into social.editorial_reviews (
            subject_id, run_id, reviewer_user_id, decision, checklist, redaction_policy_version
          ) values (
            ${fixture.subjectId}, ${fixture.runId}, ${fixture.reviewerUserId}, 'approved',
            '{}'::jsonb, '2026-08-a'
          )
        `,
        () => api`delete from social.case_study_publications`,
      ]) {
        let refused = false;
        try {
          await attempt();
        } catch (error) {
          refused = /permission denied/i.test(
            error instanceof Error ? error.message : String(error),
          );
        }
        assert.equal(refused, true, "the API role was allowed an editorial act");
      }
    });
  } finally {
    await api.end({ timeout: 5 });
  }
}

await owner.end({ timeout: 5 });
await harness.destroy();
report.finish();
