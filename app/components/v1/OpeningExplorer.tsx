/**
 * The opening explorer, on `/v1`.
 *
 * The walk is the interaction: the whole graph arrives once and stepping into a
 * line is in-memory, so a branch click costs nothing and a keypress never waits
 * on a network round trip. The graph-walking helpers in `app/lib/openingGraph`
 * are shared with the legacy screen — they are pure and the two encodings are
 * the same shape.
 *
 * Three things this screen does differently from the legacy one, all because
 * `/v1` tells the truth about more of its own state:
 *
 *   - **Unjudged is not clean.** The API separates "your move was fine" from
 *     "nobody has looked at your move". A position whose games were never
 *     analysed shows that gap rather than a reassuring zero.
 *   - **The engine is asked, not assumed.** `POST /v1/positions/evaluations` is
 *     a rate-limited command that can answer "queued". Evaluating on every
 *     board step would spend the actor's budget on a walk, so the panel asks.
 *   - **Loss is expected score.** The v1 edge carries `dl` in the 0..1 units the
 *     calibration pins, not centipawns. It is rendered as what it is.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Board, type BoardArrow } from "../Board";
import { InfoTip } from "../InfoTip";
import { CoverageBadge, EmptyState, ProblemNote } from "./Honesty";
import type { OpeningGraph, OpeningGraphNode } from "../../lib/openings";
import {
  actorLabel,
  childrenOf,
  indexGraph,
  moveMeta,
  movePrefix,
  nodeAt,
  uciToSquares,
} from "../../lib/openingGraph";
import { loadBoardTheme } from "../../lib/boardThemes";
import { loadPieceSet } from "../../lib/pieceSets";
import { evaluatePosition, walkable, type PositionEvaluation } from "../../lib/v1/openings";
import type {
  OpeningExplorerCoverage,
  OpeningGraphV1,
  OpeningGraphV1Edge,
} from "../../lib/v1/types";

/**
 * The walking helpers are typed against the legacy encoding, which carries `al`
 * in centipawns where v1 carries `dl` in expected score. Every field they read
 * is identical, so the graph is widened once on the way in and the edges they
 * hand back are narrowed once on the way out. Both are the same object at
 * runtime; the two casts exist so `dl` stays typed rather than being read off
 * an `any`.
 */
function asV1Edges(edges: readonly { u: string }[]): OpeningGraphV1Edge[] {
  return edges as unknown as OpeningGraphV1Edge[];
}

const NAV_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "Enter"]);

/** Typing beats navigating: never steal a key from a field. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/** The piece letter a SAN move starts with, for the glyph beside it. */
const SOLID_GLYPH: Record<string, string> = {
  K: "♚",
  Q: "♛",
  R: "♜",
  B: "♝",
  N: "♞",
  P: "♟",
};

function movePiece(san: string): string {
  const head = san[0] ?? "";
  if (head === "O") return SOLID_GLYPH.K!;
  return SOLID_GLYPH[head] ?? SOLID_GLYPH.P!;
}

/**
 * An evaluation, from the side being studied.
 *
 * The API states centipawns from White's point of view. A Black repertoire
 * wants the sign flipped, and doing it here rather than in the payload keeps
 * one number on the wire with one meaning.
 */
