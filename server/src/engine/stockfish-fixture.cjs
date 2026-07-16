const readline = require("node:readline");

let uciReady = false;
let configured = false;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (line === "uci") {
    console.log("id name Stockfish 18");
    console.log("option name EvalFile type string default nn-deadbeef.nnue");
    console.log("uciok");
    uciReady = true;
  } else if (line.startsWith("setoption name Hash")) {
    configured = true;
  } else if (line === "isready") {
    if (!uciReady || !configured) process.exit(2);
    console.log("readyok");
  } else if (line === "go nodes 500000") {
    console.log("info depth 17 seldepth 24 multipv 1 score cp 35 wdl 300 650 50 nodes 500000 nps 1000000 time 500 pv e7e5 g1f3");
    console.log("info depth 17 seldepth 25 multipv 2 score cp 12 wdl 250 650 100 nodes 500000 nps 1000000 time 500 pv c7c5 g1f3");
    console.log("info depth 17 seldepth 25 multipv 3 score mate -4 wdl 0 0 1000 nodes 500000 nps 1000000 time 500 pv f7f6");
    console.log("bestmove e7e5");
  } else if (line === "quit") {
    process.exit(0);
  }
});
