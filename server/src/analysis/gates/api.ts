/**
 * `npm run analysis:api` — the version-bearing read, end to end over HTTP.
 *
 * The other gates prove the graph. This one proves the journey a client
 * actually makes: canonical game → materialization → snapshot → run →
 * publication → `GET /v1/games/{gameId}`, through the production kernel, the
 * production route registry and a real signed token, against a real database.
 *
 * Two claims need this shape and cannot be made anywhere else.
 *
 * Authorization at the boundary. A non-owner and a forged identifier must both
 * produce the same `404` as a game that does not exist, and an anonymous caller
 * must never get that far. Asserting the SQL predicate is not the same as
 * asserting the endpoint, because the endpoint is what an attacker calls.
 *
 * Truthfulness of the version block. Before a publication there is no claim, so
 * `version` is null rather than a hollow object; after one, it names the exact
 * component versions behind it; and after a provider correction lands, the
 * state is `stale` rather than `published`, because what is published was
 * computed from a replay that has since moved.
 */

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet } from "jose";
import postgres from "postgres";
import { GateReport, startKernelHarness } from "../../v1/gates/harness.js";
import { recordGoldenManifest, seedGoldenVersions, seedSubject, SHA } from "../fixtures.js";
import { completeRun, planRun, startRun } from "../runs.js";
import { publishSubjectGame } from "../publication.js";
import { registerRecipeVersion } from "../versions.js";
import { setAnalysisEventSink } from "../telemetry.js";

const report = new GateReport("E11 analysis versioning API gate");
const harness = await startKernelHarness();
const { app } = harness;
setAnalysisEventSink(() => {});

/**
 * Seeding runs as the owner; the endpoint runs as `forma_api`.
 *
 * That split is the point. The kernel's own connection holds only what the API
 * deployment holds, so if the read needed a privilege the API does not have,
 * this gate would fail rather than pass under privileges production lacks.
 * Building fixtures needs writes the API is correctly denied, so those go over
 * a separate admin connection.
 */
const sql = postgres(harness.db.adminUrl, { max: 4, prepare: false, onnotice: () => {} });

const ISSUER = `${process.env.SUPABASE_URL}/auth/v1`;
const KID = "gate-signing-key";
const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
const keySet: JSONWebKeySet = {
  keys: [{ ...(await exportJWK(publicKey)), kid: KID, alg: "ES256", use: "sig" }],
};
harness.verifier.setTokenVerifierForTest(
  new harness.verifier.TokenVerifier({
    supabaseUrl: process.env.SUPABASE_URL!,
    supabaseAnonKey: "gate",
    keySet,
    async getUser() {
      return null;
    },
  }),
);

async function token(actor: string): Promise<string> {
  return new SignJWT({ email: `${actor}@gate.invalid` })
    .setProtectedHeader({ alg: "ES256", kid: KID })
    .setSubject(actor)
    .setIssuer(ISSUER)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
}

async function get(
  path: string,
  options: { actor?: string; ifNoneMatch?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.actor) headers.authorization = `Bearer ${await token(options.actor)}`;
  if (options.ifNoneMatch) headers["if-none-match"] = options.ifNoneMatch;
  return app.request(`http://gate.invalid${path}`, { headers });
}

async function body(response: Response): Promise<Record<string, never>> {
  const text = await response.text();
  try {
    return JSON.parse(text) as Record<string, never>;
  } catch {
    throw new Error(`expected JSON, got ${response.status} ${text.slice(0, 160)}`);
  }
}

const SUFFIX = `a${Date.now().toString(36)}`;
// The golden lineage supplies the component versions the recipe below pins.
await seedGoldenVersions(sql, SUFFIX);
const owner = await seedSubject(sql, { games: 2 });
const stranger = await seedSubject(sql, { games: 1 });
const SYSTEM = { kind: "system" as const };
const GAME = owner.games[0];

