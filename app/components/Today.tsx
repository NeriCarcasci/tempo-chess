import { Link, useFetcher } from "react-router";
import { Board } from "./Board";
import { TopNav } from "./TopNav";
import { relTime } from "../lib/format";
import type { GameLite, Summary } from "../lib/lichess";
import type { PlayerCoverage } from "../lib/openings";
import type { OpeningShape } from "../lib/todayShape";
import type { SheetCell, SheetRow, TearSheet } from "../lib/tearSheet";

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

export function Today({
  summary,
  coverage,
  shape,
  lead,
}: {
  summary: Summary;
  coverage: PlayerCoverage | null;
  shape: OpeningShape;
  lead: LeadTask | null;
}) {
  const missing =
    coverage && !coverage.historyComplete
      ? Math.max(0, coverage.availableGames - coverage.importedGames)
      : 0;

  return (
    <div className="relative z-10 min-h-dvh">
      <a className="skip-link" href="#today-main">Skip to content</a>
      <TopNav current="home" />
      <main id="today-main" className="today">
        <Standing summary={summary} />
        <Shape shape={shape} games={summary.record.all} />
        {lead ? (
          <Lead task={lead} />
        ) : (
          <NoLead games={summary.record.all} missing={missing} username={summary.username} />
        )}
        <Next
          lead={lead}
          blunders={summary.analyzed.blunders}
          analysed={summary.analyzed.count}
          lastGame={summary.recent[0] ?? null}
          missing={missing}
          username={summary.username}
        />
      </main>
    </div>
  );
}

/**
 * Orientation, in one line: who this is and how it is going.
 *
 * Not a row of stat tiles. Three facts a player checks in a second, set in the
 * numeral face, with the rating carrying its own direction so it says whether
 * things are improving rather than only where they stand.
 */
function Standing({ summary }: { summary: Summary }) {
  const best = summary.bestFormat;
  /**
   * The format's own progression, not a subtraction over `summary.trend`.
   *
   * `bestFormat` is the highest-rated *established* format and `trend` is the
   * most-*played* speed, so differencing that series and printing it beside
   * this rating labelled the swing of one format with the name of another. It
   * read "1587 classical, down 894", which is not a thing that happened.
   */
  const delta = best?.prog ?? 0;
  const record = summary.record;

  return (
    <p className="today-standing">
      {best ? (
        <span>
          <b>{best.rating}</b> {best.label.toLowerCase()}
          {delta !== 0 ? (
            <i data-dir={delta > 0 ? "up" : "down"}>
              {delta > 0 ? "▲" : "▼"}
              {Math.abs(delta)}
            </i>
          ) : null}
        </span>
      ) : null}
      <span>
        <b>{record.all}</b> {plural(record.all, "game", "games")} read
      </span>
      <span>
        <b>{record.win}</b>W <b>{record.loss}</b>L <b>{record.draw}</b>D
      </span>
    </p>
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
function Shape({ shape, games }: { shape: OpeningShape; games: number }) {
  if (shape.total === 0) {
    return (
      <section className="today-shape is-empty" aria-labelledby="today-shape-head">
        <h1 id="today-shape-head">
          {games === 0
            ? "No games read yet."
            : "No opening mistakes found in your games yet."}
        </h1>
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
        <figcaption>
          Your own move number. {shape.total} mistakes in total, counted where a
          move outside your book lost 90 centipawns or more.
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
 */
function NoLead({
  games,
  missing,
  username,
}: {
  games: number;
  missing: number;
  username: string;
}) {
  const sync = useFetcher<{ ok: boolean; message: string }>();
  const busy = sync.state !== "idle";
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
            ? `Forma has read ${games} ${plural(games, "game", "games")}. Opening patterns need about twenty before a worst line means anything.`
            : "Every line you play holds within tolerance. Practise the repertoire you have, or import more history to widen the sample."}
        </p>
        {missing > 0 ? (
          <sync.Form method="post">
            <input type="hidden" name="username" value={username} />
            <button className="primary-button btn-lg today-go" disabled={busy}>
              {busy ? "Importing…" : `Import ${missing} more ${plural(missing, "game", "games")}`}
            </button>
            {sync.data ? (
              <span className="sr-only" aria-live="polite">{sync.data.message}</span>
            ) : null}
          </sync.Form>
        ) : (
          <Link to="/openings" className="primary-button btn-lg today-go">
            Open your lines
          </Link>
        )}
      </div>
    </section>
  );
}

interface NextItem {
  key: string;
  title: string;
  fact: string;
  cta: string;
  /** A destination, or an import that runs here. Never both. */
  to?: string;
  action?: "import";
}

/**
 * Two or three rows, then the page stops.
 *
 * Every row is a real destination with a measured reason to go there. A row
 * that cannot state its reason does not render, which is why this list is
 * short and why its length changes between players.
 */
function Next({
  lead,
  blunders,
  analysed,
  lastGame,
  missing,
  username,
}: {
  lead: LeadTask | null;
  blunders: number;
  analysed: number;
  lastGame: GameLite | null;
  missing: number;
  username: string;
}) {
  const items: NextItem[] = [];

  if (blunders > 0 && analysed > 0) {
    items.push({
      key: "mistakes",
      title: "Drill your blunders",
      fact: `${blunders} found across ${analysed} analysed ${plural(analysed, "game", "games")}`,
      to: "/mistakes?color=white",
      cta: "Drill",
    });
  }

  if (lastGame) {
    const outcome =
      lastGame.result === "win" ? "Won" : lastGame.result === "loss" ? "Lost" : "Drew";
    items.push({
      key: "last-game",
      title: "Review your last game",
      fact: `${outcome} against ${lastGame.opponent}, ${relTime(lastGame.createdAt)}`,
      to: `/game/${lastGame.id}`,
      cta: "Review",
    });
  }

  // Only when a lead already took the primary slot; otherwise NoLead offers it.
  if (missing > 0 && lead) {
    items.push({
      key: "import",
      title: "Import the rest of your history",
      fact: `${missing} ${plural(missing, "game", "games")} still missing`,
      action: "import",
      cta: "Import",
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
            {item.action === "import" ? (
              <ImportButton label={item.cta} username={username} />
            ) : (
              <Link to={item.to!} className="today-row-go">
                {item.cta}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The import runs from the row that names it. It was a link to the openings
 * page for one revision, which meant a row titled "Import" handed you a button
 * reading "Open" and then a different page to find the real control on.
 */
function ImportButton({ label, username }: { label: string; username: string }) {
  const sync = useFetcher<{ ok: boolean; message: string }>();
  const busy = sync.state !== "idle";
  return (
    <sync.Form method="post">
      <input type="hidden" name="username" value={username} />
      <button className="today-row-go" disabled={busy}>
        {busy ? "Importing…" : label}
      </button>
      {sync.data ? (
        <span className="sr-only" aria-live="polite">{sync.data.message}</span>
      ) : null}
    </sync.Form>
  );
}
