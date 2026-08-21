// A UCI engine that plays a move decided by its arguments, for the opponent
// adapter's tests. It writes every command it receives to `logPath` so a test
// can assert what the adapter actually said — the strength it set and the
// position it described are the two things worth proving, and neither is
// visible in the returned move.
//
//   node opponent-fixture.cjs <logPath> <bestmove>
//
// `bestmove` may be `(none)`, which is what a real engine answers in a position
// with no legal move.
const fs = require("node:fs");
const readline = require("node:readline");

const [logPath, bestmove] = process.argv.slice(2);
const seen = [];

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  seen.push(line);
  if (line === "uci") {
    console.log("id name Stockfish 18 fixture");
    console.log("uciok");
  } else if (line === "isready") {
    console.log("readyok");
  } else if (line.startsWith("go ")) {
    // Written once, before the move that ends the conversation. The adapter
    // kills the process as soon as it has the move, and a write racing that
    // kill would leave the test reading half a file.
    fs.writeFileSync(logPath, seen.join("\n"));
    // Real engines stream these on the way to a move. The adapter must ignore
    // every one of them: a play move carries no evaluation.
    console.log("info depth 12 multipv 1 score cp 31 wdl 300 650 50 nodes 1000 time 30 pv e7e5");
    console.log(`bestmove ${bestmove}`);
  } else if (line === "quit") {
    process.exit(0);
  }
});
