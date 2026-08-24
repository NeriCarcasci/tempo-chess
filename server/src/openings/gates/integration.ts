import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Chess } from "chessops/chess";
import { INITIAL_FEN, parseFen } from "chessops/fen";
import { parseUci } from "chessops/util";
import { SignJWT, exportJWK, generateKeyPair, type JSONWebKeySet } from "jose";
import postgres from "postgres";

import { GateReport, startKernelHarness } from "../../v1/gates/harness.js";
import { setAnalysisEventSink } from "../../analysis/telemetry.js";
import { publishSubjectGame } from "../../analysis/publication.js";
import { completeRun, planRun, recordArtifact, startRun } from "../../analysis/runs.js";
import { TRANSITION_ASSESSMENT_FAMILY } from "../../engine/contract.js";
import { SHA, seedPromotedRecipe } from "../../engine/fixtures.js";
import { coreKey } from "../../positions/canonical.js";
import { buildRun, publishRun } from "../../positions/materialize.js";
import {
  MAX_OPENING_PLIES,
  type ExplorerGraph,
  type ExplorerGraphEdge,
  type ExplorerGraphNode,
  type SubjectExplorer,
} from "../subject-explorer.js";

/**
 * `npm run openings:integration` — the opening explorer through HTTP and a real
 * database.
 *
 * What this proves that `subject-explorer.test.ts` cannot:
 *
 *   - **Scoping is structural.** The unit test can only show that the query
 *     text mentions `subject_id`. Here two owners hold games in one cluster,
 *     the read runs as `forma_api` inside the actor context the route binds,
 *     and both the join and the row-level policies behind `chess.subject_games`
 *     and `analysis.transition_assessments` have to agree before a row is
 *     returned. A predicate a refactor drops fails here.
 *   - **The grants are real.** The read crosses `chess.*`, `analysis.*` and the
 *     legacy `public` catalogue. A missing grant on any of them is invisible to
 *     a mocked `Queryable` and would first appear in production.
 *   - **A transposition collapses because the rows say so.** The two move
 *     orders are materialized by E09's own `buildRun`, so the shared node
 *     exists because the materializer wrote one `core_position_id`, not because
 *     this file inserted the same key twice.
 *   - **A verdict is quoted, not recomputed.** The assessments are seeded with
 *     known expected scores, and the assertions are about the numbers reaching
 *     the wire unchanged and in their own units.
 *
 * The fixture is built through the production writers wherever one exists: the
 * games through `buildRun`/`publishRun`, the analysis through E11's plan,
 * complete and publish path. Only the two E12 output tables are written by
 * hand, because their exact numbers are what the assertions are about.
 *
 * Everything lives in a disposable cluster. The one row written to a shared
 * table — the opening catalogue entry — is removed at the end, and nothing here
 * asserts that a table is globally empty.
 */

const report = new GateReport("Opening explorer integration gate");
const harness = await startKernelHarness();
const { app } = harness;
setAnalysisEventSink(() => {});

/**
 * The seeding connection is the cluster owner, not `forma_api`.
 *
 * `forma_api` deliberately cannot write an occurrence, an evaluation or an
 * assessment; seeding as the role under test would either need grants
 * production does not give it or prove nothing about the ones it has. The
 * requests below are the only thing that runs as `forma_api`, which is what
 * makes every 200 in this file also a statement about its grants.
 */
const owner = postgres(harness.db.adminUrl, { max: 4, prepare: false, onnotice: () => {} });

// --- a signed-in owner, using the production verifier ----------------------

const ISSUER = `${process.env.SUPABASE_URL}/auth/v1`;
const KID = "gate-signing-key";
const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
const keySet: JSONWebKeySet = {
  keys: [{ ...(await exportJWK(publicKey)), kid: KID, alg: "ES256", use: "sig" }],
};
harness.verifier.setTokenVerifierForTest(
  new harness.verifier.TokenVerifier({
    supabaseUrl: process.env.SUPABASE_URL ?? "https://gate.supabase.invalid",
    supabaseAnonKey: "gate",
    keySet,
    async getUser() {
      return null;
    },
  }),
);

