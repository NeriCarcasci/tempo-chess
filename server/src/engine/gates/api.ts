/**
 * `npm run engine:api` — the three endpoints, end to end over HTTP.
 *
 * The other gates prove the graph and the grants. This one proves the journey a
 * client actually makes, through the production kernel, the production route
 * registry, a real signed token and a connection that holds exactly what the
 * API deployment holds.
 *
 * The claims that need this shape:
 *
 *  - anonymous, non-owner and forged identifiers are refused identically, at the
 *    endpoint an attacker would call rather than in a SQL predicate;
 *  - `POST /games/{id}/analysis` accepts no depth, threads or MultiPV, and the
 *    kernel refuses a body that tries;
 *  - the API role can plan a run for its own caller and cannot make one succeed;
 *  - the review names what it does not know rather than returning empty arrays;
 *  - `POST /positions/evaluations` answers a cached position immediately, a cold
 *    one with a workflow, and an illegal FEN with a validation problem.
 */

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet } from "jose";
import postgres from "postgres";
import { GateReport, startKernelHarness } from "../../v1/gates/harness.js";
import { setAnalysisEventSink } from "../../analysis/telemetry.js";
import { setEngineEventSink } from "../telemetry.js";
import { fixtureEngineSession, seedAnalysableGame, seedPromotedRecipe } from "../fixtures.js";

const report = new GateReport("E12 engine API gate");
const harness = await startKernelHarness();
const { app } = harness;
setAnalysisEventSink(() => {});
setEngineEventSink(() => {});

/** Seeding runs as the owner; the endpoints run as `forma_api`. */
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

async function get(path: string, options: { actor?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.actor) headers.authorization = `Bearer ${await token(options.actor)}`;
  return app.request(`http://gate.invalid${path}`, { headers });
}

