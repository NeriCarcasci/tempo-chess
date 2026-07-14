const GLYPH: Record<string, string> = {
  k: "♚",
  q: "♛",
  r: "♜",
  b: "♝",
  n: "♞",
  p: "♟",
};

// Piece colors are board-intrinsic (not theme tokens). A contrasting outline
// (paint-order stroke) keeps both colors legible on either square.
const WHITE_FILL = "#efe7d2";
const WHITE_STROKE = "#26201a";
const BLACK_FILL = "#1b1813";
const BLACK_STROKE = "#d8cdb4";

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
  size = 288,
  flip = false,
}: {
  fen: string;
  size?: number;
  flip?: boolean;
}) {
  let board = parsePlacement(fen);
  if (flip) board = board.map((r) => [...r].reverse()).reverse();
  const sq = size / 8;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="block rounded-[6px]"
      role="img"
      aria-label="Chess position from a recent game"
      style={{ boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.35)" }}
    >
      {board.map((row, r) =>
        row.map((piece, c) => {
          const dark = (r + c) % 2 === 1;
          const x = c * sq;
          const y = r * sq;
          const white = piece ? piece === piece.toUpperCase() : false;
          return (
            <g key={`${r}-${c}`}>
              <rect
                x={x}
                y={y}
                width={sq}
                height={sq}
                fill={dark ? "var(--color-board-dark)" : "var(--color-board-light)"}
              />
              {piece && (
                <text
                  x={x + sq / 2}
                  y={y + sq / 2 + sq * 0.02}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={sq * 0.76}
                  style={{
                    fontFamily: 'Georgia, "Times New Roman", serif',
                    paintOrder: "stroke",
                    stroke: white ? WHITE_STROKE : BLACK_STROKE,
                    strokeWidth: sq * 0.022,
                    fill: white ? WHITE_FILL : BLACK_FILL,
                  }}
                >
                  {GLYPH[piece.toLowerCase()]}
                </text>
              )}
            </g>
          );
        }),
      )}
    </svg>
  );
}
