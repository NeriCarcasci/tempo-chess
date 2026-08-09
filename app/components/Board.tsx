import { useEffect, useId, useMemo, useRef } from "react";
import { Chessboard as ReactChessboard } from "react-chessboard";
import type { PieceRenderObject } from "react-chessboard";
import { PIECE_SETS, type PieceSet } from "../lib/pieceSets";
import { loadShowCoordinates } from "../lib/boardThemes";
import { playTransitionSound, moveSanBetween } from "../lib/sounds";

/** A chess.com-style move arrow, in the app's 0-63 square space (a1 = 0, h8 = 63). */
export interface BoardArrow {
  from: number;
  to: number;
  color?: string;
}

const FILES = "abcdefgh";
const PIECE_KEYS = ["wP", "wN", "wB", "wR", "wQ", "wK", "bP", "bN", "bB", "bR", "bQ", "bK"] as const;

/** 0-63 square index (a1 = 0) -> algebraic name ("e4"). */
export const squareName = (sq: number): string => FILES[sq % 8]! + (Math.floor(sq / 8) + 1);
/** Algebraic name ("e4") -> 0-63 square index (a1 = 0). */
export const nameToSquare = (name: string): number => (Number(name[1]) - 1) * 8 + (name.charCodeAt(0) - 97);

/** Square names that currently hold a piece, from a FEN's placement field. */
function occupiedSquares(fen: string): Set<string> {
  const set = new Set<string>();
  const rows = fen.split(" ")[0]!.split("/");
  for (let r = 0; r < 8; r++) {
    let file = 0;
    for (const ch of rows[r]!) {
      if (/\d/.test(ch)) file += Number(ch);
      else {
        set.add(FILES[file]! + (8 - r));
        file += 1;
      }
    }
  }
  return set;
}

/** Build react-chessboard's piece renderers from one of our piece sets, keeping the
 *  Cburnett SVGs recoloured through --pc-fill / --pc-line exactly as the old board did. */
function buildPieces(set: PieceSet): PieceRenderObject {
  const out: PieceRenderObject = {};
  for (const key of PIECE_KEYS) {
    const white = key[0] === "w";
    const letter = key[1]!.toLowerCase();
    const fill = white ? set.whiteFill : set.blackFill;
    const line = white ? set.whiteStroke : set.blackStroke;
    out[key] = () =>
      set.svg ? (
        <svg
          viewBox="0 0 45 45"
          style={{
            width: "86%",
            height: "86%",
            margin: "7%",
            display: "block",
            ["--pc-fill" as string]: fill,
            ["--pc-line" as string]: line,
          }}
        >
          <g
            fill="var(--pc-fill)"
            stroke="var(--pc-line)"
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
            dangerouslySetInnerHTML={{ __html: set.svg[letter] ?? "" }}
          />
        </svg>
      ) : (
        <svg viewBox="0 0 45 45" style={{ width: "100%", height: "100%", display: "block" }}>
          <text
            x={22.5}
            y={23.5}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={34}
            style={{
              fontFamily: 'Georgia, "Times New Roman", serif',
              paintOrder: "stroke",
              stroke: line,
              strokeWidth: 45 * (white ? set.whiteStrokeW : set.blackStrokeW),
              fill,
            }}
          >
            {(white ? set.whiteGlyphs : set.blackGlyphs)[letter]}
          </text>
        </svg>
      );
  }
  return out;
}

const mix = (pct: number) => `color-mix(in srgb, var(--color-accent) ${pct}%, transparent)`;

export interface BoardProps {
  fen: string;
  /** Fixed pixel size; omit for fluid (fills container width, square). */
  size?: number;
  flip?: boolean;
  /** [from, to] as 0-63 square indices, to highlight the last move. */
  lastMove?: [number, number];
  arrows?: BoardArrow[];
  light?: string;
  dark?: string;
  pieceSet?: PieceSet;
  /** Click-to-move: fires with the clicked 0-63 square. Enables the click flow. */
  onSquareClick?: (sq: number) => void;
  /** Drag-to-move: fires with 0-63 from/to. Return true to accept (piece stays), false to snap back. */
  onMove?: (from: number, to: number) => boolean;
  selected?: number | null;
  targets?: number[];
  /** Gate interaction (drag). Defaults to true when onMove is provided. */
  interactive?: boolean;
  /** Show file/rank coordinates. */
  notation?: boolean;
  /** Suppress move sounds — e.g. when scrubbing a finished line for review. */
  silent?: boolean;
}

