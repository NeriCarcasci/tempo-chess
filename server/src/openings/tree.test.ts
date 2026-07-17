import assert from "node:assert/strict";
import {
  buildPersonalOpeningTree,
  focusPersonalOpeningTree,
  type TreeObservation,
} from "./tree.js";

function row(
  gameId: string,
  positionKey: string,
  nextPositionKey: string,
  ply: number,
  moveSan: string,
  actorIsPlayer = true,
): TreeObservation {
  return {
    gameId,
    positionKey,
    nextPositionKey,
    fen: `fen-${positionKey}`,
    nextFen: `fen-${nextPositionKey}`,
    ply,
    moveUci: moveSan.toLowerCase().replace(/[^a-h1-8]/g, "").padEnd(4, "1").slice(0, 4),
    moveSan,
    actorIsPlayer,
    acceptable: actorIsPlayer ? true : null,
    acceptableReason: actorIsPlayer ? "catalogue_move" : null,
    evaluationLossCp: 20,
    playedAt: "2026-07-01T12:00:00.000Z",
    nodeName: positionKey,
    nextNodeName: nextPositionKey,
  };
}

const rows = [
  row("g1", "root", "e4", 1, "e4"),
  row("g2", "root", "e4", 1, "e4"),
  row("g3", "root", "d4", 1, "d4"),
  row("g1", "e4", "shared", 2, "e5", false),
  row("g2", "e4", "shared", 2, "e5", false),
  row("g3", "d4", "shared", 2, "d5", false),
];
rows[0]!.acceptable = false;
rows[0]!.acceptableReason = "lost_120cp";
rows[0]!.evaluationLossCp = 120;
const tree = buildPersonalOpeningTree("Test Opening", rows)!;
assert.equal(tree.games, 3);
assert.equal(tree.rootKey, "root");
assert.deepEqual(
  tree.edges.filter((edge) => edge.fromKey === "root").map((edge) => edge.games),
  [2, 1],
);
assert.equal(
  tree.edges.filter((edge) => edge.fromKey === "root")
    .reduce((total, edge) => total + edge.games, 0),
  tree.nodes.find((node) => node.key === "root")!.games,
);
assert.equal(tree.nodes.find((node) => node.key === "shared")!.transposition, true);
assert.equal(tree.nodes.find((node) => node.key === "shared")!.terminalGames, 3);
assert.equal(tree.edges.find((edge) => edge.moveSan === "e5")!.actor, "opponent");
assert.equal(tree.edges.find((edge) => edge.moveSan === "e4")!.failures, 1);
assert.equal(tree.nodes.find((node) => node.key === "root")!.failures, 1);
assert.equal(tree.scope, "family");

const focused = focusPersonalOpeningTree(tree, "e4");
assert.deepEqual(
  new Set(focused.edges.map((edge) => edge.fromKey)),
  new Set(["root", "e4"]),
);
assert.equal(focused.nodes.some((node) => node.key === "shared"), true);

const mixed = buildPersonalOpeningTree("Mixed", [
  row("g1", "root", "e4", 1, "e4", true),
  row("g2", "root", "e4", 1, "e4", false),
])!;
assert.equal(mixed.edges[0]!.actor, "mixed");

const repeated = buildPersonalOpeningTree("Repeated", [
  row("g1", "root", "a", 1, "e4"),
  row("g1", "root", "b", 3, "d4"),
])!;
assert.equal(repeated.edges.length, 1);
assert.equal(repeated.edges[0]!.moveSan, "e4");

console.log("personal opening tree tests passed");