const gameRecipe = await registerRecipeVersion(sql, {
  recipeKey: `review_${SUFFIX}`,
  version: "1",
  runType: "game_analysis",
  inputSchemaVersion: "replay.v1",
  outputSchemaVersion: "game_review.v1",
  requiredArtifacts: ["transition_assessments", "skill_estimates"],
  roles: {
    engine: { componentKey: `engine_${SUFFIX}`, version: "1" },
    estimator: { componentKey: `estimator_${SUFFIX}`, version: "1" },
  },
});

try {
  report.section("authorization at the boundary");

  await report.check("an anonymous caller is refused", async () => {
    const response = await get(`/v1/games/${GAME.subjectGameId}`);
    assert.equal(response.status, 401);
    const problem = await body(response);
    assert.equal((problem as { code?: string }).code, "AUTH_REQUIRED");
  });

  await report.check("a non-owner gets the same answer as a missing game", async () => {
    const foreign = await get(`/v1/games/${GAME.subjectGameId}`, { actor: stranger.ownerUserId });
    const missing = await get(`/v1/games/${randomUUID()}`, { actor: stranger.ownerUserId });
    assert.equal(foreign.status, 404);
    assert.equal(missing.status, 404);
    const [a, b] = [await body(foreign), await body(missing)];
    assert.equal((a as { detail?: string }).detail, (b as { detail?: string }).detail);
    assert.equal((a as { code?: string }).code, "NOT_FOUND");
  });

  await report.check("a malformed identifier is a 404, not a validation hint", async () => {
    const response = await get("/v1/games/not-a-uuid", { actor: owner.ownerUserId });
    assert.equal(response.status, 404);
  });

  await report.check("the denial is audited without leaking to the caller", async () => {
    await get(`/v1/games/${GAME.subjectGameId}`, { actor: stranger.ownerUserId });
    const [row] = await sql<{ action: string; result: string; reason_code: string }[]>`
      select action, result, reason_code from ops.audit_events
      where action = 'game.access_denied' order by id desc limit 1
    `;
    assert.equal(row.action, "game.access_denied");
    assert.equal(row.result, "denied");
    assert.equal(row.reason_code, "not_owned_or_absent");
  });

  report.section("the journey");

  let unpublishedEtag = "";

  await report.check("before any analysis the game is honest about having none", async () => {
    const response = await get(`/v1/games/${GAME.subjectGameId}`, { actor: owner.ownerUserId });
    assert.equal(response.status, 200);
    unpublishedEtag = response.headers.get("etag") ?? "";
    assert.ok(unpublishedEtag.length > 0, "a read carries an ETag");
    const { data } = (await body(response)) as unknown as {
      data: { version: unknown; analysis: { state: string; runId: null }; participants: unknown[] };
    };
    assert.equal(data.version, null, "no publication means no version block, not a hollow one");
    assert.equal(data.analysis.state, "unavailable");
    assert.equal(data.analysis.runId, null);
    assert.equal(data.participants.length, 2);
  });

  await report.check("an unchanged read revalidates to 304", async () => {
    const response = await get(`/v1/games/${GAME.subjectGameId}`, {
      actor: owner.ownerUserId,
      ifNoneMatch: unpublishedEtag,
    });
    assert.equal(response.status, 304);
  });

  let runId = "";

  await report.check("a planned run shows as running, and still publishes nothing", async () => {
    const planned = await planRun(sql, {
      recipeVersionId: gameRecipe.id,
      scope: {
        subjectId: owner.subjectId,
        subjectGameId: GAME.subjectGameId,
        replayRevisionId: GAME.replayRevisionId,
      },
      trigger: "user_request",
      actor: { kind: "user", id: owner.ownerUserId },
    });
    runId = planned.id;
    await startRun(sql, runId);
    const { data } = (await body(
      await get(`/v1/games/${GAME.subjectGameId}`, { actor: owner.ownerUserId }),
    )) as unknown as { data: { version: unknown; analysis: { state: string } } };
    assert.equal(data.analysis.state, "running");
    assert.equal(data.version, null);
  });

  await report.check("a published run gives the read its version block", async () => {
    await recordGoldenManifest(sql, runId);
    await completeRun(sql, runId);
    const published = await publishSubjectGame(sql, { runId, reason: "new_run", actor: SYSTEM });
    assert.equal(published.published, true);

    const response = await get(`/v1/games/${GAME.subjectGameId}`, { actor: owner.ownerUserId });
    assert.equal(response.status, 200);
    const { data } = (await body(response)) as unknown as {
      data: {
        analysis: { state: string; runId: string; publishedRevisionId: string };
        version: {
          publicationId: string;
          subjectSnapshotId: null;
          recipeVersionId: string;
          policyVersions: Record<string, string>;
          generatedAt: string;
        };
      };
    };
    assert.equal(data.analysis.state, "published");
    assert.equal(data.analysis.runId, runId);
    assert.equal(data.analysis.publishedRevisionId, String(GAME.replayRevisionId));
    assert.equal(data.version.publicationId, published.publicationId);
    assert.equal(data.version.recipeVersionId, gameRecipe.id);
    // A game analysis is scoped to a revision, not to a subject snapshot.
    assert.equal(data.version.subjectSnapshotId, null);
    assert.deepEqual(Object.keys(data.version.policyVersions).sort(), ["engine", "estimator"]);
    assert.equal(data.version.policyVersions.estimator, `estimator_${SUFFIX}@1`);
    assert.match(data.version.generatedAt, /^\d{4}-\d\d-\d\dT/);
  });

  await report.check("publishing changes the ETag, so a cached copy is not served", async () => {
    const response = await get(`/v1/games/${GAME.subjectGameId}`, {
      actor: owner.ownerUserId,
      ifNoneMatch: unpublishedEtag,
    });
    assert.equal(response.status, 200, "the pre-publication validator must no longer match");
  });

  await report.check("a provider correction makes the publication stale, not wrong", async () => {
    // A second revision of the same game: exactly what a provider correction
    // produces. The publication still pins revision 1, which is the truth about
    // what was analysed -- so the read says `stale` rather than `published`.
    const [corrected] = await sql<{ id: string }[]>`
      insert into chess.game_replay_revisions (
        provider_game_id, revision_no, normalizer_component_version_id, normalized_replay,
        normalized_sha256, played_at, rated, speed, result, ply_count, revision_reason
      ) values (
        ${GAME.providerGameId}, 2, 'norm-v1', '{"moves":[]}'::jsonb, ${SHA(`corrected-${SUFFIX}`)},
        now(), true, 'blitz', 'white', 4, 'provider_correction'
      )
      returning id
    `;
    await sql`
      update chess.subject_games set latest_replay_revision_id = ${corrected.id}
      where id = ${GAME.subjectGameId}
    `;
    for (const color of ["white", "black"] as const) {
      await sql`
        insert into chess.game_revision_participants (replay_revision_id, color, outcome)
        values (${corrected.id}, ${color}, ${color === "white" ? "win" : "loss"})
      `;
    }

    const { data } = (await body(
      await get(`/v1/games/${GAME.subjectGameId}`, { actor: owner.ownerUserId }),
    )) as unknown as {
      data: {
        analysis: { state: string; publishedRevisionId: string };
        replayRevision: { id: string; revisionNo: number; reason: string };
        version: { publicationId: string };
      };
    };
    assert.equal(data.analysis.state, "stale");
    assert.equal(data.replayRevision.revisionNo, 2);
    assert.equal(data.replayRevision.reason, "provider_correction");
    assert.equal(data.analysis.publishedRevisionId, String(GAME.replayRevisionId));
    assert.ok(data.version.publicationId, "the old claim is still named, not hidden");
  });

  report.section("the generated contract");

  await report.check("the endpoint is in the OpenAPI document with its version block", async () => {
    const response = await get("/v1/openapi.json");
    assert.equal(response.status, 200);
    const document = (await body(response)) as unknown as {
      paths: Record<string, { get?: { operationId: string } }>;
    };
    const path = document.paths["/v1/games/{gameId}"];
    assert.ok(path?.get, "the route is described");
    assert.equal(path.get!.operationId, "getGame");
    assert.ok(
      JSON.stringify(document).includes("policyVersions"),
      "the version block is part of the published contract",
    );
  });
} finally {
  await sql.end({ timeout: 5 }).catch(() => {});
  await harness.destroy();
}

report.finish();
