import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { Chess } from "chess.js";
import type { Route } from "./+types/play";
import { Board } from "../components/Board";
import { MoveInput } from "../components/MoveInput";
import { TopNav } from "../components/TopNav";
import { requireSession } from "../lib/session";
import { apiFetch } from "../lib/api";
import { RouteError } from "../components/RouteError";
import { loadBoardTheme } from "../lib/boardThemes";
import { loadPieceSet } from "../lib/pieceSets";
import { fetchProfile } from "../lib/lichess";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const STRENGTHS = [800, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2400];

export function meta() {
  return [{ title: "Play vs the bot · Tempo" }];
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return <RouteError title="Play unavailable" error={error} />;
}

export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  const session = await requireSession();
  const url = new URL(request.url);
  const fen = url.searchParams.get("fen") || START_FEN;
  const color = url.searchParams.get("color") === "black" ? "black" : "white";
  let elo = Number(url.searchParams.get("elo")) || 0;
  if (!elo) {
    try {
      const profile = await fetchProfile(session.username);
      const perfs = profile.perfs ?? {};
      elo = Math.round(
        perfs.rapid?.rating ?? perfs.blitz?.rating ?? perfs.classical?.rating ?? perfs.bullet?.rating ?? 1500,
      );
    } catch {
      elo = 1500;
    }
  }
  return { fen, color: color as "white" | "black", elo };
}

const algFromSq = (sq: number) => String.fromCharCode(97 + (sq % 8)) + (Math.floor(sq / 8) + 1);
const sqFromAlg = (alg: string) => (Number(alg[1]) - 1) * 8 + (alg.charCodeAt(0) - 97);