export function formatEval(scoreCp: number | null, mateIn: number | null, playingAs: "white" | "black"): string {
  const sign = playingAs === "white" ? 1 : -1;
  if (mateIn !== null) return `#${Math.abs(mateIn)}`;
  if (scoreCp === null) return "—";
  const value = (scoreCp * sign) / 100;
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}`;
}

/**
 * Expected-score loss as a sentence.
 *
 * Not centipawns, and deliberately not dressed up as one. `dl` is the drop in
 * expected points the calibration assigns to the move, so 0.06 is "about six
 * points of expected score in a hundred".
 */
export function formatLoss(dl: number | undefined): string | null {
  if (dl === undefined || dl <= 0) return null;
  return `costs ${(dl * 100).toFixed(1)}% expected score`;
}

/**
 * How many of the player's own games played this move without a verdict.
 *
 * `g` is games that played it; `op` is the ones a published analysis judged.
 * The remainder is not a success and not a failure, and the branch says so.
 * An opponent move is excluded: Forma does not judge those, so the gap there
 * is not a coverage gap.
 */
export function unjudgedOn(edge: OpeningGraphV1Edge): number {
  if (edge.ac === "o") return 0;
  return Math.max(0, edge.g - edge.op);
}

interface Line {
  moves: OpeningGraphV1Edge[];
  future: OpeningGraphV1Edge[];
}

export interface OpeningExplorerProps {
  graph: OpeningGraphV1;
  coverage: OpeningExplorerCoverage;
  /** Sets board orientation and the sign of every evaluation. */
  playingAs: "white" | "black";
}

export function OpeningExplorer({ graph, coverage, playingAs }: OpeningExplorerProps) {
  const walkableGraph = useMemo<OpeningGraph>(() => walkable(graph), [graph]);
  const indexed = useMemo(() => indexGraph(walkableGraph), [walkableGraph]);
  const pieceSet = useMemo(() => loadPieceSet(), []);
  const theme = useMemo(() => loadBoardTheme(), []);

  const [line, setLine] = useState<Line>({ moves: [], future: [] });
  const [hover, setHover] = useState<OpeningGraphV1Edge | null>(null);
  const [selected, setSelected] = useState(0);
  const [flipped, setFlipped] = useState(playingAs === "black");

  const currentIndex = line.moves.length ? line.moves[line.moves.length - 1]!.b : indexed.root;
  const currentNode = nodeAt(walkableGraph, currentIndex);
  const currentFen = `${currentNode.k} 0 1`;
  const branches = useMemo(
    () => asV1Edges(childrenOf(indexed, currentIndex)),
    [indexed, currentIndex],
  );

  useEffect(() => setSelected(0), [currentIndex]);

  const play = useCallback((edge: OpeningGraphV1Edge) => {
    setLine((l) => ({ moves: [...l.moves, edge], future: [] }));
    setHover(null);
  }, []);

  const back = useCallback(() => {
    setLine((l) => {
      if (!l.moves.length) return l;
      const moves = l.moves.slice(0, -1);
      return { moves, future: [l.moves[l.moves.length - 1]!, ...l.future] };
    });
  }, []);

  const forward = useCallback(() => {
    setLine((l) => {
      if (!l.future.length) return l;
      return { moves: [...l.moves, l.future[0]!], future: l.future.slice(1) };
    });
  }, []);

  const reset = useCallback(() => setLine({ moves: [], future: [] }), []);

  const jumpTo = useCallback((index: number) => {
    setLine((l) => ({ moves: l.moves.slice(0, index + 1), future: [] }));
  }, []);

  // Keyboard navigation. Suppressed inside anything that takes typing, and when
  // a modifier is held, so browser shortcuts keep working.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      if (event.key === "f" || event.key === "F") {
        setFlipped((f) => !f);
        return;
      }
      if (!NAV_KEYS.has(event.key)) return;
      event.preventDefault();
      if (event.key === "ArrowLeft") back();
      else if (event.key === "ArrowRight") forward();
      else if (event.key === "Home") reset();
      else if (event.key === "ArrowUp") setSelected((s) => Math.max(0, s - 1));
      else if (event.key === "ArrowDown") setSelected((s) => Math.min(branches.length - 1, s + 1));
      else if (event.key === "Enter" && branches[selected]) play(branches[selected]!);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [back, forward, reset, play, branches, selected]);

  const lastMove = useMemo(() => {
    const edge = line.moves[line.moves.length - 1];
    return edge ? (uciToSquares(edge.u) ?? undefined) : undefined;
  }, [line.moves]);

  const arrows = useMemo<BoardArrow[]>(() => {
    if (!hover) return [];
    const squares = uciToSquares(hover.u);
    if (!squares) return [];
    return [{ from: squares[0], to: squares[1], color: "var(--color-accent)" }];
  }, [hover]);

  const parentGames = currentNode.g || 1;

  return (
    <section className="explorer">
      <div className="explorer-workspace">
        <div className="explorer-board-col">
          <div className="explorer-board-frame">
            <Board
              fen={currentFen}
              flip={flipped}
              lastMove={lastMove}
              arrows={arrows}
              light={theme.light}
              dark={theme.dark}
              pieceSet={pieceSet}
              silent
            />
          </div>

          <div className="explorer-controls">
            <button type="button" className="explorer-ctl" onClick={reset} disabled={!line.moves.length}>
              &#x27F2; Start
            </button>
            <button type="button" className="explorer-ctl" onClick={back} disabled={!line.moves.length}>
              &larr; Back
            </button>
            <button type="button" className="explorer-ctl" onClick={forward} disabled={!line.future.length}>
              Forward &rarr;
            </button>
            <button
              type="button"
              className="explorer-ctl"
              onClick={() => setFlipped((f) => !f)}
              aria-pressed={flipped}
            >
              Flip
            </button>
          </div>

          <p className="explorer-caption">
            <span className="cap">
              Ply {currentNode.p} · {currentNode.p % 2 === 0 ? "White" : "Black"} to move
            </span>
            <span className="explorer-reach">
              {currentNode.g} of {graph.games} {graph.games === 1 ? "game" : "games"} reached here
            </span>
            {currentNode.x === 1 ? (
              <span className="tag tag-sub">reached by more than one move order</span>
            ) : null}
          </p>

          <p className="explorer-hint">
            <kbd>&larr;</kbd> <kbd>&rarr;</kbd> step · <kbd>&uarr;</kbd> <kbd>&darr;</kbd> choose ·{" "}
            <kbd>Enter</kbd> play · <kbd>F</kbd> flip
          </p>
        </div>

        <div className="explorer-detail-col">
          <MoveList moves={line.moves} onJump={jumpTo} onReset={reset} />

          <div className="explorer-branches-head">
            <h2 className="eyebrow">What was played here</h2>
            <InfoTip label="About these branches">
              Every branch is a move played in your own games, and the share is of the games that
              reached this position. A move nobody has analysed is counted as played, never as
              correct.
            </InfoTip>
          </div>

          {branches.length ? (
            <ul className="explorer-branches">
              {branches.map((edge, index) => (
                <Branch
                  key={`${edge.a}-${edge.u}`}
                  edge={edge}
                  parentGames={parentGames}
                  active={index === selected}
                  playingAs={playingAs}
                  onPlay={() => play(edge)}
                  onHover={() => setHover(edge)}
                  onLeave={() => setHover(null)}
                  onFocus={() => setSelected(index)}
                />
              ))}
            </ul>
          ) : (
            <EmptyState
              title="The line ends here"
              detail="No game in this sample continued past this position."
            />
          )}

          <PositionCoverage node={currentNode} coverage={coverage} />
          <EnginePanel fen={currentFen} playingAs={playingAs} />
        </div>
      </div>
    </section>
  );
}

function Branch({
  edge,
  parentGames,
  active,
  playingAs,
  onPlay,
  onHover,
  onLeave,
  onFocus,
}: {
  edge: OpeningGraphV1Edge;
  parentGames: number;
  active: boolean;
  playingAs: "white" | "black";
  onPlay: () => void;
  onHover: () => void;
  onLeave: () => void;
  onFocus: () => void;
}) {
  const share = parentGames ? Math.round((edge.g / parentGames) * 100) : edge.sh;
  const loss = formatLoss(edge.dl);
  const unjudged = unjudgedOn(edge);

  // Colour never carries a fact on its own: the label always names the state.
  const label = [
    `${edge.s},`,
    `${edge.g} ${edge.g === 1 ? "game" : "games"},`,
    `${share}% of this position,`,
    actorLabel(edge.ac),
    edge.fa > 0 ? `, ${edge.fa} flagged` : "",
    unjudged > 0 ? `, ${unjudged} not analysed` : "",
  ].join(" ");

  return (
    <li>
      <button
        type="button"
        className={`branch${active ? " is-selected" : ""}`}
        onClick={onPlay}
        onMouseEnter={onHover}
        onMouseLeave={onLeave}
        onFocus={onFocus}
        aria-label={label}
      >
        <span className="branch-move">
          <span className="branch-piece" aria-hidden="true">
            {movePiece(edge.s)}
          </span>
          {edge.s}
        </span>
        <span className="branch-share" aria-hidden="true">
          <span className="branch-share-track">
            <i style={{ width: `${share}%` }} />
          </span>
        </span>
        <span className="branch-count">
          {edge.g} · {share}%
        </span>
        <span className="branch-body">
          <span className="cap">{actorLabel(edge.ac)}</span>
          {edge.ev !== undefined ? (
            <span className="branch-eval">{formatEval(edge.ev, null, playingAs)}</span>
          ) : null}
          {edge.bm === 1 ? <span className="tag tag-signal">engine&rsquo;s choice</span> : null}
          {edge.fa > 0 ? (
            <span className="tag tag-loss">
              {edge.fa} flagged{loss ? ` · ${loss}` : ""}
            </span>
          ) : null}
          {unjudged > 0 ? <span className="tag tag-unknown">{unjudged} not analysed</span> : null}
          {edge.lb ? <span className="branch-label">{edge.lb}</span> : null}
        </span>
      </button>
    </li>
  );
}

/**
 * What is known about this position, and what is not.
 *
 * The important number is the third one. `playerDecisions - scoredDecisions` is
 * how many of the person's own moves nobody has judged, and leaving it out
 * would let a position with no analysis read exactly like a position played
 * perfectly.
 */
function PositionCoverage({
  node,
  coverage,
}: {
  node: OpeningGraphNode;
  coverage: OpeningExplorerCoverage;
}) {
  const unjudged = Math.max(0, coverage.playerDecisions - coverage.scoredDecisions);
  const state =
    coverage.scoredDecisions === 0
      ? "insufficient"
      : unjudged > coverage.scoredDecisions
        ? "limited"
        : "sufficient";

  return (
    <section className="explorer-insight" aria-label="What this is based on">
      <div className="explorer-insight-head">
        <h2 className="eyebrow">What this is based on</h2>
        <CoverageBadge state={state} />
      </div>
      <ul className="explorer-facts">
        <li>
          <span className="metric">{node.g}</span>
          <span className="cap">
            {node.g === 1 ? "game" : "games"} reached this position
          </span>
        </li>
        <li>
          <span className="metric">{coverage.scoredDecisions}</span>
          <span className="cap">of your moves have a published verdict</span>
        </li>
        {unjudged > 0 ? (
          <li>
            <span className="metric">{unjudged}</span>
            <span className="cap">
              of your moves nobody has analysed yet — not counted as correct
            </span>
          </li>
        ) : null}
        {coverage.unanalysedGames > 0 ? (
          <li>
            <span className="metric">{coverage.unanalysedGames}</span>
            <span className="cap">
              {coverage.unanalysedGames === 1 ? "game has" : "games have"} no analysis behind them
            </span>
          </li>
        ) : null}
      </ul>
    </section>
  );
}

/**
 * The engine, on request.
 *
 * `POST /v1/positions/evaluations` is a command with an idempotency key and a
 * per-actor rate limit, and it may answer 202. So this asks once, when asked,
 * and caches per position for the life of the screen. The three states it can
 * be in — never asked, queued, answered — are rendered distinctly, because a
 * queued evaluation shown as a dash is indistinguishable from an engine that
 * looked and found nothing.
 */
function EnginePanel({ fen, playingAs }: { fen: string; playingAs: "white" | "black" }) {
  const cache = useRef(new Map<string, PositionEvaluation>());
  const [result, setResult] = useState<PositionEvaluation | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // A new position is a new question. Show the cached answer if there is one,
  // and otherwise go back to "not asked" rather than leaving the previous
  // position's evaluation on screen under a different board.
  useEffect(() => {
    setResult(cache.current.get(fen) ?? null);
    setError(null);
    setPending(false);
  }, [fen]);

  const ask = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      const evaluation = await evaluatePosition(fen);
      cache.current.set(fen, evaluation);
      setResult(evaluation);
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(false);
    }
  }, [fen]);

  return (
    <section className="engine-panel" aria-label="Engine evaluation">
      <div className="engine-head">
        <span className="engine-badge">Engine</span>
        {result?.state === "ready" ? (
          <span className="engine-eval">
            {formatEval(result.scoreCp, result.mateIn, playingAs)}
          </span>
        ) : null}
      </div>

      {error ? (
        <ProblemNote error={error} retry={
          <button type="button" className="secondary-button" onClick={ask}>
            Try again
          </button>
        } />
      ) : result?.state === "ready" ? (
        <ul className="engine-suggest">
          {result.candidates.slice(0, 3).map((candidate) => (
            <li key={candidate.uci}>
              <span className="branch-move">{candidate.uci}</span>
              <span className="branch-count">
                {(candidate.expectedScore * 100).toFixed(0)}% expected
              </span>
            </li>
          ))}
        </ul>
      ) : result?.state === "queued" ? (
        <p className="engine-hint" aria-live="polite">
          The engine is working on this position. Come back to it in a moment — the answer is
          cached once it lands.
        </p>
      ) : (
        <>
          <p className="engine-hint">
            Evaluating a position is a real engine job, so it happens when you ask rather than on
            every move.
          </p>
          <button type="button" className="secondary-button" onClick={ask} disabled={pending}>
            {pending ? "Asking…" : "Evaluate this position"}
          </button>
        </>
      )}
    </section>
  );
}

function MoveList({
  moves,
  onJump,
  onReset,
}: {
  moves: OpeningGraphV1Edge[];
  onJump: (index: number) => void;
  onReset: () => void;
}) {
  const end = useRef<HTMLLIElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [moves.length]);

  if (!moves.length) {
    return (
      <div className="movelist-head">
        <span className="cap">The starting position</span>
      </div>
    );
  }

  return (
    <div className="movelist-wrap">
      <div className="movelist-head">
        <span className="cap">Your line</span>
        <button type="button" className="movelist-reset" onClick={onReset}>
          &#x27F2; Start
        </button>
      </div>
      <ol className="movelist">
        {moves.map((edge, index) => {
          const meta = moveMeta(index);
          const last = index === moves.length - 1;
          return (
            <li key={`${edge.a}-${edge.u}-${index}`}>
              <button
                type="button"
                className="movelist-cell"
                onClick={() => onJump(index)}
                aria-current={last ? "step" : undefined}
              >
                {meta.isWhite ? <span className="movelist-no">{movePrefix(index)}</span> : null}
                <span className="movelist-piece" aria-hidden="true">
                  {movePiece(edge.s)}
                </span>
                {edge.s}
              </button>
            </li>
          );
        })}
        <li ref={end} className="movelist-end" />
      </ol>
    </div>
  );
}
