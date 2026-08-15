export interface BoardTheme {
  id: string;
  name: string;
  light: string;
  dark: string;
}

export const BOARD_THEMES: BoardTheme[] = [
  { id: "maple", name: "Maple", light: "#ecd7b2", dark: "#b17c4e" },
  { id: "sage", name: "Sage", light: "#e9ecd6", dark: "#7f9b6f" },
  { id: "walnut", name: "Walnut", light: "#c9a97e", dark: "#6d4f37" },
  { id: "ocean", name: "Ocean", light: "#d3dce8", dark: "#547a9e" },
  { id: "ash", name: "Ash", light: "#d2ccbf", dark: "#6b665c" },
  { id: "midnight", name: "Midnight", light: "#9aa1af", dark: "#383d47" },
  { id: "tempo", name: "Forma", light: "#f7e6d2", dark: "#f58a24" },
];

// v2: default moved from the loud "tempo" orange to a calm warm "maple".
const KEY = "tempo-board-theme-v2";
const DEFAULT_ID = "maple";

export function loadBoardTheme(): BoardTheme {
  try {
    const id = localStorage.getItem(KEY);
    const found = BOARD_THEMES.find((t) => t.id === id);
    if (found) return found;
  } catch {
    /* ignore */
  }
  return BOARD_THEMES.find((t) => t.id === DEFAULT_ID) ?? BOARD_THEMES[0];
}

export function saveBoardTheme(id: string): void {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* ignore */
  }
}

// Board file/rank coordinates — a learning aid, on by default.
const COORD_KEY = "tempo-board-coords";

export function loadShowCoordinates(): boolean {
  try {
    return localStorage.getItem(COORD_KEY) !== "0";
  } catch {
    return true;
  }
}

export function saveShowCoordinates(on: boolean): void {
  try {
    localStorage.setItem(COORD_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}
