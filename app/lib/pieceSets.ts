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
  /** Soft drop shadow + slightly larger glyphs for a rounder, tactile feel. */
  soft?: boolean;
  /** Vector piece markup keyed by piece letter, drawn on a 45×45 viewBox. */
  svg?: Record<string, string>;
}

// Solid (U+265A–F) and outline (U+2654–9) chess glyphs.
const SOLID = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };
const OUTLINE = { k: "♔", q: "♕", r: "♖", b: "♗", n: "♘", p: "♙" };

// The classic "Cburnett" chess pieces (Colin M.L. Burnett; the Wikipedia /
// Lichess default set) on a 45×45 viewBox. Recoloured via CSS variables:
// --pc-fill for the body, --pc-line for outlines, detail strokes and the eye.
const CBURNETT_SVG: Record<string, string> = {
  p: `<path d="M22.5 9c-2.21 0-4 1.79-4 4 0 .89.29 1.71.78 2.38C17.33 16.5 16 18.59 16 21c0 2.03.94 3.84 2.41 5.03C15.41 27.09 11 31.58 11 39.5H34c0-7.92-4.41-12.41-7.41-13.47C28.06 24.84 29 23.03 29 21c0-2.41-1.33-4.5-3.28-5.62.49-.67.78-1.49.78-2.38 0-2.21-1.79-4-4-4z" stroke-linecap="round"/>`,
  r: `<g stroke-linecap="butt"><path d="M9 39h27v-3H9v3z"/><path d="M12 36v-4h21v4H12z"/><path d="M11 14V9h4v2h5V9h5v2h5V9h4v5"/></g><path d="M34 14l-3 3H14l-3-3"/><path d="M31 17v12.5H14V17" stroke-linecap="butt" stroke-linejoin="miter"/><path d="M31 29.5l1.5 2.5h-20l1.5-2.5"/><path d="M11 14h23" fill="none" stroke-linejoin="miter"/>`,
  n: `<path d="M22 10c10.5 1 16.5 8 16 29H15c0-9 10-6.5 8-21" stroke-linecap="butt"/><path d="M24 18c.38 2.91-5.55 7.37-8 9-3 2-2.82 4.34-5 4-1.042-.94 1.41-3.04 0-3-1 0 .19 1.23-1 2-1 0-4.003 1-4-4 0-2 6-12 6-12s1.89-1.9 2-3.5c-.73-.994-.5-2-.5-3 1-1 3 2.5 3 2.5h2s.78-1.992 2.5-3c1 0 1 3 1 3" stroke-linecap="butt"/><path d="M9.5 25.5a.5.5 0 1 1-1 0 .5.5 0 1 1 1 0z" fill="var(--pc-line)" stroke="var(--pc-line)"/><path d="M14.933 15.75a.5 1.5 30 1 1-.866-.5.5 1.5 30 1 1 .866.5z" fill="var(--pc-line)" stroke="var(--pc-line)"/>`,
  b: `<g stroke-linecap="butt"><path d="M9 36c3.39-.97 10.11.43 13.5-2 3.39 2.43 10.11 1.03 13.5 2 0 0 1.65.54 3 2-.68.97-1.65.99-3 .5-3.39-.97-10.11.46-13.5-1-3.39 1.46-10.11.03-13.5 1-1.354.49-2.323.47-3-.5 1.354-1.94 3-2 3-2z"/><path d="M15 32c2.5 2.5 12.5 2.5 15 0 .5-1.5 0-2 0-2 0-2.5-2.5-4-2.5-4 5.5-1.5 6-11.5-5-15.5-11 4-10.5 14-5 15.5 0 0-2.5 1.5-2.5 4 0 0-.5.5 0 2z"/><path d="M25 8a2.5 2.5 0 1 1-5 0 2.5 2.5 0 1 1 5 0z"/></g><path d="M17.5 26h10M15 30h15m-7.5-14.5v5M20 18h5" fill="none" stroke-linejoin="miter"/>`,
  q: `<path d="M8 12a2 2 0 1 1-4 0 2 2 0 1 1 4 0zM24.5 7.5a2 2 0 1 1-4 0 2 2 0 1 1 4 0zM41 12a2 2 0 1 1-4 0 2 2 0 1 1 4 0zM16 8.5a2 2 0 1 1-4 0 2 2 0 1 1 4 0zM33 9a2 2 0 1 1-4 0 2 2 0 1 1 4 0z"/><path d="M9 26c8.5-1.5 21-1.5 27 0l2-12-7 11V11l-5.5 13.5-3-15-3 15-5.5-14V25L7 14l2 12z" stroke-linecap="butt"/><path d="M9 26c0 2 1.5 2 2.5 4 1 1.5 1 1 .5 3.5-1.5 1-1.5 2.5-1.5 2.5-1.5 1.5.5 2.5.5 2.5 6.5 1 16.5 1 23 0 0 0 1.5-1 0-2.5 0 0 .5-1.5-1-2.5-.5-2.5-.5-2 .5-3.5 1-2 2.5-2 2.5-4-8.5-1.5-18.5-1.5-27 0z" stroke-linecap="butt"/><path d="M11.5 30c3.5-1 18.5-1 22 0M12 33.5c6-1 15-1 21 0" fill="none"/>`,
  k: `<path d="M22.5 11.63V6M20 8h5" fill="none" stroke-linejoin="miter"/><path d="M22.5 25s4.5-7.5 3-10.5c0 0-1-2.5-3-2.5s-3 2.5-3 2.5c-1.5 3 3 10.5 3 10.5" stroke-linecap="butt" stroke-linejoin="miter"/><path d="M11.5 37c5.5 3.5 15.5 3.5 21 0v-7s9-4.5 6-10.5c-4-6.5-13.5-3.5-16 4V27v-3.5c-3.5-7.5-13-10.5-16-4-3 6 5 10 5 10V37z"/><path d="M11.5 30c5.5-3 15.5-3 21 0m-21 3.5c5.5-3 15.5-3 21 0m-21 3.5c5.5-3 15.5-3 21 0" fill="none"/>`,
};

export const PIECE_SETS: PieceSet[] = [
  {
    id: "cburnett",
    name: "Standard",
    whiteGlyphs: SOLID,
    blackGlyphs: SOLID,
    svg: CBURNETT_SVG,
    // Warm ivory vs. graphite so the standard set fits the desk theme.
    whiteFill: "#f2e7cf",
    whiteStroke: "#33291b",
    whiteStrokeW: 0.018,
    blackFill: "#2b303b",
    blackStroke: "#d9d2c2",
    blackStrokeW: 0.018,
  },
  {
    id: "rounded",
    name: "Rounded",
    whiteGlyphs: SOLID,
    blackGlyphs: SOLID,
    // Warm ivory over a soft graphite, thin contrast rim, and a depth shadow —
    // smooth and friendly without losing the serious, chess-native read.
    whiteFill: "#f6ecd6",
    whiteStroke: "#4a3d2c",
    whiteStrokeW: 0.03,
    blackFill: "#333a45",
    blackStroke: "#c9d0da",
    blackStrokeW: 0.03,
    soft: true,
  },
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

// Bumped to v4 so the real vector "Standard" (Cburnett) default reaches
// everyone; they can still pick another set and it persists under this key.
const KEY = "tempo-piece-set-v4";

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
