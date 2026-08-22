import { Link } from "react-router";
import { Board } from "./Board";
import { TopNav } from "./TopNav";
import { Trajectory } from "./Trajectory";
import { relTimeIso } from "../lib/format";
import type { OpeningShape } from "../lib/todayShape";
import type { SheetCell, SheetRow, TearSheet } from "../lib/tearSheet";
import type { RecentGame } from "../lib/v1/games";
import type { ExplorerEmptyReason } from "../lib/v1/openings";
import { explorerEmptyCopy } from "../lib/v1/openings";
import type { TodayReport } from "../lib/v1/dashboard";
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
 * halves: how am I doing, and what should I fix. The page answers the first
 * with the report's own conclusion and narrows from there into a single square
 * and a single action.
 *
 * ## What opens the page, and why it changed
 *
 * It used to open on the shape of the player's opening mistakes — a bar chart
 * of which move numbers they fall on — above a stated absence where a rating
 * and a record belonged. Both of those were forced by the same gap: `/v1` had
 * no endpoint that returned a measurement, so the strongest thing the page
 * could say was a count of one kind of mistake, and the honest thing it had to
 * say about everything else was "we do not publish that".
 *
 * `/v1/dashboard` closed the gap. The page now opens on what the published
 * report concludes — where the games are actually decided, in the trajectory's
 * own words — with the graph itself under the heading, Forma's top finding
 * beside it, and a link that states what the report holds.
 *
 * The mistake shape is not drawn here any more. "34% of your opening mistakes
 * land between moves 5 and 7" is a real measurement and a small one: it is a
 * detail of one phase of the game, not an answer to how somebody's chess is
 * going, and it spent too long wearing the largest type on the product.
 * `/openings` is where a detail of the opening belongs, and it is still there.
 *
 * With nothing published the shape takes the page back, because its empty
 * states are the right thing to say to somebody whose games have not been read
 * yet, and a page still has to open on something it means.
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
  /** What the published report says, or null when nothing is published. */
  report: TodayReport | null;
}

export function Today({ shape, lead, empty, games, unanalysed, lastGame, run, report }: TodayProps) {
  return (
    <div className="relative z-10 min-h-dvh">
      <a className="skip-link" href="#today-main">Skip to content</a>
      <TopNav current="home" />
      <main id="today-main" className="today">
        {report ? <Verdict report={report} /> : <Shape shape={shape} empty={empty} games={games} />}
        {lead ? <Lead task={lead} /> : <NoLead games={games} unanalysed={unanalysed} />}
        <Next lastGame={lastGame} run={run} />
      </main>
    </div>
  );
}

/**
 * What the report says, and a reason to go and read the rest of it.
 *
 * This is the page's answer to "how am I doing". The three facts that stood
 * here before — a rating, a lifetime record, an analysed-game count — came from
 * a prototype endpoint reading tables the pipeline stopped writing, so the line
 * became a stated absence. `/v1/dashboard` publishes all three from the
 * publication itself, and the absence is over.
 *
 * The link is not a nav item called "Report". It says what is inside, counted
 * from what came back, because a reader who has already seen the conclusion
 * needs to know what the second page adds before they will press it.
 */
function Verdict({ report }: { report: TodayReport }) {
  const { measured, conclusions, games, rating } = report;
  const inside = [
    `${measured} measured ${plural(measured, "area", "areas")}`,
    conclusions > 0 ? `${conclusions} ${plural(conclusions, "conclusion", "conclusions")}` : null,
    `your trajectory across ${games.toLocaleString()} ${plural(games, "game", "games")}`,
  ].filter((entry): entry is string => entry !== null);

  return (
    <section className="today-verdict" aria-labelledby="today-verdict-head">
      <h1 id="today-verdict-head">{report.headline}</h1>
      <p className="today-verdict-standing">
        {rating ? (
          <>
            <span className="figure">{rating.rating.toLocaleString()}</span> {rating.speed} on{" "}
            {rating.provider}
            {" · "}
          </>
        ) : null}
        <span className="figure">{games.toLocaleString()}</span>{" "}
        {plural(games, "game", "games")} read
      </p>

      {report.cone ? <Trajectory cone={report.cone} /> : null}

      {/* Forma's own sentence, printed verbatim or not at all. There is no
          endpoint that turns a finding id into prose, so a slot with nothing in
          it stays empty rather than being filled from here. */}
      {report.finding ? <p className="today-verdict-finding">{report.finding}</p> : null}
      {report.cone === null && report.detail ? (
        <p className="today-verdict-detail">{report.detail}</p>
      ) : null}

      <Link to="/profile" className="primary-button btn-lg today-go">
        See everything Forma measured
      </Link>
      <p className="today-verdict-inside">
        {inside.join(", ")}. <Link to="/report">The same thing as a printable report</Link>.
      </p>
    </section>
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