async function tokenFor(actor: string): Promise<string> {
  return new SignJWT({ email: `${actor}@gate.invalid` })
    .setProtectedHeader({ alg: "ES256", kid: KID })
    .setSubject(actor)
    .setIssuer(ISSUER)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
}

// --- the fixture world ------------------------------------------------------

const STAMP = Date.now();

/**
 * Two move orders reaching one board.
 *
 * `1.Nf3 d5 2.d4` and `1.d4 d5 2.Nf3` are the same position at ply 3 by
 * construction: neither double step leaves a legal en-passant capture, so the
 * core key's fourth field is `-` on both sides, and the only thing that differs
 * is the halfmove clock — which the core key drops.
 */
const KNIGHT_FIRST = ["g1f3", "d7d5", "d2d4", "g8f6"] as const;
const PAWN_FIRST = ["d2d4", "d7d5", "g1f3", "g8f6"] as const;

/** Never published, so nothing it reached may appear. */
const UNPUBLISHED = ["c2c4", "e7e5", "b1c3"] as const;

/** Another owner's repertoire. Diverges at ply 1 from everything above. */
const OTHER_OWNER_LINE = ["b1c3", "g8f6", "g2g3"] as const;

/** 34 plies, so the ply bound has something to refuse. */
const LONG_LINE = [
  "e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6", "d2d3", "f8c5",
  "c2c3", "d7d6", "b1d2", "a7a6", "b2b4", "c5a7", "a2a4", "h7h6",
  "c1b2", "c8e6", "c4e6", "f7e6", "d1c2", "d8d7", "h2h3", "g7g5",
  "d2f1", "h6h5", "f1e3", "g5g4", "h3g4", "h5g4", "f3h4", "d7f7",
  "e1d1", "a8d8",
] as const;

const OPENING_NAME = "Queen's Pawn Game: Zukertort Variation";
const OPENING_FAMILY = "Queen's Pawn Game";

/**
 * The core key a line arrives at, computed the way the materializer computes
 * it rather than pasted in.
 *
 * A hardcoded key would still pass if `coreKey` changed its mind about castling
 * or en passant, which is exactly the change that would empty every opening
 * name in production.
 */
function coreKeyAfter(moves: readonly string[]): string {
  const setup = parseFen(INITIAL_FEN);
  if (setup.isErr) throw new Error("the initial FEN did not parse");
  const start = Chess.fromSetup(setup.value);
  if (start.isErr) throw new Error("the initial position is not a legal setup");
  const position = start.value;
  for (const uci of moves) {
    const move = parseUci(uci);
    if (!move || !position.isLegal(move)) {
      throw new Error(`${uci} is not legal in this gate's fixture line`);
    }
    position.play(move);
  }
  return coreKey(position);
}

interface SeededOwner {
  ownerUserId: string;
  subjectId: string;
}

async function seedOwner(label: string): Promise<SeededOwner> {
  const ownerUserId = randomUUID();
  await owner`insert into app.profiles (user_id) values (${ownerUserId})`;
  const [subject] = await owner<{ id: string }[]>`
    insert into app.analysis_subjects (kind, owner_user_id, display_label)
    values ('personal', ${ownerUserId}, ${label})
    returning id
  `;
  if (!subject) throw new Error("the fixture subject was not created");
  return { ownerUserId, subjectId: subject.id };
}

interface SeededGame {
  subjectGameId: string;
  replayRevisionId: string;
  materializationRunId: string;
}

interface SeedGameOptions {
  subjectId: string;
  moves: readonly string[];
  speed: string;
  /** Leave the materialization in `building`, so the read must not see it. */
  publish?: boolean;
}

let gameOrdinal = 0;

/**
 * One game, materialized by the real materializer.
 *
 * The shared fixtures in `analysis/fixtures.ts` and `engine/fixtures.ts` both
 * pin the speed, the colour and the move list, and this gate's claims are about
 * all three at once. Only the rows the explorer's join actually walks are
 * written; participants and rating observations are left out because nothing
 * here reads them and a row nobody reads is a fixture nobody maintains.
 */
