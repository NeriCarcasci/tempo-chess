import { fetchLichessGames } from "./lichess.js";
import { fetchChesscomGames } from "./chesscom.js";
import type { NormalizedGame } from "./types.js";

function line(g: NormalizedGame): string {
  return [
    g.platform.padEnd(8),
    g.color.padEnd(5),
    g.result.padEnd(4),
    (g.speed ?? "?").padEnd(8),
    (g.eco ?? "---").padEnd(4),
    `${g.userRating ?? "?"} vs ${g.opponentUsername ?? "?"} (${g.opponentRating ?? "?"})`.padEnd(34),
    `pgn:${g.pgn.length}b`,
    g.openingName ?? "",
  ].join("  ");
}

async function main() {
  const liUser = process.argv[2] ?? "DrNykterstein";
  const ccUser = process.argv[3] ?? "Hikaru";

  console.log(`\n=== Lichess: ${liUser} (max 2) ===`);
  try {
    let n = 0;
    for await (const g of fetchLichessGames(liUser, { max: 2 })) {
      console.log(line(g));
      if (++n >= 2) break;
    }
    console.log(`ok — ${n} games`);
  } catch (e) {
    console.error("lichess failed:", (e as Error).message);
  }

  console.log(`\n=== Chess.com: ${ccUser} (max 2) ===`);
  try {
    let n = 0;
    for await (const g of fetchChesscomGames(ccUser, { max: 2 })) {
      console.log(line(g));
      if (++n >= 2) break;
    }
    console.log(`ok — ${n} games`);
  } catch (e) {
    console.error("chess.com failed:", (e as Error).message);
  }
}

main();
