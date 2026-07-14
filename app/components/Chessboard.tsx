import { PIECE_SETS, type PieceSet } from "../lib/pieceSets";

const S = 512; // internal viewBox units
const SQ = S / 8;

function parsePlacement(fen: string): (string | null)[][] {
  return fen
    .split(" ")[0]
    .split("/")
    .map((row) => {
      const cells: (string | null)[] = [];
      for (const ch of row) {
        if (/\d/.test(ch)) {
          for (let i = 0; i < Number(ch); i++) cells.push(null);
        } else {
          cells.push(ch);
        }
      }
      return cells;
    });
}

export function Chessboard({
  fen,
  size,
  flip = false,
  lastMove,
  light = "var(--color-board-light)",
  dark = "var(--color-board-dark)",
  pieceSet,
}: {
  fen: string;
  /** Fixed pixel size; omit for fluid (fills container width, square). */
  size?: number;
  flip?: boolean;
  /** [from, to] as 0-63 square indices, to highlight the last move. */
  lastMove?: [number, number];
  light?: string;
  dark?: string;
  pieceSet?: PieceSet;
}) {
  const set = pieceSet ?? PIECE_SETS[0];
  let board = parsePlacement(fen);
  if (flip) board = board.map((r) => [...r].reverse()).reverse();

  const style: React.CSSProperties = size
    ? { width: size, height: size }
    : { width: "100%", height: "auto", aspectRatio: "1 / 1" };

  // last-move squares, adjusted for flip
  const hl = new Set<number>();
  if (lastMove) {
    for (const sq of lastMove) {
      const r = 7 - Math.floor(sq / 8);
      const c = sq % 8;
      const rr = flip ? 7 - r : r;
      const cc = flip ? 7 - c : c;
      hl.add(rr * 8 + cc);
    }
  }

  return (
    <svg
      viewBox={`0 0 ${S} ${S}`}
      style={style}
      className="block rounded-[6px]"
      role="img"
      aria-label="Chess position"
    >
      {board.map((row, r) =>
        row.map((piece, c) => {
          const isDark = (r + c) % 2 === 1;
          const x = c * SQ;
          const y = r * SQ;
          const white = piece ? piece === piece.toUpperCase() : false;
          const highlighted = hl.has(r * 8 + c);
          return (
            <g key={`${r}-${c}`}>
              <rect x={x} y={y} width={SQ} height={SQ} fill={isDark ? dark : light} />
              {highlighted && (
                <rect x={x} y={y} width={SQ} height={SQ} fill="var(--color-accent)" opacity="0.28" />
              )}
              {piece && (
                <text
                  x={x + SQ / 2}
                  y={y + SQ / 2 + SQ * 0.02}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={SQ * 0.76}
                  style={{
                    fontFamily: 'Georgia, "Times New Roman", serif',
                    paintOrder: "stroke",
                    stroke: white ? set.whiteStroke : set.blackStroke,
                    strokeWidth: SQ * (white ? set.whiteStrokeW : set.blackStrokeW),
                    fill: white ? set.whiteFill : set.blackFill,
                  }}
                >
                  {(white ? set.whiteGlyphs : set.blackGlyphs)[piece.toLowerCase()]}
                </text>
              )}
            </g>
          );
        }),
      )}
    </svg>
  );
}
