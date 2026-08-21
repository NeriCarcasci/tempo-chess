import { createInterface } from "node:readline";

process.stdout.write('{"ready":true}\n');
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const raw of lines) {
  const request = JSON.parse(raw);
  const first = request.rating < 1500 ? "d2d4" : "e2e4";
  const second = first === "d2d4" ? "e2e4" : "d2d4";
  process.stdout.write(
    `${JSON.stringify({ moves: [
      { uci: first, probability: 0.75 },
      { uci: second, probability: 0.25 },
    ] })}\n`,
  );
}
