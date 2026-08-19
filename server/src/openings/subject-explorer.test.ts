/**
 * The claims the v1 explorer read model makes.
 *
 * These are the pure parts: the wire encoding, the family summary, and the one
 * cross-library invariant the whole design rests on. The query itself needs a
 * real Postgres and is exercised by the integration gate.
 *
 * Each test is one way this module could quietly start lying — an unanalysed
 * game rendered as a clean one, an expected-score loss rendered as centipawns,
 * a pruned node leaving an edge pointing at whatever now sits at that index.
 */

import assert from "node:assert/strict";
import { Chess as JsChess } from "chess.js";
import { Chess as OpsChess } from "chessops/chess";
import { parseFen, INITIAL_FEN } from "chessops/fen";
import { parseSan } from "chessops/san";
import { canonicalPositionKey } from "./model.js";
import { coreKey } from "../positions/canonical.js";
import { buildPersonalOpeningTree, type PersonalOpeningTree, type TreeObservation } from "./tree.js";
import {
  compactExplorerGraph,
  summarizeFamilies,
  type PositionScreening,
} from "./subject-explorer.js";

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${(error as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
console.log("the catalogue key and the core key are the same key");

/**
 * The join in `observationRows` is
 * `public.opening_positions.position_key = chess.core_positions.core_key`, and
 * every opening name on the screen depends on it matching.
 *
 * The two sides are built by different libraries: the catalogue is replayed
 * with chess.js in `catalogue.ts`, the core key derived with chessops in
 * `positions/canonical.ts`. They agree today because both keep the en-passant
 * square only when a capture onto it is actually legal. That is a convention,
 * not a contract either library owes us, so it is pinned here — a version bump
 * that changes it fails this test rather than silently emptying every name.
 */
function bothKeys(sans: readonly string[]): { legacy: string; core: string } {
  const js = new JsChess();
  for (const san of sans) js.move(san);

  const ops = OpsChess.fromSetup(parseFen(INITIAL_FEN).unwrap()).unwrap();
  for (const san of sans) {
    const move = parseSan(ops, san);
    assert.ok(move, `illegal SAN in fixture: ${san}`);
    ops.play(move);
  }
  return { legacy: canonicalPositionKey(js.fen()), core: coreKey(ops) };
}

const OPENING_LINES: ReadonlyArray<readonly string[]> = [
  ["e4"],
  ["d4"],
  ["e4", "e5"],
  ["e4", "c5"],
  ["e4", "e6", "d4", "d5"],
  ["e4", "c6", "d4", "d5", "Nc3"],
  ["d4", "Nf6", "c4", "e6"],
  ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"],
  ["d4", "d5", "c4", "c6", "Nf3", "Nf6"],
  ["Nf3", "d5", "g3", "c5"],
];

check("every catalogue line produces the same key in both libraries", () => {
  for (const line of OPENING_LINES) {
    const { legacy, core } = bothKeys(line);
    assert.equal(core, legacy, `1.${line.join(" ")} disagrees`);
  }
});

check("a key is four fields, never five", () => {
  // A five-field key means a clock leaked in, and every transposition would
  // become a distinct position. `core_positions_key_shape` enforces this in the
  // database; this catches it before the insert.
  for (const line of OPENING_LINES) {
    const { core } = bothKeys(line);
    assert.equal(core.split(" ").length, 4, core);
  }
});

check("a pawn double-step with no taker does not split one position in two", () => {
  // 1.e4 records e3 as the en-passant target in a naive FEN, but no black pawn
  // can capture there. If either library kept it, the position after 1.e4 would
  // have a different key from the same position reached by transposition.
  const { legacy, core } = bothKeys(["e4"]);
  assert.equal(core.split(" ")[3], "-", `core key kept a dead en-passant square: ${core}`);
  assert.equal(legacy.split(" ")[3], "-", `catalogue key kept a dead en-passant square: ${legacy}`);
});

check("a legal en-passant square survives in both", () => {
  // The converse. Dropping a live en-passant square would merge two genuinely
  // different positions, which is the worse failure of the two.
  const before = "4k3/8/8/8/1p6/8/P7/4K3 w - - 0 1";
  const js = new JsChess(before);
  js.move("a4");
  const ops = OpsChess.fromSetup(parseFen(before).unwrap()).unwrap();
  ops.play(parseSan(ops, "a4")!);
  assert.equal(canonicalPositionKey(js.fen()).split(" ")[3], "a3");
  assert.equal(coreKey(ops).split(" ")[3], "a3");
});

check("an en-passant capture the pin forbids is dropped by both", () => {
  // Black's b4 pawn is pinned against its king on the b-file, so it cannot take
  // a3. "Recorded" and "legal" come apart here, and this is the case a
  // library that only checks adjacency gets wrong.
  const before = "1k6/8/8/8/1p6/8/P7/1R2K3 w - - 0 1";
  const js = new JsChess(before);
  js.move("a4");
  const ops = OpsChess.fromSetup(parseFen(before).unwrap()).unwrap();
  ops.play(parseSan(ops, "a4")!);
  assert.equal(canonicalPositionKey(js.fen()).split(" ")[3], "-");
  assert.equal(coreKey(ops).split(" ")[3], "-");
});

// ---------------------------------------------------------------------------
console.log("the family summary separates unjudged from clean");

function observation(over: Partial<TreeObservation> = {}): TreeObservation {
  return {
    gameId: "g1",
    positionKey: "root",
    nextPositionKey: "e4",
    fen: "root 0 1",
    nextFen: "e4 0 1",
    ply: 0,
    moveUci: "e2e4",
    moveSan: "e4",
    actorIsPlayer: true,
    acceptable: true,
    acceptableReason: null,
    evaluationLossCp: null,
    playedAt: "2026-07-01T12:00:00.000Z",
    nodeName: null,
    nextNodeName: null,
    openingFamily: "Sicilian Defence",
    ...over,
  };
}

check("an unanalysed decision is counted as played but not as scored", () => {
  const [family] = summarizeFamilies([
    observation({ gameId: "g1", acceptable: true }),
    observation({ gameId: "g2", acceptable: null }),
  ]);
  assert.equal(family.playerDecisions, 2);
  assert.equal(family.scoredDecisions, 1);
  // The unjudged move is not a failure, and it is not a success either.
  assert.equal(family.failures, 0);
});

check("an unjudged decision never reads as a clean one", () => {
  const [family] = summarizeFamilies([observation({ acceptable: null })]);
  assert.equal(family.scoredDecisions, 0);
  assert.notEqual(
    family.playerDecisions,
    family.scoredDecisions,
    "the gap between played and scored is what the UI renders as coverage",
  );
});

check("the opponent's moves are not the player's decisions", () => {
  const families = summarizeFamilies([
    observation({ actorIsPlayer: true }),
    observation({ actorIsPlayer: false, acceptable: false }),
  ]);
  assert.equal(families.length, 1);
  assert.equal(families[0].playerDecisions, 1);
  assert.equal(families[0].failures, 0);
});

check("a position with no catalogue name is Unclassified, not dropped", () => {
  const [family] = summarizeFamilies([observation({ openingFamily: null })]);
  assert.equal(family.family, "Unclassified");
  assert.equal(family.playerDecisions, 1);
});

// ---------------------------------------------------------------------------
console.log("the wire graph says only what it knows");

function treeOf(rows: TreeObservation[]): PersonalOpeningTree {
  const tree = buildPersonalOpeningTree("All openings", rows, "player");
  assert.ok(tree, "fixture produced no tree");
  return tree;
}

const SAMPLE: TreeObservation[] = [
  observation({ gameId: "g1", ply: 0, positionKey: "root", nextPositionKey: "e4", moveUci: "e2e4", moveSan: "e4" }),
  observation({ gameId: "g2", ply: 0, positionKey: "root", nextPositionKey: "e4", moveUci: "e2e4", moveSan: "e4" }),
  observation({ gameId: "g3", ply: 0, positionKey: "root", nextPositionKey: "d4", moveUci: "d2d4", moveSan: "d4" }),
];

check("expected-score loss travels as dl and never as al", () => {
  const loss = new Map([["root|e2e4", 0.062]]);
  const graph = compactExplorerGraph(treeOf(SAMPLE), new Map(), loss);
  const e4 = graph.edges.find((edge) => edge.u === "e2e4");
  assert.ok(e4);
  assert.equal(e4.dl, 0.062);
  // `al` is centipawns in the legacy encoding. Emitting an expected-score
  // number under that name would put a false unit on the page.
  assert.ok(!("al" in e4), "the v1 edge must not carry a centipawn field");
});

check("an edge with no measured loss carries no loss", () => {
  const graph = compactExplorerGraph(treeOf(SAMPLE), new Map(), new Map());
  for (const edge of graph.edges) {
    assert.equal(edge.dl, undefined, `${edge.u} invented a loss`);
  }
});

check("a screening eval reaches the child edge, and a best move flags the parent", () => {
  const screening = new Map<string, PositionScreening>([
    ["root", { evalCp: 20, bestMoveUci: "e2e4" }],
    ["e4", { evalCp: 35, bestMoveUci: null }],
  ]);
  const graph = compactExplorerGraph(treeOf(SAMPLE), screening, new Map());
  const e4 = graph.edges.find((edge) => edge.u === "e2e4");
  const d4 = graph.edges.find((edge) => edge.u === "d2d4");
  assert.ok(e4 && d4);
  // `ev` is the eval of the position the move reaches, not the one it leaves.
  assert.equal(e4.ev, 35);
  assert.equal(e4.bm, 1);
  // The best move at root was e4, so d4 must not also be flagged.
  assert.equal(d4.bm, undefined);
  assert.equal(d4.ev, undefined, "an unevaluated child must not borrow a number");
});

check("every edge indexes a node that exists", () => {
  const graph = compactExplorerGraph(treeOf(SAMPLE), new Map(), new Map());
  for (const edge of graph.edges) {
    assert.ok(graph.nodes[edge.a], `edge ${edge.u} has no source node at ${edge.a}`);
    assert.ok(graph.nodes[edge.b], `edge ${edge.u} has no target node at ${edge.b}`);
  }
  assert.ok(graph.nodes[graph.root], "root index points at no node");
});

check("an edge whose endpoint was pruned is dropped, not left dangling", () => {
  // `focusPersonalOpeningTree` removes nodes and keeps edges; an index into a
  // shortened array would silently point at a different position.
  const tree = treeOf(SAMPLE);
  const pruned: PersonalOpeningTree = {
    ...tree,
    nodes: tree.nodes.filter((node) => node.key !== "d4"),
  };
  const graph = compactExplorerGraph(pruned, new Map(), new Map());
  assert.ok(
    graph.edges.every((edge) => edge.u !== "d2d4"),
    "an edge survived its pruned endpoint",
  );
  for (const edge of graph.edges) {
    assert.ok(graph.nodes[edge.a] && graph.nodes[edge.b]);
  }
});

check("the node count and the share percentages describe the same sample", () => {
  const graph = compactExplorerGraph(treeOf(SAMPLE), new Map(), new Map());
  const root = graph.nodes[graph.root];
  assert.equal(root.g, 3, "three games reached the initial position");
  const e4 = graph.edges.find((edge) => edge.u === "e2e4")!;
  const d4 = graph.edges.find((edge) => edge.u === "d2d4")!;
  assert.equal(e4.g, 2);
  assert.equal(d4.g, 1);
  // Shares are of the parent, so they account for the whole sample.
  assert.equal(e4.sh + d4.sh, 100);
});

// ---------------------------------------------------------------------------
if (failures > 0) {
  console.log(`\nsubject explorer gate: ${failures} failed`);
  process.exit(1);
}
console.log("\nsubject explorer gate: pass");