export default function Play({ loaderData }: Route.ComponentProps) {
  const { fen: initialFen, color, elo: initialElo } = loaderData;
  const userColor = color === "white" ? "w" : "b";
  const theme = useMemo(() => loadBoardTheme(), []);
  const pieceSet = useMemo(() => loadPieceSet(), []);
  const gameRef = useRef(new Chess(initialFen));
  // Bumped on every restart/undo so a bot reply that was already in flight is
  // discarded instead of applied to a position the user has since changed.
  const genRef = useRef(0);

  const [fen, setFen] = useState(initialFen);
  const [history, setHistory] = useState<string[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [targets, setTargets] = useState<number[]>([]);
  const [lastMove, setLastMove] = useState<[number, number] | undefined>();
  const [thinking, setThinking] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  // Snap the player's rating to the nearest preset so the selector reflects it.
  const [elo, setElo] = useState(() =>
    STRENGTHS.reduce((best, value) => (Math.abs(value - initialElo) < Math.abs(best - initialElo) ? value : best), STRENGTHS[0]!),
  );
  const [flip, setFlip] = useState(userColor === "b");

  const eloRef = useRef(elo);
  eloRef.current = elo;

  const startPly = useMemo(() => {
    const fields = initialFen.split(" ");
    const fullmove = Number(fields[5] ?? 1);
    return (fullmove - 1) * 2 + (fields[1] === "b" ? 1 : 0);
  }, [initialFen]);

  const sync = useCallback((move?: { from: string; to: string }) => {
    const game = gameRef.current;
    setFen(game.fen());
    setHistory(game.history());
    setSelected(null);
    setTargets([]);
    if (move) setLastMove([sqFromAlg(move.from), sqFromAlg(move.to)]);
  }, []);

  const evaluateEnd = useCallback(() => {
    const game = gameRef.current;
    if (!game.isGameOver()) {
      setStatus(null);
      return false;
    }
    if (game.isCheckmate()) {
      const userWon = game.turn() !== userColor;
      setStatus(userWon ? "Checkmate — you won!" : "Checkmate — the bot won.");
    } else if (game.isStalemate()) setStatus("Stalemate — it's a draw.");
    else if (game.isInsufficientMaterial()) setStatus("Draw — not enough material.");
    else if (game.isThreefoldRepetition()) setStatus("Draw — threefold repetition.");
    else setStatus("Draw.");
    return true;
  }, [userColor]);

  const botTurn = useCallback(async () => {
    const game = gameRef.current;
    if (game.isGameOver() || game.turn() === userColor) return;
    const gen = ++genRef.current; // claim this reply; supersedes any earlier one
    setThinking(true);
    let applied = false;
    for (let attempt = 0; attempt < 2 && !applied; attempt++) {
      try {
        const response = await apiFetch("/engine/play", {
          json: { fen: game.fen(), elo: eloRef.current },
        });
        if (gen !== genRef.current) return; // a restart/undo happened — discard
        const data = await response.json();
        if (data.move) {
          const move = game.move({
            from: data.move.slice(0, 2),
            to: data.move.slice(2, 4),
            promotion: (data.move[4] as "q" | "r" | "b" | "n") || "q",
          });
          if (move) {
            sync(move);
            applied = true;
          }
        }
      } catch {
        if (gen !== genRef.current) return;
      }
    }
    if (gen !== genRef.current) return;
    setThinking(false);
    if (applied) evaluateEnd();
    else setStatus("The bot didn't respond — take back a move or start a new game.");
  }, [userColor, sync, evaluateEnd]);

  // If the bot is on move from the start position, let it play first.
  useEffect(() => {
    if (gameRef.current.turn() !== userColor && !gameRef.current.isGameOver()) {
      void botTurn();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectSquare = (sq: number) => {
    const game = gameRef.current;
    const moves = game.moves({ square: algFromSq(sq) as never, verbose: true }) as Array<{ to: string }>;
    setSelected(sq);
    setTargets(moves.map((m) => sqFromAlg(m.to)));
  };

  /** Apply the user's move (click or drag). Returns true when it was legal. */
  const tryMove = (fromSq: number, toSq: number): boolean => {
    const game = gameRef.current;
    if (thinking || game.isGameOver() || game.turn() !== userColor) return false;
    let move: { from: string; to: string } | null = null;
    try {
      move = game.move({ from: algFromSq(fromSq), to: algFromSq(toSq), promotion: "q" });
    } catch {
      return false;
    }
    if (!move) return false;
    sync(move);
    if (!evaluateEnd()) void botTurn();
    return true;
  };

  const onSquareClick = (sq: number) => {
    const game = gameRef.current;
    if (thinking || game.isGameOver() || game.turn() !== userColor) return;
    const piece = game.get(algFromSq(sq) as never) as { color: string } | undefined;
    if (selected != null) {
      if (targets.includes(sq)) {
        tryMove(selected, sq);
        return;
      }
      if (piece && piece.color === userColor) {
        selectSquare(sq);
        return;
      }
      setSelected(null);
      setTargets([]);
      return;
    }
    if (piece && piece.color === userColor) selectSquare(sq);
  };

  const restart = () => {
    genRef.current++; // invalidate any bot reply still in flight
    gameRef.current = new Chess(initialFen);
    setThinking(false);
    setLastMove(undefined);
    setStatus(null);
    sync();
    if (gameRef.current.turn() !== userColor) void botTurn();
  };

  const undo = () => {
    const game = gameRef.current;
    if (thinking) return;
    genRef.current++; // invalidate any bot reply still in flight
    // Undo back to the user's previous turn (bot move + user move).
    if (game.turn() === userColor) {
      game.undo();
      game.undo();
    } else {
      game.undo();
    }
    setStatus(null);
    const last = game.history({ verbose: true }).at(-1) as { from: string; to: string } | undefined;
    sync(last);
    if (!last) setLastMove(undefined);
    // If taking back left the bot on move (e.g. Black undoing to the start), let it reply
    // so the game never freezes with nobody to move.
    if (!game.isGameOver() && game.turn() !== userColor) void botTurn();
  };

  const rows = useMemo(() => {
    const map = new Map<number, { white?: string; black?: string }>();
    history.forEach((san, i) => {
      const ply = startPly + i;
      const number = Math.floor(ply / 2) + 1;
      const row = map.get(number) ?? {};
      if (ply % 2 === 0) row.white = san;
      else row.black = san;
      map.set(number, row);
    });
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [history, startPly]);

  const turnLabel = gameRef.current.isGameOver()
    ? "Game over"
    : gameRef.current.turn() === userColor
      ? "Your move"
      : thinking
        ? "Bot is thinking…"
        : "Bot to move";

  return (
    <div className="relative z-10 min-h-dvh">
      <TopNav current="openings" back={{ to: "/openings", label: "Explorer" }} />
      <main className="play-shell">
        <header className="play-header">
          <div>
            <p className="eyebrow">Play it out</p>
            <h1>Study against the bot</h1>
            <p>Play the position out versus Stockfish at your level, then take what you learn back to the explorer.</p>
          </div>
        </header>

        <div className="play-workspace">
          <div className="play-board-col">
            <div className="explorer-board-frame">
              <Board
                fen={fen}
                flip={flip}
                lastMove={lastMove}
                light={theme.light}
                dark={theme.dark}
                pieceSet={pieceSet}
                onSquareClick={onSquareClick}
                onMove={tryMove}
                selected={selected}
                targets={targets}
                interactive
              />
            </div>
            <div className="explorer-controls" role="group" aria-label="Game controls">
              <button type="button" className="explorer-ctl" onClick={restart} title="Restart from the starting position">
                <span aria-hidden="true">⏮</span>
              </button>
              <button type="button" className="explorer-ctl" onClick={undo} disabled={!history.length || thinking} title="Take back">
                <span aria-hidden="true">‹</span>
              </button>
              <button type="button" className="explorer-ctl explorer-ctl-flip" onClick={() => setFlip((v) => !v)} aria-pressed={flip}>
                <span aria-hidden="true">⇅</span> Flip
              </button>
            </div>
            <MoveInput fen={fen} onMove={tryMove} disabled={thinking || gameRef.current.isGameOver() || gameRef.current.turn() !== userColor} />
          </div>

          <div className="play-side">
            <div className={`play-status ${gameRef.current.turn() === userColor && !gameRef.current.isGameOver() ? "is-yours" : ""}`}>
              <span className="play-turn">{turnLabel}</span>
              <span className="play-you">You play {color}</span>
            </div>
            {status ? <div className="play-result">{status}</div> : null}

            <label className="play-strength">
              <span>Bot strength</span>
              <select value={elo} onChange={(e) => setElo(Number(e.target.value))}>
                {STRENGTHS.map((value) => (
                  <option key={value} value={value}>{value} Elo</option>
                ))}
              </select>
            </label>

            <div className="movelist-panel play-moves">
              <div className="movelist-head">
                <span className="cap">Moves</span>
              </div>
              {rows.length ? (
                <ol className="movelist">
                  {rows.map(([number, row]) => (
                    <li key={number}>
                      <span className="movelist-num">{number}.</span>
                      <span className="movelist-cell is-empty">{row.white ?? ""}</span>
                      <span className="movelist-cell is-empty">{row.black ?? ""}</span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="movelist-empty">Make a move to begin.</p>
              )}
            </div>

            <div className="play-actions">
              <button type="button" className="secondary-button" onClick={restart}>New game from here</button>
              <Link to="/openings" className="secondary-button inline-flex items-center">Back to the explorer</Link>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