async function post(
  path: string,
  body: unknown,
  options: { actor?: string; key?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.actor) headers.authorization = `Bearer ${await token(options.actor)}`;
  headers["idempotency-key"] = options.key ?? randomUUID();
  return app.request(`http://gate.invalid${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function body(response: Response): Promise<Record<string, never>> {
  const text = await response.text();
  try {
    return JSON.parse(text) as Record<string, never>;
  } catch {
    throw new Error(`expected JSON, got ${response.status} ${text.slice(0, 200)}`);
  }
}

const SUFFIX = `p${Date.now().toString(36)}`;

try {
  const versions = await seedPromotedRecipe(sql, SUFFIX);
  const owner = await seedAnalysableGame(sql);
  const stranger = await seedAnalysableGame(sql);
  const GAME = owner.subjectGameId;

  // -------------------------------------------------------------------------
  report.section("authorization at the boundary");

  await report.check("anonymous reaches neither the review nor the command", async () => {
    assert.equal((await get(`/v1/games/${GAME}/review`)).status, 401);
    assert.equal((await post(`/v1/games/${GAME}/analysis`, { reason: "user_request" })).status, 401);
    assert.equal(
      (await post("/v1/positions/evaluations", { fen: "8/8/8/8/8/8/8/K6k w - - 0 1", purpose: "explore" }))
        .status,
      401,
    );
  });

  await report.check("a non-owner, a forged id and an unpublished game answer alike", async () => {
    const statuses = [
      (await get(`/v1/games/${GAME}/review`, { actor: stranger.ownerUserId })).status,
      (await get(`/v1/games/${randomUUID()}/review`, { actor: owner.ownerUserId })).status,
      (await get(`/v1/games/not-a-uuid/review`, { actor: owner.ownerUserId })).status,
      (await get(`/v1/games/${GAME}/review`, { actor: owner.ownerUserId })).status,
    ];
    assert.deepEqual(statuses, [404, 404, 404, 404]);
  });

  await report.check("a non-owner cannot command an analysis of someone else's game", async () => {
    const response = await post(`/v1/games/${GAME}/analysis`, { reason: "user_request" }, {
      actor: stranger.ownerUserId,
    });
    assert.equal(response.status, 404);
  });

  // -------------------------------------------------------------------------
  report.section("the analysis command");

  await report.check("a body that tries to choose a search is refused", async () => {
    for (const attempt of [
      { reason: "user_request", depth: 30 },
      { reason: "user_request", nodes: 10_000_000 },
      { reason: "user_request", multipv: 20 },
      { reason: "user_request", recipe: "mine" },
      { reason: "because" },
    ]) {
      const response = await post(`/v1/games/${GAME}/analysis`, attempt, {
        actor: owner.ownerUserId,
      });
      assert.equal(response.status, 400, `accepted ${JSON.stringify(attempt)}`);
    }
  });

  let workflowId = "";
  await report.check("the command schedules a workflow the API role could create", async () => {
    const response = await post(`/v1/games/${GAME}/analysis`, { reason: "user_request" }, {
      actor: owner.ownerUserId,
    });
    assert.equal(response.status, 202, await response.clone().text());
    const payload = (await body(response)) as unknown as {
      data: { state: string; workflowId: string; runId: string };
    };
    assert.equal(payload.data.state, "scheduled");
    workflowId = payload.data.workflowId;
    const items = await sql<{ task_type: string }[]>`
      select task_type from ops.work_items where workflow_id = ${workflowId} order by id
    `;
    assert.equal(items.length, 3);
  });

  await report.check("commanding it again returns the same workflow", async () => {
    const response = await post(`/v1/games/${GAME}/analysis`, { reason: "user_request" }, {
      actor: owner.ownerUserId,
    });
    assert.equal(response.status, 202);
    const payload = (await body(response)) as unknown as { data: { workflowId: string } };
    assert.equal(payload.data.workflowId, workflowId);
  });

  await report.check("the API role created a planned run and could not complete it", async () => {
    const [run] = await sql<{ status: string; trigger_kind: string; actor_kind: string }[]>`
      select status, trigger_kind, actor_kind from analysis.runs
      where subject_game_id = ${GAME}
    `;
    assert.equal(run!.status, "planned");
    assert.equal(run!.trigger_kind, "user_request");
    const artifacts = await harness.sql<{ count: string }[]>`
      select count(*)::text as count from analysis.run_artifacts
    `;
    assert.equal(artifacts[0]!.count, "0", "the API role recorded an output family");
  });

  // -------------------------------------------------------------------------
  report.section("the review, once the workers have run");

  await report.check("running the pipeline publishes and the review reads it", async () => {
    process.env.DATABASE_URL = harness.db.urlFor("forma_analysis");
    process.env.DATABASE_ROLE = "forma_analysis";
    const worker = await import("../worker.js");
    worker.setEngineSessionFactory(async () => fixtureEngineSession());
    const [run] = await sql<{ id: string }[]>`
      select id from analysis.runs where subject_game_id = ${GAME}
    `;
    const payload = {
      materializationRunId: owner.materializationRunId,
      engineVersionId: versions.engineProfileId,
      calibrationVersionId: versions.calibrationVersionId,
    };
    const item = (taskType: string, body: Record<string, unknown>) => ({
      item: {
        id: "1",
        workflowId,
        taskType,
        resourceClass: "cpu_engine" as const,
        inputRef: null,
        payload: body,
        attempt: 1,
        maxAttempts: 5,
        leaseOwner: "gate",
        timeoutSeconds: 300,
      },
      traceId: null,
      async checkpoint() {
        return { continue: true };
      },
    });
    await worker.screenGame(item(worker.SCREEN_TASK, payload), sql);
    await worker.deepenGame(item(worker.DEEP_TASK, payload), sql);
    await worker.assessTransitions(item(worker.ASSESS_TASK, { runId: run!.id }), sql);
    worker.setEngineSessionFactory(null);

    const response = await get(`/v1/games/${GAME}/review`, { actor: owner.ownerUserId });
    assert.equal(response.status, 200, await response.clone().text());
    const payloadBody = (await body(response)) as unknown as {
      data: {
        moves: { decisionLoss: number; acceptable: boolean; evidence: { beforeScope: string } }[];
        sections: Record<string, string>;
        criticalMoments: unknown[];
        version: { policyVersions: Record<string, string> };
      };
    };
    assert.ok(payloadBody.data.moves.length > 0);
    assert.equal(payloadBody.data.sections.transitions, "published");
    assert.equal(payloadBody.data.sections.events, "unavailable");
    assert.equal(payloadBody.data.sections.explanations, "unavailable");
    for (const move of payloadBody.data.moves) {
      assert.notEqual(move.evidence.beforeScope, "core", "core evidence reached a client");
      assert.equal(typeof move.decisionLoss, "number");
    }
    assert.ok(Object.keys(payloadBody.data.version.policyVersions).length >= 4);
  });

  await report.check("the review carries an ETag and answers a repeat with 304", async () => {
    const first = await get(`/v1/games/${GAME}/review`, { actor: owner.ownerUserId });
    const etag = first.headers.get("etag");
    assert.ok(etag, "no ETag on a read that a client re-fetches per move");
    const repeat = await app.request(`http://gate.invalid/v1/games/${GAME}/review`, {
      headers: {
        authorization: `Bearer ${await token(owner.ownerUserId)}`,
        "if-none-match": etag!,
      },
    });
    assert.equal(repeat.status, 304);
  });

  await report.check("a published game answers the command with 200, not new work", async () => {
    const response = await post(`/v1/games/${GAME}/analysis`, { reason: "user_request" }, {
      actor: owner.ownerUserId,
    });
    assert.equal(response.status, 200);
    const payload = (await body(response)) as unknown as { data: { state: string; publicationId: string } };
    assert.equal(payload.data.state, "published");
    assert.ok(payload.data.publicationId);
  });

  // -------------------------------------------------------------------------
  report.section("bounded interactive evaluation");

  await report.check("an illegal FEN is a validation problem, not a workflow", async () => {
    const response = await post(
      "/v1/positions/evaluations",
      { fen: "8/8/8/8/8/8/8/8 w - - 0 1", purpose: "explore" },
      { actor: owner.ownerUserId },
    );
    assert.equal(response.status, 400);
    const payload = (await body(response)) as unknown as { code: string };
    assert.equal(payload.code, "VALIDATION_FAILED");
  });

  await report.check("a depth or MultiPV field is refused outright", async () => {
    const response = await post(
      "/v1/positions/evaluations",
      { fen: "8/8/8/8/8/8/8/K6k w - - 0 1", purpose: "explore", depth: 40 },
      { actor: owner.ownerUserId },
    );
    assert.equal(response.status, 400);
  });

  await report.check("a cold position returns 202 and the FEN stays out of the ledger", async () => {
    const response = await post(
      "/v1/positions/evaluations",
      { fen: "8/8/8/8/8/8/8/K6k w - - 0 1", purpose: "explore" },
      { actor: owner.ownerUserId },
    );
    assert.equal(response.status, 202, await response.clone().text());
    const payload = (await body(response)) as unknown as { data: { workflowId: string } };
    const [item] = await sql<{ payload: Record<string, unknown> }[]>`
      select payload from ops.work_items where workflow_id = ${payload.data.workflowId}
    `;
    assert.ok(!JSON.stringify(item!.payload).includes("K6k"), "the FEN reached the work ledger");
  });

  await report.check("once evaluated the same position answers 200 from the cache", async () => {
    const worker = await import("../worker.js");
    worker.setEngineSessionFactory(async () => fixtureEngineSession());
    const [item] = await sql<{ payload: Record<string, unknown> }[]>`
      select payload from ops.work_items
      where task_type = 'stockfish_evaluate_position' order by id desc limit 1
    `;
    await worker.evaluateInteractivePosition(
      {
        item: {
          id: "1",
          workflowId: randomUUID(),
          taskType: "stockfish_evaluate_position",
          resourceClass: "cpu_engine" as const,
          inputRef: null,
          payload: item!.payload,
          attempt: 1,
          maxAttempts: 5,
          leaseOwner: "gate",
          timeoutSeconds: 300,
        },
        traceId: null,
        async checkpoint() {
          return { continue: true };
        },
      },
      sql,
    );
    worker.setEngineSessionFactory(null);

    const response = await post(
      "/v1/positions/evaluations",
      { fen: "8/8/8/8/8/8/8/K6k w - - 0 1", purpose: "explore" },
      { actor: owner.ownerUserId },
    );
    assert.equal(response.status, 200, await response.clone().text());
    const payload = (await body(response)) as unknown as {
      data: { state: string; evaluation: { scope: string; profile: { multipv: number } } };
    };
    assert.equal(payload.data.state, "ready");
    assert.equal(payload.data.evaluation.scope, "rule50");
    assert.equal(payload.data.evaluation.profile.multipv, 3);
  });

  // -------------------------------------------------------------------------
  report.section("the generated contract");

  await report.check("the three endpoints are in the OpenAPI document", async () => {
    const document = (await body(await get("/v1/openapi.json"))) as unknown as {
      paths: Record<string, Record<string, unknown>>;
    };
    for (const path of [
      "/v1/games/{gameId}/review",
      "/v1/games/{gameId}/analysis",
      "/v1/positions/evaluations",
    ]) {
      assert.ok(document.paths[path], `${path} is missing from the document`);
    }
    // The description says there is no such parameter, so look at the schema
    // rather than the prose: what matters is that a client generator cannot
    // produce a field for one.
    const command = document.paths["/v1/games/{gameId}/analysis"] as {
      post: { requestBody?: { content: Record<string, { schema: unknown }> } };
    };
    const schema = JSON.stringify(command.post.requestBody?.content ?? {});
    for (const forbidden of ["depth", "threads", "multipv", "nodes"]) {
      assert.ok(!schema.includes(forbidden), `the command's body schema has a ${forbidden} field`);
    }
    assert.match(schema, /"reason"/, "the body schema was not published at all");
  });
} finally {
  await sql.end({ timeout: 5 }).catch(() => {});
  await harness.destroy();
}

report.finish();