async function seedGame(options: SeedGameOptions): Promise<SeededGame> {
  const ordinal = (gameOrdinal += 1);
  const playedAt = new Date(STAMP - ordinal * 86_400_000).toISOString();

  const [providerGame] = await owner<{ id: string }[]>`
    insert into chess.provider_games (provider_id, provider_game_id)
    values (2, ${`e20-gate-${STAMP}-${ordinal}`})
    returning id
  `;
  if (!providerGame) throw new Error("the fixture provider game was not created");

  const [revision] = await owner<{ id: string }[]>`
    insert into chess.game_replay_revisions (
      provider_game_id, revision_no, normalizer_component_version_id, normalized_replay,
      normalized_sha256, played_at, rated, speed, result, ply_count, revision_reason
    ) values (
      ${providerGame.id}, 1, 'norm-v1', ${JSON.stringify({ moves: options.moves })}::text::jsonb,
      ${SHA(`e20-${STAMP}-${ordinal}`)}, ${playedAt}, true, ${options.speed}, 'white',
      ${options.moves.length}, 'first_seen'
    )
    returning id
  `;
  if (!revision) throw new Error("the fixture replay revision was not created");

  await owner`
    update chess.provider_games set current_replay_revision_id = ${revision.id}
    where id = ${providerGame.id}
  `;
  const [subjectGame] = await owner<{ id: string }[]>`
    insert into chess.subject_games (subject_id, provider_game_id, latest_replay_revision_id, subject_color)
    values (${options.subjectId}, ${providerGame.id}, ${revision.id}, 'white')
    returning id
  `;
  if (!subjectGame) throw new Error("the fixture subject game was not created");

  const run = await buildRun(owner, revision.id, {
    moves: options.moves.map((uci) => ({ uci })),
  });
  if (options.publish ?? true) {
    await publishRun(owner, run.runId, { reason: "first_publication" });
  }

  return {
    subjectGameId: subjectGame.id,
    replayRevisionId: revision.id,
    materializationRunId: run.runId,
  };
}

const SUFFIX = `o${STAMP.toString(36)}`;
const recipe = await seedPromotedRecipe(owner, SUFFIX);

/**
 * One evaluation per (core position, halfmove clock), reused across games.
 *
 * `rule50` rather than `core`: `analysis.enforce_assessment_evidence()` refuses
 * a history-free evaluation as exact evidence about an occurrence, and it is
 * right to — the whole point of the scope ladder. Two games reaching one board
 * with different clocks are therefore two evaluations, which is also why the
 * transposing pair below does not collide on the inputs index.
 */
const evaluationIds = new Map<string, string>();

async function evaluationAt(
  materializationRunId: string,
  ply: number,
  expectedScore: number,
): Promise<string> {
  const [occurrence] = await owner<{ core_position_id: string; halfmove_clock: number }[]>`
    select core_position_id, halfmove_clock from chess.position_occurrences
    where run_id = ${materializationRunId} and ply = ${ply}
  `;
  if (!occurrence) throw new Error(`the materialized chain has no occurrence at ply ${ply}`);

  const cacheKey = SHA(`e20-gate|${occurrence.core_position_id}|${occurrence.halfmove_clock}`);
  const known = evaluationIds.get(cacheKey);
  if (known) return known;

  const [inserted] = await owner<{ id: string }[]>`
    insert into analysis.position_evaluations (
      core_position_id, scope, halfmove_clock, model_profile_id,
      calibration_component_version_id, limit_type, limit_value, multipv, threads, hash_mb,
      perspective, score_cp, expected_score, expected_score_method, worker_revision, cache_key
    ) values (
      ${occurrence.core_position_id}, 'rule50', ${occurrence.halfmove_clock},
      ${recipe.engineProfileId}, ${recipe.calibrationVersionId}, 'nodes', 50000, 1, 1, 64,
      'white', ${Math.round((expectedScore - 0.5) * 800)}, ${expectedScore}, 'logistic',
      'gate', ${cacheKey}
    )
    on conflict (cache_key) do nothing
    returning id
  `;
  const id =
    inserted?.id ??
    (
      await owner<{ id: string }[]>`
        select id from analysis.position_evaluations where cache_key = ${cacheKey}
      `
    )[0]?.id;
  if (!id) throw new Error("the fixture evaluation was neither inserted nor found");
  evaluationIds.set(cacheKey, id);
  return id;
}

