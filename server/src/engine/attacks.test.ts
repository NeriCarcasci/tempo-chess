import { parseFen } from "chessops/fen";
import { parseSquare } from "chessops/util";
import { see } from "./attacks.js";

let passed = 0;
let failed = 0;

function check(
  name: string,
  fen: string,
  from: string,
  to: string,
  expected: number,
) {
  const board = parseFen(fen).unwrap().board;
  const got = see(board, parseSquare(to), parseSquare(from));
  const ok = got === expected;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: see=${got} (expected ${expected})`);
  ok ? passed++ : failed++;
}

// pawn takes undefended pawn -> +1 pawn
check("win a pawn", "8/8/8/3p4/4P3/8/8/8 w - - 0 1", "e4", "d5", 100);
// pawn takes pawn, defended by a pawn -> even trade
check("even pawn trade", "8/8/2p5/3p4/4P3/8/8/8 w - - 0 1", "e4", "d5", 0);
// pawn grabs an undefended queen -> +queen
check("win a hanging queen", "8/8/8/3q4/4P3/8/8/8 w - - 0 1", "e4", "d5", 900);
// queen grabs a pawn defended by a pawn -> disastrous
check("queen takes defended pawn", "8/8/2p5/3p4/8/8/8/3Q4 w - - 0 1", "d1", "d5", -800);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
