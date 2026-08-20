/**
 * `npm run public:integration` — the public surface end to end.
 *
 * Publish a real case study over a real analysis run, read it through the real
 * kernel, withdraw the consent behind it, and read it again. The claim being
 * proven is the one that matters to a person who changed their mind: they say
 * stop, and the next request stops — not the next deploy, and not the next run
 * of a tidy-up job.
 */

import assert from "node:assert/strict";
import postgres from "postgres";
import { GateReport, startKernelHarness } from "../../v1/gates/harness.js";
import { grantRolePasswords } from "../../platform/harness/postgres.js";
import { insertCaseStudy, seedEditorial } from "./fixture.js";

const report = new GateReport("E20 public projections integration gate");
const harness = await startKernelHarness();
const owner = postgres(harness.db.adminUrl, { max: 4, prepare: false, onnotice: () => {} });

// The kernel in this harness connects as `forma_api`, which is exactly what the
// public routes will be. Publishing and withdrawing are editorial acts, so the
// gate performs them over a second connection as `forma_ops` — if the API role
// could do them, the least-privilege claim in the migration gate would be
// false and this gate would be testing the wrong thing.
await grantRolePasswords(harness.db, ["forma_ops"]);
const ops = postgres(harness.db.urlFor("forma_ops"), {
  max: 2,
  prepare: false,
  onnotice: () => {},
});

const get = async (path: string): Promise<Response> =>
  harness.app.request(`http://gate${path}`, {
    headers: { "cf-connecting-ip": "203.0.113.11" },
  });
const body = async (response: Response): Promise<any> => response.json();

report.section("case studies");

{
  const fixture = await seedEditorial(owner, { permissionBasis: "public_domain" });
  await insertCaseStudy(owner, fixture, { slug: "the-immortal-game" });

  await report.check("a published study is listed and readable", async () => {
    const list = await body(await get("/v1/case-studies"));
    assert.equal(list.data.length, 1);
    assert.equal(list.data[0].slug, "the-immortal-game");
    assert.equal(list.data[0].editorial, true);

    const detail = await get("/v1/case-studies/the-immortal-game");
    assert.equal(detail.status, 200);
    const study = await body(detail);
    assert.equal(study.data.permissionBasis, "public_domain");
    assert.equal(study.data.source.title, "London 1851 game collection");
    assert.equal(study.data.version.runId, fixture.runId);
    assert.equal(study.data.version.publicationId, fixture.publicationId);
    assert.equal(study.data.caveats.length, 1);
  });

  await report.check("the response names what this surface does not carry", async () => {
    const study = await body(await get("/v1/case-studies/the-immortal-game"));
    const paths = (study.meta.redactions ?? []).map((r: { path: string }) => r.path);
    assert.equal(paths.includes("data.analysis"), true);
    assert.equal(paths.includes("data.subject.account"), true);
  });

  await report.check("a repeat read is a 304, and the tag changes when the study does", async () => {
    const first = await get("/v1/case-studies/the-immortal-game");
    const etag = first.headers.get("etag");
    assert.notEqual(etag, null);
    const conditional = await harness.app.request(
      "http://gate/v1/case-studies/the-immortal-game",
      { headers: { "if-none-match": etag!, "cf-connecting-ip": "203.0.113.11" } },
    );
    assert.equal(conditional.status, 304);

    await owner`
      update social.case_study_publications
      set title = 'The Immortal Game, re-read by Forma'
      where slug = 'the-immortal-game'
    `;
    const after = await get("/v1/case-studies/the-immortal-game");
    assert.notEqual(after.headers.get("etag"), etag);
  });

  await report.check("a draft is not on the public surface", async () => {
    await insertCaseStudy(owner, fixture, { slug: "not-ready-yet", publicState: "draft" });
    const list = await body(await get("/v1/case-studies"));
    assert.equal(
      list.data.some((row: { slug: string }) => row.slug === "not-ready-yet"),
      false,
    );
    assert.equal((await get("/v1/case-studies/not-ready-yet")).status, 404);
  });

  await report.check("withdrawing a study takes it down and leaves the evidence", async () => {
    const { withdrawCaseStudy } = await import("../editorial.js");
    const withdrawn = await withdrawCaseStudy(
      {
        slug: "the-immortal-game",
        reason: "The estimate was restated in a later study.",
      },
      ops,
    );
    assert.equal(withdrawn, true);
    assert.equal((await get("/v1/case-studies/the-immortal-game")).status, 404);

    const events = await owner<{ event_kind: string; reason: string }[]>`
      select e.event_kind, e.reason
      from social.case_study_publication_events e
      join social.case_study_publications cs on cs.id = e.case_study_id
      where cs.slug = 'the-immortal-game'
      order by e.occurred_at
    `;
    assert.equal(events.at(-1)!.event_kind, "withdrawn");
    const runs = await owner<{ status: string }[]>`
      select status from analysis.runs where id = ${fixture.runId}
    `;
    assert.equal(runs[0]!.status, "succeeded");
  });
}

