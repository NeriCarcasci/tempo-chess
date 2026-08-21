import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { Chess } from "chess.js";
import type { Route } from "./+types/play";
import { Board } from "../components/Board";
import { MoveInput } from "../components/MoveInput";
import { TopNav } from "../components/TopNav";
import { requireSession } from "../lib/session";
import { RouteError } from "../components/RouteError";
import { loadBoardTheme } from "../lib/boardThemes";
import { loadPieceSet } from "../lib/pieceSets";
import { fetchProfile } from "../lib/lichess";
import { newIdempotencyKey } from "../lib/v1/client";
import { ProblemError } from "../lib/v1/problem";
import {
  availableFamilies,
  getPlayOpponents,
  nearestLevel,
  requestOpponentMove,
  strengthNote,
} from "../lib/v1/play";
import type { OpponentFamily, OpponentFamilyEntry, PlayLevelKey } from "../lib/v1/types";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/** How each family reads on screen. Named here so the API stays a vocabulary. */
const FAMILY_LABELS: Record<string, string> = {
  stockfish: "Stockfish",
  maia: "Maia",
};

const familyLabel = (family: string) => FAMILY_LABELS[family] ?? family;

export function meta() {
  return [{ title: "Play vs the bot · Forma" }];
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return <RouteError title="Play unavailable" error={error} />;
}

/**
 * The opponents are read from the server, not hard-coded.
 *
 * The list of families and the strengths each one can actually play is a
 * `/v1` catalogue, so the day a second engine is configured this screen offers
 * it without a change here — and until then it offers only what can really
 * answer, rather than a name that would be served by a different engine.
 */
export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  const session = await requireSession();
  const url = new URL(request.url);
  const fen = url.searchParams.get("fen") || START_FEN;
  const color = url.searchParams.get("color") === "black" ? "black" : "white";
  const [catalogue, rating] = await Promise.all([
    getPlayOpponents(),
    ratingFor(session.username, Number(url.searchParams.get("elo")) || 0),
  ]);
  return { fen, color: color as "white" | "black", rating, families: availableFamilies(catalogue) };
}

/** The player's own rating, only so the strength selector opens somewhere sane. */
async function ratingFor(username: string, requested: number): Promise<number> {
  if (requested) return requested;
  try {
    const perfs = (await fetchProfile(username)).perfs ?? {};
    return Math.round(
      perfs.rapid?.rating ?? perfs.blitz?.rating ?? perfs.classical?.rating ?? perfs.bullet?.rating ?? 1500,
    );
  } catch {
    return 1500;
  }
}

const algFromSq = (sq: number) => String.fromCharCode(97 + (sq % 8)) + (Math.floor(sq / 8) + 1);
const sqFromAlg = (alg: string) => (Number(alg[1]) - 1) * 8 + (alg.charCodeAt(0) - 97);

/** What the server needs to see the game: the moves since the starting position. */
function uciHistory(game: Chess): string[] {
  return (game.history({ verbose: true }) as Array<{ from: string; to: string; promotion?: string }>).map(
    (move) => `${move.from}${move.to}${move.promotion ?? ""}`,
  );
}

/**
 * What to say when the opponent could not move.
 *
 * Each branch is a different thing to do about it, which is why they are not
 * collapsed into one sentence. `describeProblem` is deliberately not reused:
 * its wording is about syncing games from a chess site, and telling someone
 * their chess site is down when an engine timed out sends them looking in the
 * wrong place.
 */
function engineFailure(error: unknown): string {
  if (!(error instanceof ProblemError)) {
    return "The bot didn't respond. Take back a move or start a new game.";
  }
  if (error.is("CONFLICT")) return error.message;
  if (error.is("RATE_LIMITED")) {
    return error.retryAfterSeconds === null
      ? "That was a lot of moves at once. Wait a moment and play it again."
      : `That was a lot of moves at once. Wait ${error.retryAfterSeconds} seconds and play it again.`;
  }
  if (error.is("PROVIDER_UNAVAILABLE")) {
    return "The engine didn't answer. Play the move again, or take one back.";
  }
  return "The bot didn't respond. Take back a move or start a new game.";
}

