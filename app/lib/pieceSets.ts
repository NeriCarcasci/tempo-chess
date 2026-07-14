export interface PieceSet {
  id: string;
  name: string;
  whiteGlyphs: Record<string, string>;
  blackGlyphs: Record<string, string>;
  whiteFill: string;
  whiteStroke: string;
  whiteStrokeW: number; // fraction of a square
  blackFill: string;
  blackStroke: string;
  blackStrokeW: number;
}

// Solid (U+265A–F) and outline (U+2654–9) chess glyphs.
const SOLID = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };
const OUTLINE = { k: "♔", q: "♕", r: "♖", b: "♗", n: "♘", p: "♙" };

export const PIECE_SETS: PieceSet[] = [
  {
    id: "classic",
    name: "Classic",
    whiteGlyphs: SOLID,
    blackGlyphs: SOLID,
    whiteFill: "#efe7d2",
    whiteStroke: "#26201a",
    whiteStrokeW: 0.022,
    blackFill: "#1b1813",
    blackStroke: "#d8cdb4",
    blackStrokeW: 0.022,
  },
  {
    id: "flat",
    name: "Flat",
    whiteGlyphs: SOLID,
    blackGlyphs: SOLID,
    whiteFill: "#f5f2ec",
    whiteStroke: "transparent",
    whiteStrokeW: 0,
    blackFill: "#151210",
    blackStroke: "transparent",
    blackStrokeW: 0,
  },
  {
    id: "line",
    name: "Line",
    whiteGlyphs: OUTLINE, // hollow white pieces
    blackGlyphs: SOLID,
    whiteFill: "#efe7d2",
    whiteStroke: "#26201a",
    whiteStrokeW: 0.014,
    blackFill: "#1b1813",
    blackStroke: "#d8cdb4",
    blackStrokeW: 0.014,
  },
];

const KEY = "tempo-piece-set";

export function loadPieceSet(): PieceSet {
  try {
    const id = localStorage.getItem(KEY);
    const found = PIECE_SETS.find((s) => s.id === id);
    if (found) return found;
  } catch {
    /* ignore */
  }
  return PIECE_SETS[0];
}

export function savePieceSet(id: string): void {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* ignore */
  }
}
