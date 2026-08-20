import { Link } from "react-router";
import { Board } from "./Board";
import { TopNav } from "./TopNav";
import { EmptyState } from "./v1/Honesty";
import { relTimeIso } from "../lib/format";
import type { OpeningShape } from "../lib/todayShape";
import type { SheetCell, SheetRow, TearSheet } from "../lib/tearSheet";
import type { RecentGame } from "../lib/v1/games";
import type { ExplorerEmptyReason } from "../lib/v1/openings";
import { explorerEmptyCopy } from "../lib/v1/openings";
import type { Destination } from "../lib/onboarding/nextScreen";

/**
 * Today: how your chess is going, then the one thing to do about it.
 *
 * The page this replaced was a stat dump of five panels, none of which named a
 * decision. The page that replaced *that* was the opposite mistake: it deleted
 * every trace of state and opened on one cell of one line of one opening, so a
 * reader arrived with no idea how they were doing and a micro-detail wearing
 * hero type. Restraint and emptiness are not the same thing.
 *
 * PRODUCT.md's second principle asks the top of the screen to answer **both**
 * halves: how am I doing, and what should I fix. So the page opens on the
 * shape of the player's mistakes, which is the product's own idea drawn as a
 * picture and the only thing here that rewards a glance, and narrows from
 * there into a single square and a single action.
 *
 * ## What the standing line used to say
 *
 * It carried a rating, a lifetime game count and a W/L/D record, all from the
 * prototype API, all counted over tables the analysis pipeline no longer
 * writes. `/v1` publishes none of the three. The line is now a stated absence
 * rather than a figure nobody can vouch for, and it sits under the heading so
 * the page still opens on its conclusion rather than on an apology.
 */

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export interface LeadTask {
  label: string;
  family: string;
  color: "white" | "black";
  variation: string | null;
  moveNo: number;
  mistakes: number;
  moves: number;
  maxMove: number;
  nodeKeys: string[];
}

/**
 * The one line worth opening on, resolved from the sheet's own marker so Today
 * and the openings page can never nominate different lines.
 */
export function leadTask(sheet: TearSheet): LeadTask | null {
  const marker = sheet.marker;
  if (!marker) return null;
  for (const section of sheet.sections) {
    const row: SheetRow | undefined = section.rows.find((r) => r.key === marker.rowKey);
    if (!row) continue;
    const variation = marker.variationKey
      ? row.variations.find((v) => v.key === marker.variationKey) ?? null
      : null;
    const cell: SheetCell | undefined = (variation ?? row).cells[marker.moveNo - 1];
    if (!cell || cell.decisions === 0) return null;
    return {
      label: row.label,
      family: row.family,
      color: section.color,
      variation: variation?.label ?? null,
      moveNo: cell.moveNo,
      mistakes: cell.failures,
      moves: cell.decisions,
      maxMove: sheet.maxMove,
      nodeKeys: cell.nodeKeys,
    };
  }
  return null;
}

export interface TodayProps {
  shape: OpeningShape;
  lead: LeadTask | null;
  /** Why there is no opening graph at all, when there is none. */
  empty: ExplorerEmptyReason | null;
  /** Games behind the opening graph, both colours. */
  games: number;
  /** Of those, the ones no analysis has reached yet. */
  unanalysed: number;
  /** The newest game `/v1/games/recent` knows about, or null. */
  lastGame: RecentGame | null;
  /** Where the examination stands, or null when the run could not be read. */
  run: Destination | null;
}

export function Today({ shape, lead, empty, games, unanalysed, lastGame, run }: TodayProps) {
  return (
    <div className="relative z-10 min-h-dvh">
      <a className="skip-link" href="#today-main">Skip to content</a>
      <TopNav current="home" />
      <main id="today-main" className="today">
        <Shape shape={shape} empty={empty} games={games} />
        <Standing />
        {lead ? <Lead task={lead} /> : <NoLead games={games} unanalysed={unanalysed} />}
        <Next lastGame={lastGame} run={run} />
      </main>
    </div>
  );
}

/**
 * Orientation: how am I doing. Forma cannot answer it yet, and says so.
 *
 * The three facts that stood here — a rating with its direction, a lifetime
 * game count and a W/L/D record — all came from one prototype endpoint reading
 * tables that stopped being written. There is no rating anywhere on `/v1`, no
 * lifetime record, and no analysed-game or blunder count. Filling the line
 * from the old source would be the most-read lie on the site, and leaving the
 * line out entirely would make the absence look like a design choice.
 */
function Standing() {
  return (
    <EmptyState
      title="No rating or record here yet"
      detail="Forma does not publish your rating, your lifetime win, loss and draw record, or how many of your games it has analysed. The figures that used to stand here were counted somewhere nothing can vouch for, so the line is empty until there is something true to put in it."
    />
  );
}