export default function Play({ loaderData }: Route.ComponentProps) {
  const { fen: initialFen, color, rating, families } = loaderData;
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
  const [family, setFamily] = useState<OpponentFamily | null>(families[0]?.family ?? null);
  const opponent: OpponentFamilyEntry | null =
    families.find((entry) => entry.family === family) ?? families[0] ?? null;
  // Snap the player's rating to the nearest level the chosen family offers.
  const [levelKey, setLevelKey] = useState<PlayLevelKey | null>(
    () => nearestLevel(opponent?.levels ?? [], rating)?.key ?? null,
  );
  const level = opponent?.levels.find((entry) => entry.key === levelKey) ?? null;
  const [flip, setFlip] = useState(userColor === "b");

  const requestRef = useRef({ family, levelKey });
  requestRef.current = { family, levelKey };

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
    const chosen = requestRef.current;
    if (!chosen.family || !chosen.levelKey) return;
    const gen = ++genRef.current; // claim this reply; supersedes any earlier one
    setThinking(true);
    // One key for this move, reused across attempts: a retry of the same move
    // must return the move that was already searched rather than buy a new one.
    const idempotencyKey = newIdempotencyKey();
    let applied = false;
    let failure: string | null = null;

    for (let attempt = 0; attempt < 2 && !applied; attempt++) {
      try {
        const result = await requestOpponentMove(
          {
            // The whole game, not just the position: the engine needs the moves
            // to see a repetition, and the server re-checks every one of them.
            position: { fen: initialFen, moves: uciHistory(game) },
            opponent: { family: chosen.family, level: chosen.levelKey },
          },
          idempotencyKey,
        );
        if (gen !== genRef.current) return; // a restart/undo happened — discard
        if (!result.reply) break; // the server says there is no move to make
        const move = game.move({
          from: result.reply.uci.slice(0, 2),
          to: result.reply.uci.slice(2, 4),
          promotion: (result.reply.uci[4] as "q" | "r" | "b" | "n") || "q",
        });
        if (move) {
          sync(move);
          applied = true;
        }
      } catch (error) {
        if (error instanceof Response) throw error; // a sign-in redirect
        if (gen !== genRef.current) return;
        failure = engineFailure(error);
        // A refusal is not a transport hiccup: retrying an unavailable opponent
        // or a spent rate-limit budget just spends the second attempt too.
        if (error instanceof ProblemError && !error.retryable) break;
      }
    }

    if (gen !== genRef.current) return;
    setThinking(false);
    if (applied) evaluateEnd();
    else if (!evaluateEnd()) setStatus(failure ?? "The bot didn't respond. Take back a move or start a new game.");
  }, [userColor, sync, evaluateEnd, initialFen]);

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
    if (thinking || !opponent || game.isGameOver() || game.turn() !== userColor) return false;
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
    if (thinking || !opponent || game.isGameOver() || game.turn() !== userColor) return;
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

  const turnLabel = !opponent
    ? "No opponent"
    : gameRef.current.isGameOver()
      ? "Game over"
      : gameRef.current.turn() === userColor
        ? "Your move"
        : thinking
          ? "Bot is thinking…"
          : "Bot to move";
  const note = strengthNote(level);

  return (
    <div className="relative z-10 min-h-dvh">
      <TopNav current="openings" back={{ to: "/openings", label: "Explorer" }} />
      <main className="play-shell">
        <header className="play-header">
          <div>
            <p className="eyebrow">Play it out</p>
            <h1>Study against the bot</h1>
            <p>
              {opponent
                ? `Play the position out versus ${familyLabel(opponent.family)} at your level, then take what you learn back to the explorer.`
                : "Play the position out versus the bot, then take what you learn back to the explorer."}{" "}
              Games here are yours to practise with. They are never filed with the games you really
              played.
            </p>
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
                interactive={Boolean(opponent)}
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
            <MoveInput
              fen={fen}
              onMove={tryMove}
              disabled={thinking || !opponent || gameRef.current.isGameOver() || gameRef.current.turn() !== userColor}
            />
          </div>

          <div className="play-side">
            <div className={`play-status ${gameRef.current.turn() === userColor && opponent && !gameRef.current.isGameOver() ? "is-yours" : ""}`}>
              <span className="play-turn">{turnLabel}</span>
              <span className="play-you">You play {color}</span>
            </div>
            {status ? <div className="play-result">{status}</div> : null}

            {opponent ? (
              <>
                {families.length > 1 ? (
                  <label className="play-strength">
                    <span>Opponent</span>
                    <select
                      value={opponent.family}
                      onChange={(e) => {
                        const next = families.find((entry) => entry.family === e.target.value);
                        if (!next) return;
                        setFamily(next.family);
                        // Levels are per family, so the chosen one may not exist
                        // in the new catalogue; land on the nearest rather than
                        // silently sending a key the server would reject.
                        setLevelKey(nearestLevel(next.levels, level?.nominalRating ?? rating)?.key ?? null);
                      }}
                    >
                      {families.map((entry) => (
                        <option key={entry.family} value={entry.family}>{familyLabel(entry.family)}</option>
                      ))}
                    </select>
                  </label>
                ) : null}

                <label className="play-strength">
                  <span>Bot strength</span>
                  <select
                    value={levelKey ?? ""}
                    onChange={(e) => setLevelKey(e.target.value as PlayLevelKey)}
                  >
                    {opponent.levels.map((entry) => (
                      <option key={entry.key} value={entry.key}>{entry.nominalRating} Elo</option>
                    ))}
                  </select>
                  {note ? <small>{note}</small> : null}
                </label>
              </>
            ) : (
              <div className="play-result">
                No engine opponent is available right now, so there is nobody to play. The explorer
                still works.
              </div>
            )}

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