interface Verdict {
  /** The transition's `from_ply`. Even plies are the subject's, who plays white. */
  fromPly: number;
  expectedBefore: number;
  expectedAfter: number;
  acceptable: boolean;
}

/**
 * A published game analysis carrying exactly the verdicts named.
 *
 * Only the subject's own moves are assessed. E12 assesses the opponent's too,
 * but the explorer never reads them — `actorIsPlayer` gates every count — so
 * seeding them would add rows no assertion can distinguish from their absence.
 */
async function publishAnalysis(
  subject: SeededOwner,
  game: SeededGame,
  verdicts: readonly Verdict[],
): Promise<void> {
  const planned = await planRun(owner, {
    recipeVersionId: recipe.recipeVersionId,
    scope: {
      subjectId: subject.subjectId,
      subjectGameId: game.subjectGameId,
      replayRevisionId: game.replayRevisionId,
    },
    trigger: "user_request",
    actor: { kind: "system" },
  });
  await startRun(owner, planned.id);

  for (const verdict of verdicts) {
    const [transition] = await owner<{ uci: string }[]>`
      select uci from chess.position_transitions
      where run_id = ${game.materializationRunId} and from_ply = ${verdict.fromPly}
    `;
    if (!transition) throw new Error(`the chain has no transition from ply ${verdict.fromPly}`);
    const before = await evaluationAt(game.materializationRunId, verdict.fromPly, verdict.expectedBefore);
    const after = await evaluationAt(game.materializationRunId, verdict.fromPly + 1, verdict.expectedAfter);
    await owner`
      insert into analysis.transition_assessments (
        analysis_run_id, materialization_run_id, from_ply, before_evaluation_id,
        after_evaluation_id, deep_status, actor_color, played_move_uci,
        expected_score_before, expected_score_after, tolerance_component_version_id,
        played_move_acceptable
      ) values (
        ${planned.id}, ${game.materializationRunId}, ${verdict.fromPly}, ${before}, ${after},
        'not_selected', 'white', ${transition.uci}, ${verdict.expectedBefore},
        ${verdict.expectedAfter}, ${recipe.toleranceVersionId}, ${verdict.acceptable}
      )
    `;
  }

  await recordArtifact(owner, planned.id, {
    family: TRANSITION_ASSESSMENT_FAMILY,
    count: verdicts.length,
    checksum: SHA(`${planned.id}-assessments`),
  });
  const completion = await completeRun(owner, planned.id);
  if (completion.status !== "succeeded") {
    throw new Error(`the fixture run did not succeed; missing ${completion.missing.join(", ")}`);
  }
  const publication = await publishSubjectGame(owner, {
    runId: planned.id,
    reason: "first_publication",
    actor: { kind: "system" },
  });
  if (!publication.published) {
    throw new Error(`the fixture publication was refused: ${publication.refusedCode}`);
  }
}

// --- reading the endpoint ---------------------------------------------------

interface RequestOptions {
  token?: string | null;
  ifNoneMatch?: string;
}

let subjectToken = "";

async function request(query = "", options: RequestOptions = {}): Promise<Response> {
  const token = options.token === undefined ? subjectToken : options.token;
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (options.ifNoneMatch) headers["if-none-match"] = options.ifNoneMatch;
  return app.request(`http://gate/v1/openings/explorer${query}`, { headers });
}

/** Read the resource, letting a non-200 say what it was rather than throwing on a cast. */
async function explorerOf(response: Response): Promise<SubjectExplorer> {
  const text = await response.text();
  if (response.status !== 200) {
    throw new Error(`expected 200, got ${response.status}: ${text.slice(0, 200)}`);
  }
  return (JSON.parse(text) as { data: SubjectExplorer }).data;
}

interface Problem {
  code: string;
  status: number;
  detail?: string;
}

async function problemOf(response: Response): Promise<Problem> {
  const text = await response.text();
  try {
    return JSON.parse(text) as Problem;
  } catch {
    throw new Error(`expected a problem document, got ${response.status} ${text.slice(0, 160)}`);
  }
}

