import { explainMove } from "./motifs";

const cases = [
  {
    label: "Nf3 hangs the knight to the g4 pawn",
    fen: "4k3/8/8/8/6p1/8/8/4K1N1 w - - 0 1",
    played: "g1f3",
    best: "e1e2",
    expect: "hanging",
  },
  {
    label: "Ke2 misses Rxd8 winning the queen",
    fen: "3qk3/8/8/8/8/8/8/3RK3 w - - 0 1",
    played: "e1e2",
    best: "d1d8",
    expect: "missed_material",
  },
  {
    label: "Ke2 misses back-rank mate Ra8#",
    fen: "6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1",
    played: "e1e2",
    best: "a1a8",
    expect: "missed_mate",
  },
  {
    label: "Kd8 misses the royal fork Ne2+ (knight defended by b4 pawn)",
    fen: "4k3/8/8/8/1p6/2n5/8/2Q3K1 b - - 0 1",
    played: "e8d8",
    best: "c3e2",
    expect: "fork",
  },
  {
    label: "a quiet developing move → no tactical motif",
    fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    played: "e2e4",
    best: "d2d4",
    expect: null,
  },
];

let pass = 0;
let fail = 0;
for (const c of cases) {
  const r = explainMove(c.fen, c.played, c.best);
  const got = r?.motif ?? null;
  const ok = got === c.expect;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.label}`);
  console.log(`      → ${r ? r.text : "(no motif)"}`);
  ok ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);