export function Board({
  fen,
  size,
  flip = false,
  lastMove,
  arrows,
  light = "var(--color-board-light)",
  dark = "var(--color-board-dark)",
  pieceSet,
  onSquareClick,
  onMove,
  selected,
  targets,
  interactive,
  notation,
  silent = false,
}: BoardProps) {
  const id = useId().replace(/:/g, "");
  const showNotation = notation ?? loadShowCoordinates();
  const set = pieceSet ?? PIECE_SETS[0]!;
  const pieces = useMemo(() => buildPieces(set), [set]);
  const turn = fen.split(" ")[1] === "b" ? "b" : "w";

  // Play a sound and announce the move whenever the position advances by a single
  // legal move — covers drags, click-to-move, engine replies, and line stepping.
  // The announcement is written straight to the live-region DOM node (not React
  // state) so it never triggers a re-render mid-animation, which would make
  // react-chessboard reverse-then-replay the piece.
  const prevFen = useRef<string | null>(null);
  const announceRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (prevFen.current && prevFen.current !== fen) {
      if (!silent) playTransitionSound(prevFen.current, fen);
      const san = moveSanBetween(prevFen.current, fen);
      if (san && announceRef.current) announceRef.current.textContent = `Move played: ${san}`;
    }
    prevFen.current = fen;
  }, [fen, silent]);

  const squareStyles = useMemo(() => {
    const styles: Record<string, React.CSSProperties> = {};
    const occupied = occupiedSquares(fen);
    if (lastMove) for (const sq of lastMove) styles[squareName(sq)] = { boxShadow: `inset 0 0 0 1000px ${mix(26)}` };
    for (const sq of targets ?? []) {
      const name = squareName(sq);
      styles[name] = occupied.has(name)
        ? { backgroundImage: `radial-gradient(circle, transparent 56%, ${mix(48)} 58%, ${mix(48)} 78%, transparent 80%)` }
        : { backgroundImage: `radial-gradient(circle, ${mix(46)} 20%, transparent 22%)` };
    }
    if (selected != null) styles[squareName(selected)] = { boxShadow: `inset 0 0 0 1000px ${mix(40)}` };
    return styles;
  }, [fen, lastMove, selected, targets]);

  const rcArrows = useMemo(
    () =>
      (arrows ?? []).map((a) => ({
        startSquare: squareName(a.from),
        endSquare: squareName(a.to),
        color: a.color ?? "var(--color-accent)",
      })),
    [arrows],
  );

  // Keep `allowDragging` STABLE for the life of an interactive board. If it toggled
  // with whose-turn-it-is (which flips every move), react-chessboard would remount the
  // draggable piece wrappers exactly as the position changes, interrupting the move
  // animation so the piece snaps back to its origin and replays. Instead we always
  // allow dragging when a move handler is present, and gate *whether a drag can start*
  // per-piece via canDragPiece — which never remounts anything.
  const draggable = !!onMove;
  const canInteract = interactive ?? true;

  const options = {
    id: `b${id}`,
    position: fen,
    boardOrientation: (flip ? "black" : "white") as "black" | "white",
    pieces,
    darkSquareStyle: { backgroundColor: dark },
    lightSquareStyle: { backgroundColor: light },
    squareStyles,
    boardStyle: { borderRadius: "6px", overflow: "hidden" },
    showNotation,
    darkSquareNotationStyle: { color: "color-mix(in srgb, var(--color-board-light) 88%, #000)", fontWeight: 700 },
    lightSquareNotationStyle: { color: "color-mix(in srgb, var(--color-board-dark) 85%, #000)", fontWeight: 700 },
    // Slide animation is OFF: react-chessboard's controlled-position animation was
    // reverse-then-replaying pieces ("moves back from where you move it") and I
    // couldn't debug it live (the preview pane is backgrounded). Instant placement is
    // glitch-free; drag still feels smooth because the piece follows the cursor.
    animationDurationInMs: 0,
    showAnimations: false,
    allowDragging: draggable,
    // A small activation distance keeps a tap on a piece a *click* (so click-to-move
    // fires onSquareClick) while any real drag past the threshold still works.
    dragActivationDistance: 6,
    allowDrawingArrows: false,
    clearArrowsOnClick: false,
    arrows: rcArrows,
    canDragPiece: draggable
      ? ({ piece }: { piece: { pieceType: string } }) => canInteract && piece.pieceType[0]!.toLowerCase() === turn
      : undefined,
    onPieceDrop: onMove
      ? ({ sourceSquare, targetSquare }: { sourceSquare: string; targetSquare: string | null }) => {
          if (!targetSquare) return false;
          return onMove(nameToSquare(sourceSquare), nameToSquare(targetSquare));
        }
      : undefined,
    // react-chessboard fires onSquareClick even when the click lands on a piece, so
    // this one handler drives the whole click-to-move flow (select, then move).
    onSquareClick: onSquareClick
      ? ({ square }: { square: string }) => onSquareClick(nameToSquare(square))
      : undefined,
  };

  const wrap: React.CSSProperties = size ? { width: size, height: size } : { width: "100%" };
  const srOnly: React.CSSProperties = {
    position: "absolute", width: 1, height: 1, padding: 0, margin: -1,
    overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: 0,
  };
  return (
    <div style={wrap} role="group" aria-label={onMove ? "Chess board — make a move" : "Chess board"}>
      <ReactChessboard options={options} />
      <span ref={announceRef} aria-live="polite" style={srOnly} />
    </div>
  );
}