report.section("consent");

{
  const fixture = await seedEditorial(owner, { permissionBasis: "consent" });
  await insertCaseStudy(owner, fixture, { slug: "a-club-players-year" });

  await report.check("a consented study is public while the consent stands", async () => {
    assert.equal((await get("/v1/case-studies/a-club-players-year")).status, 200);
  });

  await report.check("withdrawing consent takes it down on the next request", async () => {
    const { withdrawConsent } = await import("../editorial.js");
    await withdrawConsent(
      { consentId: fixture.consentId!, note: "They asked us to stop." },
      ops,
    );

    assert.equal((await get("/v1/case-studies/a-club-players-year")).status, 404);
    const list = await body(await get("/v1/case-studies"));
    assert.equal(
      list.data.some((row: { slug: string }) => row.slug === "a-club-players-year"),
      false,
    );

    // The pointer has not moved. Withdrawal of the *study* is a separate,
    // deliberate act; the read path did not need it to stop publishing.
    const rows = await owner<{ public_state: string }[]>`
      select public_state from social.case_study_publications where slug = 'a-club-players-year'
    `;
    assert.equal(rows[0]!.public_state, "published");
  });
}

report.section("the player directory");

{
  const [visible] = await owner<{ user_id: string }[]>`
    insert into app.profiles (user_id) values (gen_random_uuid()) returning user_id
  `;
  const [hidden] = await owner<{ user_id: string }[]>`
    insert into app.profiles (user_id) values (gen_random_uuid()) returning user_id
  `;
  await owner`
    insert into social.public_player_profiles (user_id, handle, display_name, is_discoverable)
    values (${visible!.user_id}, 'annika', 'Annika', true)
  `;
  await owner`
    insert into social.public_player_profiles (user_id, handle, display_name, is_discoverable)
    values (${hidden!.user_id}, 'annibal', 'Annibal', false)
  `;

  await report.check("a discoverable profile is findable by prefix", async () => {
    const found = await body(await get("/v1/directory/players?query=ann"));
    assert.deepEqual(
      found.data.map((row: { handle: string }) => row.handle),
      ["annika"],
    );
  });

  await report.check("an undiscoverable profile is not findable at all", async () => {
    const found = await body(await get("/v1/directory/players?query=annib"));
    assert.deepEqual(found.data, []);
    assert.equal((await get("/v1/directory/players/annibal")).status, 404);
  });

  await report.check("a one-character query is refused", async () => {
    const response = await get("/v1/directory/players?query=a");
    assert.equal(response.status, 400);
  });

  await report.check("a wildcard is a search term, not a wildcard", async () => {
    // `%25%25` is `%%`. Honoured as a pattern it lists every discoverable
    // profile; escaped, as it must be, it matches the nobody whose handle
    // starts with two per-cent signs.
    const found = await body(await get("/v1/directory/players?query=%25%25"));
    assert.deepEqual(found.data, []);
  });

  await report.check("a provider handle needs both opt-ins", async () => {
    const [identity] = await owner<{ id: string }[]>`
      insert into app.provider_identities (
        provider_id, provider_identity_key, key_basis, current_display_username,
        current_normalized_username
      ) values (2, ${"gate-" + visible!.user_id}, 'username', 'annika_plays', 'annika_plays')
      returning id
    `;
    await owner`
      insert into app.linked_accounts (
        owner_user_id, provider_identity_id, provider_handle_discoverable
      ) values (${visible!.user_id}, ${identity!.id}, true)
    `;

    // The account says yes; the profile has not.
    const before = await body(await get("/v1/directory/players/annika"));
    assert.deepEqual(before.data.providerHandles, []);
    assert.equal(
      (before.meta.redactions ?? []).some(
        (r: { path: string }) => r.path === "data.providerHandles",
      ),
      true,
    );

    await owner`
      update social.public_player_profiles set show_provider_handles = true
      where user_id = ${visible!.user_id}
    `;
    const after = await body(await get("/v1/directory/players/annika"));
    assert.deepEqual(after.data.providerHandles, [
      { provider: "lichess", handle: "annika_plays" },
    ]);
  });
}

report.section("the public statistic");

{
  await report.check("the statistic is a figure with a disclosure, not a bare number", async () => {
    const stats = await body(await get("/v1/public/stats"));
    assert.equal(typeof stats.data.players.disclosure, "string");
    assert.equal(Array.isArray(stats.data.byPlatform), true);
  });

  await report.check("the roster of handles is gone, and said to be gone", async () => {
    const stats = await body(await get("/v1/public/stats"));
    assert.equal("playersList" in stats.data, false);
    assert.equal(
      (stats.meta.redactions ?? []).some((r: { path: string }) => r.path === "data.playersList"),
      true,
    );
  });
}

await ops.end({ timeout: 5 });
await owner.end({ timeout: 5 });
await harness.destroy();
report.finish();