function graphOf(explorer: SubjectExplorer): ExplorerGraph {
  if (!explorer.graph) throw new Error("the sample produced no graph");
  return explorer.graph;
}

function nodeAt(graph: ExplorerGraph, key: string): ExplorerGraphNode {
  const found = graph.nodes.filter((node) => node.k === key);
  const [only] = found;
  if (!only || found.length !== 1) {
    throw new Error(`expected exactly one node for ${key}, found ${found.length}`);
  }
  return only;
}

function edgeFrom(graph: ExplorerGraph, fromKey: string, uci: string): ExplorerGraphEdge {
  const found = graph.edges.find((edge) => graph.nodes[edge.a]?.k === fromKey && edge.u === uci);
  if (!found) throw new Error(`no ${uci} edge out of ${fromKey}`);
  return found;
}

// --- the world --------------------------------------------------------------

const TRANSPOSED_KEY = coreKeyAfter(KNIGHT_FIRST.slice(0, 3));
const catalogueKeys: string[] = [];

try {
  const subject = await seedOwner("E20 gate subject");
  const other = await seedOwner("E20 gate second subject");
  const strangerId = randomUUID();
  subjectToken = await tokenFor(subject.ownerUserId);

  const knightFirst = await seedGame({ subjectId: subject.subjectId, moves: KNIGHT_FIRST, speed: "blitz" });
  const pawnFirst = await seedGame({ subjectId: subject.subjectId, moves: PAWN_FIRST, speed: "rapid" });
  // Long, and deliberately never analysed: it is both the ply bound's subject
  // and the gap between playerDecisions and scoredDecisions.
  await seedGame({ subjectId: subject.subjectId, moves: LONG_LINE, speed: "blitz" });
  await seedGame({
    subjectId: subject.subjectId,
    moves: UNPUBLISHED,
    speed: "blitz",
    publish: false,
  });
  await seedGame({ subjectId: other.subjectId, moves: OTHER_OWNER_LINE, speed: "blitz" });

  // 1.Nf3 is judged fine and 2.d4 is judged a mistake losing 0.13 expected
  // points, so one edge carries a failure and a loss and its neighbour carries
  // neither.
  await publishAnalysis(subject, knightFirst, [
    { fromPly: 0, expectedBefore: 0.52, expectedAfter: 0.52, acceptable: true },
    { fromPly: 2, expectedBefore: 0.55, expectedAfter: 0.42, acceptable: false },
  ]);
  await publishAnalysis(subject, pawnFirst, [
    { fromPly: 0, expectedBefore: 0.52, expectedAfter: 0.51, acceptable: true },
    { fromPly: 2, expectedBefore: 0.54, expectedAfter: 0.54, acceptable: true },
  ]);

  await owner`
    insert into public.opening_positions (
      position_key, fen, eco, opening_name, family, ply, catalogue
    ) values (
      ${TRANSPOSED_KEY}, ${`${TRANSPOSED_KEY} 0 1`}, 'D02', ${OPENING_NAME},
      ${OPENING_FAMILY}, 3, true
    )
  `;
  catalogueKeys.push(TRANSPOSED_KEY);

  // -------------------------------------------------------------------------
  report.section("the caller's own subject, and nobody else's");

  await report.check("the read returns the caller's games and none of another owner's", async () => {
    const explorer = await explorerOf(await request());
    const graph = graphOf(explorer);
    // Three games reach the graph: the two transposing ones and the long one.
    // The fourth was materialized but never published.
    assert.equal(explorer.coverage.games, 3);
    assert.equal(graph.games, 3);
    for (let ply = 1; ply <= OTHER_OWNER_LINE.length; ply += 1) {
      const foreign = coreKeyAfter(OTHER_OWNER_LINE.slice(0, ply));
      assert.equal(
        graph.nodes.some((node) => node.k === foreign),
        false,
        `another owner's position at ply ${ply} reached this graph`,
      );
    }
  });

  await report.check("forma_api holds every grant the read crosses", async () => {
    // One successful 200 is the assertion: the response can only be assembled
    // by reading chess.subject_games, chess.position_occurrences,
    // chess.core_positions, chess.position_transitions,
    // analysis.subject_game_publications, analysis.transition_assessments and
    // public.opening_positions. A revoked grant on any of them is a 500 here.
    const response = await request();
    assert.equal(response.status, 200);
    const explorer = await explorerOf(response);
    const graph = graphOf(explorer);
    assert.ok(graph.nodes.length > 0, "chess.* produced no node");
    assert.ok(explorer.coverage.scoredDecisions > 0, "analysis.* produced no verdict");
    assert.equal(nodeAt(graph, TRANSPOSED_KEY).nm, OPENING_NAME, "the catalogue was not read");
  });

  // -------------------------------------------------------------------------
  report.section("the position graph");

  await report.check("two move orders reaching one board are one node", async () => {
    const graph = graphOf(await explorerOf(await request()));
    const shared = nodeAt(graph, TRANSPOSED_KEY);
    assert.equal(shared.g, 2, "the shared position did not count both games");
    assert.equal(shared.x, 1, "the shared position is not flagged as a transposition");
    // Reached by two different parents, which is what makes it a transposition
    // rather than one line counted twice.
    assert.ok(edgeFrom(graph, coreKeyAfter(KNIGHT_FIRST.slice(0, 2)), "d2d4"));
    assert.ok(edgeFrom(graph, coreKeyAfter(PAWN_FIRST.slice(0, 2)), "g1f3"));
  });

  await report.check("an unpublished materialization run is invisible", async () => {
    const graph = graphOf(await explorerOf(await request()));
    for (let ply = 1; ply <= UNPUBLISHED.length; ply += 1) {
      const hidden = coreKeyAfter(UNPUBLISHED.slice(0, ply));
      assert.equal(
        graph.nodes.some((node) => node.k === hidden),
        false,
        `a building run's position at ply ${ply} was served`,
      );
    }
  });

  await report.check("the ply bound holds against a longer game", async () => {
    assert.ok(LONG_LINE.length > MAX_OPENING_PLIES, "the fixture game is not long enough to bind");
    const graph = graphOf(await explorerOf(await request()));
    const deepest = Math.max(...graph.nodes.map((node) => node.p));
    assert.equal(deepest, MAX_OPENING_PLIES, "the bound was never reached, so nothing was proven");
    assert.equal(
      graph.nodes.every((node) => node.p <= MAX_OPENING_PLIES),
      true,
      "a node beyond the opening bound was served",
    );
  });

  // -------------------------------------------------------------------------
  report.section("what is known, and what is merely unjudged");

  await report.check("an unanalysed game is counted but not judged", async () => {
    const explorer = await explorerOf(await request());
    assert.equal(explorer.coverage.unanalysedGames, 1);
    // Four assessments exist in the whole fixture, all on the subject's moves.
    assert.equal(explorer.coverage.scoredDecisions, 4);
    assert.ok(
      explorer.coverage.playerDecisions > explorer.coverage.scoredDecisions,
      "the unjudged moves were reported as judged",
    );
    // The unanalysed game's own opening move must not read as a clean one.
    const opener = edgeFrom(graphOf(explorer), coreKeyAfter([]), LONG_LINE[0]);
    assert.equal(opener.op, 0, "an unanalysed move was counted as an opportunity");
    assert.equal(opener.fa, 0, "an unanalysed move was counted as a failure");
  });

  await report.check("a published verdict is cited rather than recomputed", async () => {
    const graph = graphOf(await explorerOf(await request()));
    const mistake = edgeFrom(graph, coreKeyAfter(KNIGHT_FIRST.slice(0, 2)), "d2d4");
    assert.equal(mistake.op, 1);
    assert.ok(mistake.fa >= 1, "a move published as unacceptable carries no failure");
    const sound = edgeFrom(graph, coreKeyAfter([]), "g1f3");
    assert.equal(sound.op, 1);
    assert.equal(sound.fa, 0, "a move published as acceptable was counted as a failure");
  });

  await report.check("decision loss reaches the wire as dl, in expected-score units", async () => {
    const graph = graphOf(await explorerOf(await request()));
    const mistake = edgeFrom(graph, coreKeyAfter(KNIGHT_FIRST.slice(0, 2)), "d2d4");
    if (mistake.dl === undefined) throw new Error("the edge carries no decision loss");
    assert.ok(
      Math.abs(mistake.dl - (0.55 - 0.42)) < 1e-6,
      `dl was ${mistake.dl}, not the seeded 0.13 expected-score points`,
    );
    // The legacy `al` is centipawns. Absent rather than converted: a number
    // whose stated unit is false is worse than no number.
    assert.equal("al" in mistake, false, "the centipawn field was populated from expected score");
  });

  await report.check("the opening name joins from the catalogue by core key", async () => {
    const explorer = await explorerOf(await request());
    assert.equal(nodeAt(graphOf(explorer), TRANSPOSED_KEY).nm, OPENING_NAME);
    assert.ok(
      explorer.families.some((entry) => entry.family === OPENING_FAMILY),
      `the catalogue family is missing from ${explorer.families.map((e) => e.family).join(", ")}`,
    );
  });

  // -------------------------------------------------------------------------
  report.section("filters, caching and refusals");

  await report.check("a colour filter with no games says so instead of guessing", async () => {
    const explorer = await explorerOf(await request("?color=black"));
    // Every seeded game is the subject's as White, so the black sample is empty
    // — and an empty sample is not an empty graph.
    assert.equal(explorer.graph, null);
    assert.equal(explorer.coverage.games, 0);
    assert.equal(explorer.coverage.observations, 0);
    assert.equal(explorer.coverage.playerDecisions, 0);
    assert.equal(explorer.filters.color, "black");
  });

  await report.check("the speed filter binds to the replay revision's speed", async () => {
    const rapid = await explorerOf(await request("?speed=rapid"));
    assert.equal(rapid.coverage.games, 1, "the rapid sample is not the one rapid game");
    const rapidGraph = graphOf(rapid);
    assert.ok(rapidGraph.nodes.some((node) => node.k === coreKeyAfter(["d2d4"])));
    assert.equal(
      rapidGraph.nodes.some((node) => node.k === coreKeyAfter(["g1f3"])),
      false,
      "a blitz game survived a rapid filter",
    );
    const blitz = await explorerOf(await request("?speed=blitz"));
    assert.equal(blitz.coverage.games, 2, "the blitz sample is not the two blitz games");
  });

  await report.check("an ETag round-trips into a 304", async () => {
    const first = await request();
    const etag = first.headers.get("etag");
    assert.match(etag ?? "", /^"[0-9a-f]{32}"$/);
    const second = await request();
    assert.equal(
      second.headers.get("etag"),
      etag,
      "two reads of unchanged data produced different validators",
    );
    const conditional = await request("", { ifNoneMatch: etag ?? "" });
    assert.equal(conditional.status, 304);
    assert.equal(await conditional.text(), "");
  });

  await report.check("an anonymous request is refused", async () => {
    const response = await request("", { token: null });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("content-type"), "application/problem+json");
    const problem = await problemOf(response);
    assert.equal(problem.code, "AUTH_REQUIRED");
  });

  await report.check("a caller with no subject is answered, not crashed", async () => {
    const response = await request("", { token: await tokenFor(strangerId) });
    assert.notEqual(response.status, 500, "a caller with no games produced an internal error");
    if (response.status === 200) {
      // The documented empty-sample answer: no graph, and a coverage that says
      // why. `NOT_FOUND` is the route's other documented answer and is equally
      // acceptable here; what must not happen is a 500 or a fabricated graph.
      const explorer = await explorerOf(response);
      assert.equal(explorer.graph, null);
      assert.equal(explorer.coverage.games, 0);
    } else {
      assert.equal(response.status, 404);
      assert.equal((await problemOf(response)).code, "NOT_FOUND");
    }
  });
} finally {
  // The catalogue is shared and outlives any one subject, so the row this gate
  // added is removed by key. Everything else lives in the disposable cluster.
  if (catalogueKeys.length > 0) {
    await owner`delete from public.opening_positions where position_key = any(${catalogueKeys})`.catch(
      () => [],
    );
  }
  await owner.end({ timeout: 5 }).catch(() => {});
  await harness.destroy();
}

report.finish();
