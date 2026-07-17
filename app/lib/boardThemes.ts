export interface BoardTheme {
  id: string;
  name: string;
  light: string;
  dark: string;
}

export const BOARD_THEMES: BoardTheme[] = [
  { id: "tempo", name: "Tempo", light: "#f7e6d2", dark: "#f58a24" },
  { id: "walnut", name: "Walnut", light: "#c9a97e", dark: "#6d4f37" },
  { id: "forest", name: "Forest", light: "#eeeed2", dark: "#6f8f57" },
  { id: "ocean", name: "Ocean", light: "#d3dce8", dark: "#547a9e" },
  { id: "ash", name: "Ash", light: "#d2ccbf", dark: "#6b665c" },
  { id: "midnight", name: "Midnight", light: "#9aa1af", dark: "#383d47" },
];

const KEY = "tempo-board-theme";
const DEFAULT_ID = "tempo";

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
