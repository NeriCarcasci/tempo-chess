import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useFetcher } from "react-router";
import { Chess } from "chess.js";
import { Board, type BoardArrow } from "./Board";
import { InfoTip } from "./InfoTip";
import type {
  OpeningFailure,
  OpeningGraph,
  OpeningGraphEdge,
} from "../lib/openings";
import {
  childrenOf,
  familyEntryIndex,
  fenFromNode,
  indexGraph,
  moveMeta,
  movePrefix,
  nodeAt,
  pathToNode,
  uciToSquares,
} from "../lib/openingGraph";
import { loadBoardTheme } from "../lib/boardThemes";
import { loadPieceSet } from "../lib/pieceSets";
import { openingLesson } from "../lib/openingContent";
import { apiFetch } from "../lib/api";

const NAV_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Enter",
  "Home",
]);

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "SELECT" ||
    tag === "TEXTAREA" ||
    tag === "SUMMARY" ||
    target.isContentEditable
  );
}

function evalLoss(cp: number | null | undefined): string | null {
  if (cp == null) return null;
  return (cp / 100).toFixed(1);
}

const SOLID_GLYPH: Record<string, string> = {
  k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟",
};

/** Which piece made a move, from its SAN (for the little glyph beside it). */
function movePiece(san: string): string {
  const first = san[0]!;
  if (first === "O") return "k"; // castling
  if ("NBRQK".includes(first)) return first.toLowerCase();
  return "p";
}

/** Eval in pawns from the viewer's own side: "+0.4", "0.0", "-1.2". */
function formatEval(cp: number): string {
  const v = Math.round(cp / 10) / 10; // round to 0.1, avoids "-0.0"
  if (v === 0) return "0.0";
  return `${v > 0 ? "+" : ""}${v.toFixed(1)}`;
}

interface EngineEval {
  /** Top moves (best first), each with its eval from White's perspective. */
  candidates: Array<{ uci: string; evalCp?: number; mate?: number }>;
  /** Principal variation of the best line, in UCI. */
  pv: string[];
}

function EngineEvalChip({
  evalUser,
  mateUser,
  base = "branch-eval",
}: {
  evalUser: number | null;
  mateUser: number | null;
  base?: string;
}) {
  const good = (mateUser ?? 0) > 0 || (evalUser ?? 0) >= 50;
  const bad = (mateUser ?? 0) < 0 || (evalUser ?? 0) <= -50;
  const text = mateUser != null
    ? `${mateUser > 0 ? "" : "-"}M${Math.abs(mateUser)}`
    : evalUser != null
      ? formatEval(evalUser)
      : "–";
  return <span className={`${base} ${good ? "is-good" : bad ? "is-bad" : ""}`}>{text}</span>;
}

/** Replay a UCI move on a chess.js game; returns SAN + resulting FEN, or null. */
function applyUci(game: Chess, uci: string): { san: string; fen: string } | null {
  try {
    const move = game.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci[4] as "q" | "r" | "b" | "n" | undefined,
    });
    return move ? { san: move.san, fen: game.fen() } : null;
  } catch {
    return null;
  }
}

export interface OpeningExplorerProps {
  graph: OpeningGraph;
  username: string;
  /** Filter params (platform/speed/color/since) for lazy evidence fetches. */
  filterQuery: string;
  /** Family to jump into, plus the flagged position that names it. */
  focusFamily: string | null;
  focusWeakestKey: string | null;
  /** Bumped by the parent every time a family is chosen, even the same one. */
  focusNonce: number;
  /** The repertoire side being explored; sets orientation and eval sign. */
  playingAs: "white" | "black";
}

