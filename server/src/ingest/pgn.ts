import { Chess } from "chess.js";

/** Parse `[Key "Value"]` tag-pairs from a PGN into a plain object. */
export function parsePgnHeaders(pgn: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const re = /^\[([A-Za-z0-9_]+)\s+"((?:\\.|[^"\\])*)"\s*\]/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(pgn)) !== null) {
    headers[match[1]] = match[2].replace(/\\(["\\])/g, "$1");
  }
  return headers;
}

export interface ParsedPgnMove {
  ply: number;
  moveNumber: number;
  color: "white" | "black";
  san: string;
  uci: string;
  fenBefore: string;
  fenAfter: string;
  /** Remaining clock after the move, when a `[%clk ...]` annotation exists. */
  clockMs?: number;
}

export interface ParsedPgn {
  headers: Record<string, string>;
  moves: ParsedPgnMove[];
  /** Set when the movetext was malformed. Valid moves preceding the error remain available. */
  warning?: string;
}

/** Convert Chess.com/Lichess clock text (`H:MM:SS.s` or `M:SS.s`) to milliseconds. */
export function parseClockMs(value: string): number | undefined {
  const parts = value.trim().split(":");
  if (parts.length < 2 || parts.length > 3) return undefined;
  const numbers = parts.map(Number);
  if (numbers.some((part) => !Number.isFinite(part) || part < 0)) return undefined;
  const seconds = parts.length === 3
    ? numbers[0] * 3600 + numbers[1] * 60 + numbers[2]
    : numbers[0] * 60 + numbers[1];
  return Math.round(seconds * 1000);
}

function mainlineClocks(pgn: string): Map<number, number> {
  const movetext = pgn.replace(/^\s*\[[^\r\n]*\]\s*$/gm, "");
  const tokens = movetext.match(/\{[^}]*\}|\(|\)|;[^\r\n]*|[^\s(){}]+/g) ?? [];
  const clocks = new Map<number, number>();
  let variationDepth = 0;
  let moveIndex = -1;
  for (let token of tokens) {
    if (token === "(") { variationDepth += 1; continue; }
    if (token === ")") { variationDepth = Math.max(0, variationDepth - 1); continue; }
    if (variationDepth > 0) continue;
    if (token.startsWith("{") || token.startsWith(";")) {
      const match = /\[%clk\s+([^\]\s]+)\]/i.exec(token);
      const clockMs = match ? parseClockMs(match[1]) : undefined;
      if (moveIndex >= 0 && clockMs !== undefined) clocks.set(moveIndex, clockMs);
      continue;
    }
    token = token.replace(/^\d+\.(?:\.\.)?/, "");
    if (!token || /^(?:1-0|0-1|1\/2-1\/2|\*|\$\d+|[!?]+)$/.test(token)) continue;
    moveIndex += 1;
  }
  return clocks;
}

/**
 * Merge comment blocks that sit next to each other.
 *
 * Chess.com exports a judged move as two comments in a row:
 *
 *   27. Ra8? { Checkmate is now unavoidable. b4 was best. } { [%eval #-1] [%clk 0:21:06] }
 *
 * chess.js parses one comment after a move and then expects a move, so the
 * second `{` is a syntax error and the whole game is refused. That is most of
 * what a person pastes: the annotations and the clock arrive as separate
 * blocks, and the export is perfectly legal PGN.
 *
 * Comments do not nest in PGN, so `}` followed by `{` is unambiguously the end
 * of one and the start of the next, and joining them keeps every annotation
 * inside the surviving comment. `mainlineClocks` reads the result, so the clock
 * times survive the merge.
 */
export function mergeAdjacentComments(pgn: string): string {
  let merged = pgn;
  let previous: string;
  do {
    previous = merged;
    merged = merged.replace(/\}(\s*)\{/g, " ");
  } while (merged !== previous);
  return merged;
}

/**
 * Parse the main line into canonical SAN/UCI/FEN move facts. Comments,
 * variations and NAGs are handled by chess.js; malformed games degrade to an
 * empty/partial result instead of breaking a provider archive import.
 */
export function parsePgn(pgn: string): ParsedPgn {
  const headers = parsePgnHeaders(pgn);
  const movetext = mergeAdjacentComments(pgn);
  const clocks = mainlineClocks(movetext);
  const chess = new Chess();
  try {
    chess.loadPgn(movetext, { strict: false });
    const history = chess.history({ verbose: true });
    return {
      headers,
      moves: history.map((move, index) => ({
        ply: index + 1,
        moveNumber: Number(move.before.split(" ")[5]),
        color: move.color === "w" ? "white" : "black",
        san: move.san,
        uci: `${move.from}${move.to}${move.promotion ?? ""}`,
        fenBefore: move.before,
        fenAfter: move.after,
        ...(clocks.has(index) ? { clockMs: clocks.get(index) } : {}),
      })),
    };
  } catch (error) {
    return {
      headers,
      moves: [],
      warning: error instanceof Error ? error.message : "Malformed PGN",
    };
  }
}

/** Best-effort opening name from a chess.com ECO URL slug. */
export function openingNameFromEcoUrl(url?: string): string | undefined {
  if (!url) return undefined;
  const slug = url.split("/").filter(Boolean).pop();
  if (!slug) return undefined;
  return decodeURIComponent(slug).replace(/-/g, " ").trim() || undefined;
}