/**
 * The shape. This is the page.
 *
 * Bars rather than the openings page's squares, because this is a count per
 * move and a count is a height. The squares there encode a *rate* on one line;
 * these encode *how many* across every line, and drawing two different
 * measures with the same mark would be the real inconsistency.
 */
function Shape({
  shape,
  empty,
  games,
}: {
  shape: OpeningShape;
  empty: ExplorerEmptyReason | null;
  games: number;
}) {
  /**
   * No graph and no mistakes are different pages.
   *
   * "No opening mistakes found in your games yet" was printed for both, and
   * for a third case underneath them: games synced whose positions have not
   * been built yet. That last one resolves on its own, and telling somebody
   * their play is clean while the work is still running is the exact failure
   * this product exists not to commit. `explorerEmptyCopy` already separates
   * the three, so this asks it rather than writing a fourth sentence.
   */
  if (empty) {
    const copy = explorerEmptyCopy(empty, games);
    return (
      <section className="today-shape is-empty" aria-labelledby="today-shape-head">
        <h1 id="today-shape-head">{copy.title}</h1>
        <p>{copy.detail}</p>
      </section>
    );
  }

  if (shape.total === 0) {
    return (
      <section className="today-shape is-empty" aria-labelledby="today-shape-head">
        <h1 id="today-shape-head">No opening mistakes found in your games yet.</h1>
        <p>
          Forma read the openings of {games} {plural(games, "game", "games")} and every
          move it could grade held. Play more and the picture will fill in.
        </p>
      </section>
    );
  }

  const tallest = shape.bars.reduce((max, bar) => Math.max(max, bar.mistakes), 0);
  const peak = shape.peak;
  const share = peak ? Math.round((peak.mistakes / shape.total) * 100) : 0;

  return (
    <section className="today-shape" aria-labelledby="today-shape-head">
      <h1 id="today-shape-head">
        {peak ? (
          <>
            {share}% of your opening mistakes land between moves {peak.from} and{" "}
            {peak.to}.
          </>
        ) : (
          <>{shape.total} opening mistakes across your games.</>
        )}
      </h1>

      <figure className="shape-chart">
        <div className="shape-bars">
          {shape.bars.map((bar) => {
            const inPeak = peak != null && bar.moveNo >= peak.from && bar.moveNo <= peak.to;
            return (
              <div
                key={bar.moveNo}
                className={`shape-bar ${inPeak ? "is-peak" : ""}`}
                title={`Move ${bar.moveNo}: ${bar.mistakes} ${plural(bar.mistakes, "mistake", "mistakes")} in ${bar.moves} ${plural(bar.moves, "move", "moves")}`}
              >
                <span
                  className="shape-fill"
                  style={{ height: tallest ? `${(bar.mistakes / tallest) * 100}%` : "0%" }}
                />
                <span className="shape-tick">{bar.moveNo}</span>
              </div>
            );
          })}
        </div>
        {/* The threshold is stated because it changed with the source. The
            prototype graph counted a mistake at 90 centipawns; the canonical
            one counts a move outside the engine's stated tolerance, which is
            0.02 of expected score against the best line the same search found.
            Two different rules wearing the same word is exactly the kind of
            quiet reclassification the tolerance is versioned to prevent, and
            /openings still reads the old graph and still says 90cp. */}
        <figcaption>
          Your own move number. {shape.total} mistakes in total, counted where the
          move played cost more than 0.02 of expected score against the engine's
          best line in the same search.
        </figcaption>
      </figure>
    </section>
  );
}

/** The one square worth starting from, with the position it actually happens in. */
function Lead({ task }: { task: LeadTask }) {
  const where = task.variation ? `${task.label}, ${task.variation}` : task.label;
  const board = task.nodeKeys.find(
    (key) => (key.split(" ")[0] ?? "").split("/").length === 8,
  );

  return (
    <section className="today-lead" aria-labelledby="today-lead-head">
      <div className="today-lead-copy">
        <p className="cap">Start here</p>
        <h2 id="today-lead-head">
          Move {task.moveNo} of your {where}.
        </h2>
        <p>
          {task.mistakes} of the {task.moves} {plural(task.moves, "move", "moves")} you
          have played in that position {plural(task.mistakes, "was a mistake", "were mistakes")}.
          Nothing else in your repertoire has cost you more.
        </p>
        <Link
          to={`/train?color=${task.color}&family=${encodeURIComponent(task.family)}`}
          className="primary-button btn-lg today-go"
        >
          Practice
        </Link>
      </div>

      {board ? (
        <figure className="today-board">
          <Board fen={`${board} 0 1`} size={260} flip={task.color === "black"} />
          <figcaption>
            The position, with {task.color} to move.
          </figcaption>
        </figure>
      ) : null}
    </section>
  );
}