export function OpeningExplorer({
  graph,
  username,
  filterQuery,
  focusFamily,
  focusWeakestKey,
  focusNonce,
  playingAs,
}: OpeningExplorerProps) {
  const indexed = useMemo(() => indexGraph(graph), [graph]);
  const pieceSet = useMemo(() => loadPieceSet(), []);
  const theme = useMemo(() => loadBoardTheme(), []);

  const entryPath = useCallback(
    (family: string | null, weakest: string | null): OpeningGraphEdge[] => {
      if (!family) return [];
      const target = familyEntryIndex(indexed, family, weakest);
      return target == null ? [] : pathToNode(indexed, target);
    },
    [indexed],
  );

  // moves = the walked line, future = undone moves available for redo. Kept in
  // one state so updaters stay pure (never nest setState inside setState).
  const [line, setLine] = useState<{ moves: OpeningGraphEdge[]; future: OpeningGraphEdge[] }>(
    () => ({ moves: entryPath(focusFamily, focusWeakestKey), future: [] }),
  );
  const { moves, future } = line;
  const [hover, setHover] = useState<OpeningGraphEdge | null>(null);
  const [selected, setSelected] = useState(0);
  const [flip, setFlip] = useState(playingAs === "black");
  const [evidenceKey, setEvidenceKey] = useState<string | null>(null);
  // Engine analysis of the current position + a transient board preview of the
  // engine's best line (so you can study lines you never actually played).
  const [engine, setEngine] = useState<EngineEval | null>(null);
  const [engineLoading, setEngineLoading] = useState(false);
  const [preview, setPreview] = useState<{ fen: string; lastMove?: [number, number] } | null>(null);
  const engineCache = useRef(new Map<string, EngineEval>());

  // Re-navigate whenever a family chip is chosen (nonce changes even for a
  // repeat pick). Skips the very first mount, which the initializer handled.
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    setLine({ moves: entryPath(focusFamily, focusWeakestKey), future: [] });
    setHover(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusNonce]);

  // A new graph (filters or side changed) invalidates the line; re-anchor it
  // and reset the board to the current repertoire side.
  useEffect(() => {
    setLine({ moves: entryPath(focusFamily, focusWeakestKey), future: [] });
    setHover(null);
    setFlip(playingAs === "black");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph]);

  const currentIndex = moves.length ? moves[moves.length - 1]!.b : indexed.root;
  const currentNode = nodeAt(graph, currentIndex);
  const children = childrenOf(indexed, currentIndex);

  // Reset the keyboard cursor and collapse evidence each time the line moves.
  useEffect(() => {
    setSelected(0);
    setEvidenceKey(null);
    setPreview(null);
  }, [currentIndex]);

  // Ask the engine to evaluate the current position (cached per FEN).
  const currentFen = `${nodeAt(graph, currentIndex).k} 0 1`;
  useEffect(() => {
    const cached = engineCache.current.get(currentFen);
    if (cached) {
      setEngine(cached);
      setEngineLoading(false);
      return;
    }
    const controller = new AbortController();
    setEngine(null);
    setEngineLoading(true);
    apiFetch("/analyze", {
      json: { fens: [currentFen], depth: 14, multipv: 2 },
      signal: controller.signal,
    })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error())))
      .then((data) => {
        const result = data.results?.[0];
        const candidates = ((result?.candidates ?? []) as Array<{ pv?: string[]; evalCp?: number; mate?: number }>)
          .slice(0, 2)
          .map((candidate) => ({ uci: candidate.pv?.[0] ?? "", evalCp: candidate.evalCp, mate: candidate.mate }))
          .filter((candidate) => candidate.uci);
        const evaluated: EngineEval = {
          candidates,
          pv: result?.candidates?.[0]?.pv ?? [],
        };
        engineCache.current.set(currentFen, evaluated);
        setEngine(evaluated);
        setEngineLoading(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setEngine(null);
          setEngineLoading(false);
        }
      });
    return () => controller.abort();
  }, [currentFen]);

  const play = useCallback((edge: OpeningGraphEdge) => {
    setLine((l) => ({ moves: [...l.moves, edge], future: [] }));
    setHover(null);
  }, []);

  const back = useCallback(() => {
    setLine((l) =>
      l.moves.length
        ? { moves: l.moves.slice(0, -1), future: [l.moves[l.moves.length - 1]!, ...l.future] }
        : l,
    );
    setHover(null);
  }, []);

  const forward = useCallback(() => {
    setLine((l) =>
      l.future.length
        ? { moves: [...l.moves, l.future[0]!], future: l.future.slice(1) }
        : l,
    );
    setHover(null);
  }, []);

  const reset = useCallback(() => {
    setLine({ moves: [], future: [] });
    setHover(null);
  }, []);

  const jumpTo = useCallback((moveIndex: number) => {
    // -1 jumps to the starting position.
    setLine((l) => ({ moves: l.moves.slice(0, moveIndex + 1), future: [] }));
    setHover(null);
  }, []);

  // Keyboard control, chess-GUI style. Ignored while typing in a form.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      // Defer to whatever interactive control has focus — otherwise Enter/arrows would
      // hijack activation of buttons and links elsewhere on the page.
      const target = event.target as HTMLElement | null;
      if (target?.closest("button, a, [role='button'], input, select, textarea, summary, [contenteditable='true']")) return;
      const key = event.key;
      if (key === "f" || key === "F") {
        setFlip((v) => !v);
        return;
      }
      if (!NAV_KEYS.has(key)) return;
      event.preventDefault();
      if (key === "ArrowLeft") back();
      else if (key === "ArrowRight") forward();
      else if (key === "Home") reset();
      else if (key === "ArrowUp") setSelected((i) => Math.max(0, i - 1));
      else if (key === "ArrowDown") {
        setSelected((i) => Math.min(Math.max(0, children.length - 1), i + 1));
      } else if (key === "Enter") {
        const edge = children[selected];
        if (edge) play(edge);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [back, forward, reset, play, children, selected]);

  const boardNode = currentNode;
  const boardFen = fenFromNode(boardNode);
  const displayFen = preview?.fen ?? boardFen;
  const lastMoveUci = moves[moves.length - 1]?.u ?? null;
  const baseLastMove = lastMoveUci ? uciToSquares(lastMoveUci) ?? undefined : undefined;
  const displayLastMove = preview ? preview.lastMove : baseLastMove;

  // Whose move is it at this position — yours, or a reply you're facing?
  const isYourMove = (boardNode.p % 2 === 0 ? "white" : "black") === playingAs;

  // Engine's top moves (Best / Okay) with SAN, the eval from your side, the
  // resulting FEN (to preview on the board) and its squares — plus the best
  // line's principal variation for step-through study.
  const engineView = useMemo(() => {
    if (!engine) return null;
    const suggestions = engine.candidates.map((candidate, i) => {
      const applied = applyUci(new Chess(currentFen), candidate.uci);
      const evalUser = candidate.evalCp == null ? null : playingAs === "black" ? -candidate.evalCp : candidate.evalCp;
      const mateUser = candidate.mate == null ? null : playingAs === "black" ? -candidate.mate : candidate.mate;
      return {
        uci: candidate.uci,
        san: applied?.san ?? candidate.uci,
        fen: applied?.fen ?? currentFen,
        squares: uciToSquares(candidate.uci) ?? undefined,
        evalUser,
        mateUser,
        label: i === 0 ? "Best" : "Okay",
      };
    });
    const game = new Chess(currentFen);
    const line: Array<{ san: string; fen: string; lastMove?: [number, number] }> = [];
    for (const uci of engine.pv.slice(0, 10)) {
      const applied = applyUci(game, uci);
      if (!applied) break;
      line.push({ san: applied.san, fen: applied.fen, lastMove: uciToSquares(uci) ?? undefined });
    }
    return { suggestions, line };
  }, [engine, currentFen, playingAs]);

  const engineBestUci = engineView?.suggestions[0]?.uci ?? null;
  const engineOkayUci = engineView?.suggestions[1]?.uci ?? null;
  const engineBestSquares = engineView?.suggestions[0]?.squares;
  // Engine moves you haven't played here — shown as separate suggestion cards.
  const engineSuggestions = engineView
    ? engineView.suggestions.filter((s) => !children.some((child) => child.u === s.uci))
    : [];

  // Board arrows: the engine's best (blue), plus your hovered/selected branch
  // (green when it matches the engine's best). Hidden while previewing a line.
  const branchArrowEdge = hover ?? children[selected] ?? null;
  const branchSquares = branchArrowEdge ? uciToSquares(branchArrowEdge.u) : null;
  const arrowList: BoardArrow[] = [];
  if (!preview) {
    if (engineBestSquares) {
      arrowList.push({ from: engineBestSquares[0], to: engineBestSquares[1], color: "var(--color-signal)" });
    }
    if (branchSquares && branchArrowEdge!.u !== engineBestUci) {
      arrowList.push({
        from: branchSquares[0],
        to: branchSquares[1],
        color: branchArrowEdge!.u === engineBestUci && isYourMove ? "var(--color-win)" : "var(--color-accent)",
      });
    }
  }
  const arrows = arrowList.length ? arrowList : undefined;

  const boardMeta = moveMeta(boardNode.p);
  const sideToMove = boardNode.p % 2 === 0 ? "White" : "Black";
  const reachShare = graph.games
    ? Math.round((boardNode.g / graph.games) * 100)
    : 0;

  // Name the position from the confident opening labels along the line, not the
  // node's own name: shared shallow positions inherit an arbitrary game's name
  // (e.g. "Ruy Lopez" after 1.e4), which would be misleading.
  const lineLabel = (() => {
    for (let i = moves.length - 1; i >= 0; i--) {
      if (moves[i]!.lb) return moves[i]!.lb!;
    }
    return null;
  })();
  const lastLineEdge = moves[moves.length - 1];
  const positionTitle = lineLabel
    ? lineLabel
    : boardNode.p === 0 || !lastLineEdge
      ? "Starting position"
      : `After ${movePrefix(nodeAt(graph, lastLineEdge.a).p)}${lastLineEdge.s}`;

  // The opening this line is in — drives the guide panel below the board.
  const currentOpening = lineLabel ?? focusFamily;

  return (
    <section className="explorer" aria-label="Opening explorer">
      <div className="explorer-workspace">
        <div className="explorer-board-col">
          <div className="explorer-board-frame">
            <Board
              fen={displayFen}
              flip={flip}
              lastMove={displayLastMove}
              arrows={arrows}
              light={theme.light}
              dark={theme.dark}
              pieceSet={pieceSet}
            />
          </div>

          <div className="explorer-controls" role="group" aria-label="Board controls">
            <button
              type="button"
              className="explorer-ctl"
              onClick={reset}
              disabled={!moves.length}
              aria-label="Back to the starting position (Home)"
              title="Starting position (Home)"
            >
              <span aria-hidden="true">⏮</span>
            </button>
            <button
              type="button"
              className="explorer-ctl"
              onClick={back}
              disabled={!moves.length}
              aria-label="One move back (Left arrow)"
              title="Back (←)"
            >
              <span aria-hidden="true">‹</span>
            </button>
            <button
              type="button"
              className="explorer-ctl"
              onClick={forward}
              disabled={!future.length}
              aria-label="One move forward (Right arrow)"
              title="Forward (→)"
            >
              <span aria-hidden="true">›</span>
            </button>
            <button
              type="button"
              className="explorer-ctl explorer-ctl-flip"
              onClick={() => setFlip((v) => !v)}
              aria-label="Flip the board (F)"
              title="Flip board (F)"
              aria-pressed={flip}
            >
              <span aria-hidden="true">⇅</span> Flip
            </button>
          </div>

          <div className="explorer-caption">
            <p className="cap">
              {currentNode.p === 0
                ? "move 1"
                : `move ${boardMeta.number}, ${sideToMove} to play`}
            </p>
            <h3>{positionTitle}</h3>
            <div className="explorer-reach">
              <span className="metric">
                {boardNode.g} of {graph.games}
              </span>
              <span> of your {playingAs} games reached here</span>
              <span className="explorer-reach-track" aria-hidden="true">
                <i style={{ width: `${Math.max(2, reachShare)}%` }} />
              </span>
            </div>
          </div>

          <p className="explorer-hint">
            Hover a move to see its arrow, click to play it. Use <kbd>←</kbd> <kbd>→</kbd> to
            step, <kbd>↑</kbd> <kbd>↓</kbd> <kbd>↵</kbd> to pick a branch, <kbd>F</kbd> to flip.
          </p>

          <Link
            to={`/play?fen=${encodeURIComponent(currentFen)}&color=${playingAs}`}
            className="explorer-play-btn"
          >
            <span aria-hidden="true">▷</span> Play this position vs the bot
          </Link>
        </div>

        <div className="explorer-detail-col">
          <MoveList graph={graph} moves={moves} onJump={jumpTo} onReset={reset} />

          <div className="explorer-branches-head">
            <h3>{isYourMove ? "Your move — what do you play?" : "Replies you've faced"}</h3>
            <InfoTip label="branches">
              {isYourMove
                ? "The moves you've chosen here, most frequent first. The engine's best and okay moves are labelled; any it likes that you haven't tried appear under Engine."
                : "The replies your opponents have played here. The engine's best and okay replies are labelled so you know what to prepare for."}
            </InfoTip>
          </div>

          {children.length ? (
            <ul className={`explorer-branches ${isYourMove ? "" : "is-theirs"}`}>
              {children.map((edge, i) => {
                const side = currentNode.p % 2 === 0 ? "white" : "black";
                const loss = evalLoss(edge.al);
                const target = nodeAt(graph, edge.b);
                const rank = edge.u === engineBestUci ? "best" : edge.u === engineOkayUci ? "okay" : null;
                const evUser = edge.ev == null ? null : playingAs === "black" ? -edge.ev : edge.ev;
                // Green "good" only celebrates YOUR strong moves. For an
                // opponent reply we only flag the dangerous ones (bad for you).
                const evClass = evUser == null
                  ? ""
                  : isYourMove
                    ? evUser >= 50 ? "is-good" : evUser <= -50 ? "is-bad" : ""
                    : evUser <= -50 ? "is-bad" : "";
                return (
                  <li key={`${edge.a}-${edge.u}-${edge.b}`}>
                    <button
                      type="button"
                      className={[
                        "branch",
                        `is-${side}`,
                        edge.ac === "p" ? "is-player" : "",
                        rank ? `is-${rank}` : "",
                        edge.fa > 0 ? "has-costly" : "",
                        i === selected ? "is-selected" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      onClick={() => play(edge)}
                      onMouseEnter={() => setHover(edge)}
                      onMouseLeave={() => setHover((h) => (h === edge ? null : h))}
                      onFocus={() => setSelected(i)}
                      aria-label={`${edge.s}${rank === "best" ? ", the engine's best move" : rank === "okay" ? ", an okay move" : ""}${evUser != null ? `, evaluation ${formatEval(evUser)} for you` : ""}, played in ${edge.g} of ${graph.games} games${edge.fa > 0 ? `, ${edge.fa} costly` : ""}`}
                    >
                      <span className={`branch-move is-${side}`}>
                        <span className="branch-piece" aria-hidden="true">{SOLID_GLYPH[movePiece(edge.s)]}</span>
                        {edge.s}
                      </span>
                      <span className="branch-body">
                        <span className="branch-top">
                          {rank === "best" ? (
                            <span className="branch-best">★ Best</span>
                          ) : rank === "okay" ? (
                            <span className="branch-okay">Okay</span>
                          ) : null}
                          {edge.lb ? (
                            <span className="branch-label">{edge.lb}</span>
                          ) : target.x ? (
                            <span className="branch-transposition" title="Also reached by another move order">
                              transposes
                            </span>
                          ) : null}
                        </span>
                        <span className="branch-share">
                          <span className="branch-share-track" aria-hidden="true">
                            <i style={{ width: `${Math.max(3, edge.sh)}%` }} />
                          </span>
                          <span className="branch-count metric">
                            {edge.g} game{edge.g === 1 ? "" : "s"}
                          </span>
                        </span>
                      </span>
                      <span className="branch-flags">
                        {evUser != null ? (
                          <span className={`branch-eval ${evClass}`}>{formatEval(evUser)}</span>
                        ) : (
                          <span className="branch-chevron" aria-hidden="true">›</span>
                        )}
                        {edge.fa > 0 ? (
                          <span className="branch-costly">{edge.fa} costly{loss ? ` -${loss}` : ""}</span>
                        ) : null}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="branch-end">
              <strong>End of your games here.</strong>
              <p>
                None of your games continued past this position. Follow the engine's
                line below to keep studying, or step back to try another branch.
              </p>
            </div>
          )}

          <section className="engine-panel" aria-label="Engine analysis">
            <div className="engine-head">
              <span className="engine-badge">Engine</span>
              {engineView?.suggestions[0] ? (
                <EngineEvalChip
                  evalUser={engineView.suggestions[0].evalUser}
                  mateUser={engineView.suggestions[0].mateUser}
                  base="engine-eval"
                />
              ) : (
                <span className="engine-loading">{engineLoading ? "analysing…" : "unavailable"}</span>
              )}
            </div>
            {engineView ? (
              <>
                {engineSuggestions.length ? (
                  <ul className="explorer-branches engine-suggest">
                    {engineSuggestions.map((s) => {
                      const sSide = currentNode.p % 2 === 0 ? "white" : "black";
                      return (
                        <li key={s.uci}>
                          <button
                            type="button"
                            className={`branch is-engine ${s.label === "Best" ? "is-best" : "is-okay"}`}
                            onMouseEnter={() => setPreview({ fen: s.fen, lastMove: s.squares })}
                            onMouseLeave={() => setPreview(null)}
                            onFocus={() => setPreview({ fen: s.fen, lastMove: s.squares })}
                            onBlur={() => setPreview(null)}
                            aria-label={`${s.san}, the engine's ${s.label.toLowerCase()} move${s.evalUser != null ? `, evaluation ${formatEval(s.evalUser)} for you` : ""}`}
                          >
                            <span className={`branch-move is-${sSide}`}>
                              <span className="branch-piece" aria-hidden="true">{SOLID_GLYPH[movePiece(s.san)]}</span>
                              {s.san}
                            </span>
                            <span className="branch-body">
                              <span className="branch-top">
                                {s.label === "Best" ? (
                                  <span className="branch-best">★ Best</span>
                                ) : (
                                  <span className="branch-okay">Okay</span>
                                )}
                                <span className="branch-engine-tag">engine · not in your games</span>
                              </span>
                            </span>
                            <span className="branch-flags">
                              <EngineEvalChip evalUser={s.evalUser} mateUser={s.mateUser} />
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="engine-hint">You've already played the engine's top moves here.</p>
                )}
                {engineView.line.length ? (
                  <div className="engine-line" aria-label="Engine's best line">
                    {engineView.line.map((step, i) => (
                      <button
                        key={`${i}-${step.san}`}
                        type="button"
                        className="engine-move"
                        onMouseEnter={() => setPreview({ fen: step.fen, lastMove: step.lastMove })}
                        onMouseLeave={() => setPreview(null)}
                        onFocus={() => setPreview({ fen: step.fen, lastMove: step.lastMove })}
                        onBlur={() => setPreview(null)}
                      >
                        {step.san}
                      </button>
                    ))}
                  </div>
                ) : null}
                <p className="engine-hint">Hover a move to watch it on the board.</p>
              </>
            ) : engineLoading ? (
              <div className="engine-skeleton" />
            ) : (
              <p className="engine-hint">Engine analysis isn't available for this position right now.</p>
            )}
          </section>

          <PositionInsight
            node={currentNode}
            username={username}
            filterQuery={filterQuery}
            evidenceOpen={evidenceKey === currentNode.k}
            onToggleEvidence={() =>
              setEvidenceKey((k) => (k === currentNode.k ? null : currentNode.k))
            }
          />
        </div>
      </div>

      {currentOpening ? <OpeningInfo opening={currentOpening} fen={currentFen} /> : null}
    </section>
  );
}

function OpeningInfo({ opening, fen }: { opening: string; fen: string }) {
  const lesson = openingLesson(opening);
  const lichess = `https://lichess.org/analysis/${fen.replace(/ /g, "_")}`;
  return (
    <section className="opening-info" aria-label={`About ${opening}`}>
      <div className="opening-info-head">
        <p className="eyebrow">Opening guide</p>
        <h2>{opening}</h2>
      </div>
      <p className="opening-info-summary">{lesson.summary}</p>
      <div className="opening-info-grid">
        <div>
          <h3>Plans &amp; ideas</h3>
          <ul>{lesson.ideas.map((idea) => <li key={idea}>{idea}</li>)}</ul>
        </div>
        <div>
          <h3>Watch for</h3>
          <p>{lesson.watchFor}</p>
          {lesson.notablePlayers.length ? (
            <>
              <h3 className="opening-info-players">Players to study</h3>
              <p>{lesson.notablePlayers.join(" · ")}</p>
            </>
          ) : null}
          <a href={lichess} target="_blank" rel="noreferrer" className="opening-info-link">
            Study master games on Lichess <span aria-hidden="true">→</span>
          </a>
        </div>
      </div>
    </section>
  );
}

function MoveCell({
  cell,
  current,
  onJump,
}: {
  cell: { edge: OpeningGraphEdge; index: number } | undefined;
  current: number;
  onJump: (moveIndex: number) => void;
}) {
  if (!cell) return <span className="movelist-cell is-empty" aria-hidden="true" />;
  const isCurrent = cell.index === current;
  return (
    <button
      type="button"
      className={`movelist-cell ${isCurrent ? "is-current" : ""} ${cell.edge.fa > 0 ? "has-costly" : ""}`}
      onClick={() => onJump(cell.index)}
      aria-current={isCurrent ? "true" : undefined}
    >
      <span className="movelist-piece" aria-hidden="true">{SOLID_GLYPH[movePiece(cell.edge.s)]}</span>
      {cell.edge.s}
    </button>
  );
}

/** Lichess-style two-column move list of the active line (the historic spine). */
function MoveList({
  graph,
  moves,
  onJump,
  onReset,
}: {
  graph: OpeningGraph;
  moves: OpeningGraphEdge[];
  onJump: (moveIndex: number) => void;
  onReset: () => void;
}) {
  const endRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [moves.length]);

  const rowMap = new Map<number, { white?: { edge: OpeningGraphEdge; index: number }; black?: { edge: OpeningGraphEdge; index: number } }>();
  moves.forEach((edge, index) => {
    const { number, isWhite } = moveMeta(nodeAt(graph, edge.a).p);
    const row = rowMap.get(number) ?? {};
    if (isWhite) row.white = { edge, index };
    else row.black = { edge, index };
    rowMap.set(number, row);
  });
  const rows = [...rowMap.entries()].sort((a, b) => a[0] - b[0]);
  const current = moves.length - 1;

  return (
    <div className="movelist-panel">
      <div className="movelist-head">
        <span className="cap">Your line</span>
        <button type="button" className="movelist-reset" onClick={onReset} disabled={!moves.length}>
          ⟲ Start
        </button>
      </div>
      {moves.length ? (
        <ol className="movelist" aria-label="Moves in the current line">
          {rows.map(([number, row]) => (
            <li key={number}>
              <span className="movelist-num">{number}.</span>
              <MoveCell cell={row.white} current={current} onJump={onJump} />
              <MoveCell cell={row.black} current={current} onJump={onJump} />
            </li>
          ))}
          <li ref={endRef} aria-hidden="true" className="movelist-end" />
        </ol>
      ) : (
        <p className="movelist-empty">No moves yet — pick a move below to start your line.</p>
      )}
    </div>
  );
}

function PositionInsight({
  node,
  username,
  filterQuery,
  evidenceOpen,
  onToggleEvidence,
}: {
  node: OpeningGraph["nodes"][number];
  username: string;
  filterQuery: string;
  evidenceOpen: boolean;
  onToggleEvidence: () => void;
}) {
  const practice = useFetcher();
  const hasFailures = node.f > 0;
  const canPractice = hasFailures;

  // Nothing actionable here (e.g. an opponent-to-move position); stay quiet.
  if (!hasFailures) return null;

  return (
    <div className="explorer-insight">
      {(canPractice || hasFailures) && (
        <div className="explorer-actions">
          {hasFailures && (
            <button
              type="button"
              className="secondary-button"
              onClick={onToggleEvidence}
              aria-expanded={evidenceOpen}
            >
              {evidenceOpen ? "Hide the games" : `Show the ${node.f} flagged ${node.f === 1 ? "game" : "games"}`}
            </button>
          )}
          {canPractice && (
            <practice.Form method="post">
              <input type="hidden" name="intent" value="drill" />
              <input type="hidden" name="username" value={username} />
              <input type="hidden" name="positionKey" value={node.k} />
              <button className="primary-button" disabled={practice.state !== "idle"}>
                {practice.state === "idle" ? "Practice this position" : "Adding…"}
              </button>
            </practice.Form>
          )}
        </div>
      )}
      {practice.data && typeof practice.data === "object" && "message" in practice.data ? (
        <p className="action-message" aria-live="polite">
          {String((practice.data as { message: string }).message)}
        </p>
      ) : null}

      {evidenceOpen && (
        <Evidence positionKey={node.k} username={username} filterQuery={filterQuery} />
      )}
    </div>
  );
}

function Evidence({
  positionKey,
  username,
  filterQuery,
}: {
  positionKey: string;
  username: string;
  filterQuery: string;
}) {
  const [state, setState] = useState<{
    loading: boolean;
    failures: OpeningFailure[];
    error: boolean;
  }>({ loading: true, failures: [], error: false });

  useEffect(() => {
    const controller = new AbortController();
    setState({ loading: true, failures: [], error: false });
    const query = new URLSearchParams(filterQuery);
    query.set("username", username);
    query.set("node", positionKey);
    query.set("graph", "0"); // evidence only needs failures, not the whole graph
    apiFetch(`/opening-explorer?${query}`, { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error())))
      .then((data) => {
        setState({
          loading: false,
          failures: (data.failures ?? []) as OpeningFailure[],
          error: false,
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setState({ loading: false, failures: [], error: true });
        }
      });
    return () => controller.abort();
  }, [positionKey, username, filterQuery]);

  if (state.loading) {
    return (
      <div className="explorer-evidence is-loading" aria-live="polite">
        <span className="evidence-skeleton" />
        <span className="evidence-skeleton" />
      </div>
    );
  }
  if (state.error) {
    return <p className="explorer-evidence-empty">Could not load these games right now.</p>;
  }
  if (!state.failures.length) {
    return (
      <p className="explorer-evidence-empty">
        No single flagged game reproduced from this exact position under the
        current filters.
      </p>
    );
  }

  return (
    <div className="explorer-evidence">
      {state.failures.map((failure) => {
        const date = failure.playedAt
          ? new Intl.DateTimeFormat(undefined, {
              day: "numeric",
              month: "short",
              year: "numeric",
            }).format(new Date(failure.playedAt))
          : "Date unavailable";
        const swing = evalLoss(failure.evaluationLossCp);
        return (
          <article className="evidence-game" key={`${failure.gameId}-${failure.ply}`}>
            <div>
              <strong>vs {failure.opponent ?? "Unknown player"}</strong>
              <span>
                {date} · move {Math.ceil(failure.ply / 2)} · {failure.result}
              </span>
            </div>
            <div className="evidence-move">
              <span>
                You played <b>{failure.moveSan}</b>
              </span>
            </div>
            <div className="evidence-cost">
              {swing ? <strong>−{swing}</strong> : <strong>Cost n/a</strong>}
            </div>
            <Link
              to={`/game/${failure.platformGameId}?ply=${failure.ply}`}
              className="text-link"
            >
              Review <span aria-hidden="true">→</span>
            </Link>
          </article>
        );
      })}
    </div>
  );
}
