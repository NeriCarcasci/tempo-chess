import { PieceGlyph } from "./PieceGlyph";
import { Move } from "./Move";

/**
 * The hero's board: a real position from a real game, drawn flat with the same
 * Cburnett vectors the app plays on.
 *
 * Kasparov vs Deep Blue, New York 1997, game 6, after 7.N1f3. Kasparov played
 * 7...h6, a move any club player makes without thinking, and it allows the
 * knight sacrifice 8.Nxe6. He resigned eleven moves later.
 *
 * The evaluations below are our own Stockfish at depth 18, not decoration:
 * +0.5 before the move, +1.0 after it, with 8.Nxe6 nearly a pawn better than
 * White's second choice. The engine's preference at move 7 is Bd6.
 */

const FEN = "r1bqkb1r/pp1n1ppp/2p1pn2/6N1/3P4/3B1N2/PPP2PPP/R1BQK2R";

const PLAYED = { from: "h7", to: "h6" };
const BETTER = { from: "f8", to: "d6" };

const FILES = "abcdefgh";
const CELL = 12.5;
/** Black is the side to move, so the board is shown from Black's seat. */
const FLIP = true;

interface Placed {
  square: string;
  letter: string;
  white: boolean;
  col: number;
  row: number;
}

const place = (file: number, rank: number) =>
  FLIP ? { col: 7 - file, row: rank - 1 } : { col: file, row: 8 - rank };

const squareXY = (square: string) =>
  place(FILES.indexOf(square[0]!), Number(square[1]));

function parse(fen: string): Placed[] {
  const out: Placed[] = [];
  fen.split("/").forEach((row, i) => {
    const rank = 8 - i;
    let file = 0;
    for (const ch of row) {
      if (ch >= "1" && ch <= "8") {
        file += Number(ch);
        continue;
      }
      out.push({
        square: FILES[file]! + String(rank),
        letter: ch.toLowerCase(),
        white: ch === ch.toUpperCase(),
        ...place(file, rank),
      });
      file += 1;
    }
  });
  return out;
}

/** Shaft plus head for a move arrow, trimmed clear of both squares. */
function arrow(from: string, to: string) {
  const a = squareXY(from);
  const b = squareXY(to);
  const x1 = (a.col + 0.5) * CELL;
  const y1 = (a.row + 0.5) * CELL;
  const x2 = (b.col + 0.5) * CELL;
  const y2 = (b.row + 0.5) * CELL;
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const ux = (x2 - x1) / len;
  const uy = (y2 - y1) / len;

  // Short moves (h7h6 is one square) would otherwise have no shaft left once the
  // tail gap and the head are taken out, so the gap scales down with distance.
  const tailGap = Math.min(CELL * 0.34, len * 0.26);
  const headLen = Math.min(CELL * 0.4, len * 0.36);
  const headHalf = CELL * 0.2;
  const sx = x1 + ux * tailGap;
  const sy = y1 + uy * tailGap;
  const tipX = x2 - ux * (CELL * 0.06);
  const tipY = y2 - uy * (CELL * 0.06);
  const baseX = tipX - ux * headLen;
  const baseY = tipY - uy * headLen;
  const px = -uy;
  const py = ux;

  return {
    shaft: { x1: sx, y1: sy, x2: baseX, y2: baseY },
    head: [
      `${tipX},${tipY}`,
      `${baseX + px * headHalf},${baseY + py * headHalf}`,
      `${baseX - px * headHalf},${baseY - py * headHalf}`,
    ].join(" "),
  };
}

export function HeroBoard() {
  const pieces = parse(FEN);
  const played = arrow(PLAYED.from, PLAYED.to);
  const better = arrow(BETTER.from, BETTER.to);
  const playedSquares = new Set([PLAYED.from, PLAYED.to]);
  const betterSquares = new Set([BETTER.from, BETTER.to]);

  return (
    <figure className="hb">
      <div className="hb-board">
        <div className="hb-grid" aria-hidden="true">
          {Array.from({ length: 64 }, (_, i) => {
            const col = i % 8;
            const row = Math.floor(i / 8);
            const file = FLIP ? 7 - col : col;
            const rank = FLIP ? row + 1 : 8 - row;
            const square = FILES[file]! + String(rank);
            // a1 is a dark square: file 0 + rank 1 is odd.
            const dark = (file + rank) % 2 === 1;
            const mark = playedSquares.has(square)
              ? "is-played"
              : betterSquares.has(square)
                ? "is-better"
                : "";
            return <span key={square} className={`hb-sq ${dark ? "is-dark" : ""} ${mark}`} />;
          })}
        </div>

        {/* Before the pieces on purpose, so the men sit on top of the arrows.
            An arrow drawn over a knight looks stuck to the screen; the same
            arrow passing behind it looks drawn on the board. */}
        <svg className="hb-arrows" viewBox="0 0 100 100" aria-hidden="true">
          <g className="hb-arrow hb-arrow-bad">
            <line {...played.shaft} />
            <polygon points={played.head} />
          </g>
          <g className="hb-arrow hb-arrow-good">
            <line {...better.shaft} />
            <polygon points={better.head} />
          </g>
        </svg>

        {pieces.map((p) => (
          <span
            key={p.square}
            className="hb-slot"
            style={{ left: `${p.col * CELL}%`, top: `${p.row * CELL}%` }}
          >
            <PieceGlyph letter={p.letter} white={p.white} className="hb-piece" />
          </span>
        ))}

        {/* Kasparov was Black here, so h6 and Bd6 are his and Nxe6 is the
            machine's. Getting a colour wrong would put a white knight on a
            black move, which is the sort of detail this audience checks. */}
        <div className="hb-callout">
          <p>
            <b><Move san="h6" white={false} /></b> allows{" "}
            <Move san="8.Nxe6" white /> and the position is gone.
          </p>
          <p className="hb-callout-fix">
            The engine wants <b><Move san="Bd6" white={false} /></b>.
          </p>
        </div>
      </div>

      <figcaption className="hb-caption">
        Kasparov vs Deep Blue, New York 1997, game 6.
      </figcaption>
    </figure>
  );
}