/**
 * No marker: either there are not enough games to name a worst line, or the
 * repertoire genuinely has no square bad enough to qualify. Those are different
 * facts and the page says which.
 *
 * The "import N more games" button that used to live here is gone. It posted
 * to the prototype importer, and `/v1` has no import: games arrive with an
 * examination run, which /welcome and /onboarding start. Offering the button
 * would be offering a control that writes to the half of the database this
 * page has stopped reading.
 */
function NoLead({ games, unanalysed }: { games: number; unanalysed: number }) {
  const thin = games < 20;

  return (
    <section className="today-lead" aria-labelledby="today-lead-head">
      <div className="today-lead-copy">
        <p className="cap">Start here</p>
        <h2 id="today-lead-head">
          {thin
            ? "Not enough games to name a worst line yet."
            : "No line is going wrong often enough to name."}
        </h2>
        <p>
          {thin
            ? `Forma has read the openings of ${games} ${plural(games, "game", "games")}. Opening patterns need about twenty before a worst line means anything.`
            : "Every line you play holds within tolerance. Practise the repertoire you have."}
          {unanalysed > 0
            ? ` ${unanalysed} of them ${plural(unanalysed, "has", "have")} not been analysed yet, so the sample will widen on its own.`
            : ""}
        </p>
        <Link to="/openings" className="primary-button btn-lg today-go">
          Open your lines
        </Link>
      </div>
    </section>
  );
}

interface NextItem {
  key: string;
  title: string;
  fact: string;
  cta: string;
  /** A route in this app. */
  to?: string;
  /** Somewhere off Forma. Never both. */
  href?: string;
}

/** The examination, as a row. `done` and `welcome` produce nothing. */
function runItem(run: Destination): NextItem | null {
  switch (run.kind) {
    case "report":
      return {
        key: "report",
        title: "Your baseline report is ready",
        fact: "Forma has finished reading your games and written up what it found",
        to: "/report",
        cta: "Read it",
      };
    case "wait":
      return {
        key: "run",
        title: "Forma is reading your games",
        fact: run.reason,
        to: "/onboarding",
        cta: "Watch",
      };
    case "stuck":
      return {
        key: "run",
        title: "The examination stopped",
        fact: run.workflowFailed
          ? "The sync failed partway through"
          : "It cannot go any further on its own",
        to: "/onboarding",
        cta: "See why",
      };
    case "diagnostic":
      return {
        key: "run",
        title: "The examination is waiting on a diagnostic",
        fact: "Nothing runs until this is settled",
        to: "/onboarding",
        cta: "Open",
      };
    // `welcome` cannot happen behind `requireSession`, and `done` is the
    // ordinary state of anybody who finished. Neither is worth a row.
    case "welcome":
    case "done":
      return null;
  }
}

/**
 * Two or three rows, then the page stops.
 *
 * Every row is a real destination with a measured reason to go there. A row
 * that cannot state its reason does not render, which is why this list is
 * short and why its length changes between players. It is also why a failed
 * `/v1/onboarding` read produces no row rather than a placeholder: "we could
 * not check" is not a reason to go anywhere.
 *
 * The blunder-drilling row is gone with the counts it stated. It needed the
 * analysed-game and blunder totals from the prototype `/me`, and `/v1` has
 * neither; /mistakes is still reachable from the nav, and a row claiming a
 * number it cannot count would be worse than no row.
 */
function Next({ lastGame, run }: { lastGame: RecentGame | null; run: Destination | null }) {
  const items: NextItem[] = [];

  const fromRun = run ? runItem(run) : null;
  if (fromRun) items.push(fromRun);

  if (lastGame) {
    // `outcome` is the subject's own result. `result` names the winning colour,
    // and reading that one here would tell half the readers they had won a game
    // they lost.
    const outcome =
      lastGame.outcome === "win"
        ? "Won"
        : lastGame.outcome === "loss"
          ? "Lost"
          : lastGame.outcome === "draw"
            ? "Drew"
            : "Played";
    const when = relTimeIso(lastGame.playedAt);
    const against = lastGame.opponent ? ` against ${lastGame.opponent}` : "";
    items.push({
      key: "last-game",
      title: "Your last game",
      fact: `${outcome}${against}${when ? `, ${when}` : ""}`,
      // The board review this used to link to reads the prototype's game ids,
      // and these are the canonical ones. Until a `/v1` review screen exists
      // the honest destination is the game where it was played.
      href: lastGame.providerUrl ?? undefined,
      cta: "Open",
    });
  }

  if (!items.length) return null;

  return (
    <section className="today-next" aria-label="Then">
      <p className="cap">Then</p>
      <ul>
        {items.map((item) => (
          <li key={item.key} className="today-row">
            <span className="today-row-copy">
              <strong>{item.title}</strong>
              <small>{item.fact}</small>
            </span>
            {item.to ? (
              <Link to={item.to} className="today-row-go">
                {item.cta}
              </Link>
            ) : item.href ? (
              <a
                href={item.href}
                className="today-row-go"
                target="_blank"
                rel="noreferrer"
              >
                {item.cta}
              </a>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
