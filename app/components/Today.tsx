import { useState } from "react";
import { Link } from "react-router";
import { Board } from "./Board";
import { TopNav } from "./TopNav";
import { Trajectory } from "./Trajectory";
import { EmptyState, ClaimBadge } from "./v1/Honesty";
import { relTimeIso } from "../lib/format";
import { MOVEMENT_COPY, unavailableText, type Measure } from "../lib/v1/dashboard";
import type { OpeningShape } from "../lib/todayShape";
import type { SheetCell, SheetRow, TearSheet } from "../lib/tearSheet";
import type { RecentGame } from "../lib/v1/games";
import type { ExplorerEmptyReason } from "../lib/v1/openings";
import { explorerEmptyCopy } from "../lib/v1/openings";
import type { TodayReport } from "../lib/v1/dashboard";
import type { GoalProgress, GoalView } from "../lib/v1/goals";
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
  /** The goal this account is actively working, or null with none set. */
  goal: GoalView | null;
  /** That goal's progress, or null when nothing has been measured on it yet. */
  goalProgress: GoalProgress | null;
}

export function Today({
  shape,
  lead,
  empty,
  games,
  unanalysed,
  lastGame,
  run,
  report,
  goal,
  goalProgress,
}: TodayProps) {
  return (
    <div className="relative z-10 min-h-dvh">
      <a className="skip-link" href="#today-main">Skip to content</a>
      <TopNav current="home" />
      <main id="today-main" className="today">
        {report ? <Verdict report={report} /> : <Shape shape={shape} empty={empty} games={games} />}
        {report && report.measures.length > 0 ? <Stack measures={report.measures} /> : null}
        {lead ? <Lead task={lead} /> : <NoLead games={games} unanalysed={unanalysed} />}
        <Next lastGame={lastGame} run={run} report={report} />
        <Progress goal={goal} progress={goalProgress} />
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
  const { games, rating, publishedAt } = report;
  const when = new Date(publishedAt);
  const dated = Number.isNaN(when.getTime())
    ? null
    : when.toLocaleDateString(undefined, { day: "numeric", month: "long" });

  return (
    <section className="today-verdict" aria-labelledby="today-verdict-head">
      <h1 id="today-verdict-head">{report.headline}</h1>

      {/* The provenance of every figure below, in one line and never as a
          caption at the bottom. A report is a frozen cohort rather than a live
          count: the archive keeps growing after it is published, and a page
          that prints the cohort size with no date invites a reader to check it
          against their real total and conclude the product cannot count. The
          date is what makes the smaller number correct instead of wrong. */}
      <p className="today-verdict-standing">
        {rating ? (
          <>
            <span className="figure">{rating.rating.toLocaleString()}</span> {rating.speed} on{" "}
            {rating.provider}
            {" · "}
          </>
        ) : null}
        measured over <span className="figure">{games.toLocaleString()}</span>{" "}
        {plural(games, "game", "games")}
        {dated ? <>, {dated}</> : null}
      </p>

      {report.cone ? <Trajectory cone={report.cone} /> : null}

      {report.cone === null && report.detail ? (
        <p className="today-verdict-detail">{report.detail}</p>
      ) : null}

      {/* Forma's own strongest sentence, printed verbatim or not at all — and
          only once it reads as English. `readableExplanation` holds back text
          from a report published before the renderer was repaired, which would
          otherwise put a database key in the largest prose on the page. */}
      {report.finding ? <p className="today-verdict-finding">{report.finding}</p> : null}
    </section>
  );
}

/**
 * The seven measures, worst-moving first.
 *
 * ## Why this is a ranked stack and not a row of cards
 *
 * The page this replaced put three equal-width cards under the graph, each with
 * the same heading, the same figure and the same paragraph, and repeated the
 * absence of a per-phase rate three times. Equal weight is the failure: it is
 * the arrangement that says every one of these matters the same amount, on a
 * page whose entire job is to say which one to open tonight. Rank carries that
 * instead, so nothing needs a badge or a colour to announce priority — reading
 * down the stack *is* reading the priority order.
 *
 * The leading row opens with its evidence; the rest hold their rank as one
 * dense line each and open on demand. That is the second half of the refusal: a
 * page showing seven measures at full detail is the stat-dump PRODUCT.md names
 * as an anti-reference, and one showing only the worst is the version that left
 * a reader with no idea how they were doing.
 *
 * ## Why the order is movement and not rate
 *
 * See `measures()`. Rates across different concepts are not comparable and
 * sorting by them would rank the catalogue's difficulty rather than the player.
 */
function Stack({ measures }: { measures: Measure[] }) {
  const [open, setOpen] = useState<string | null>(measures[0]?.baseKey ?? null);

  return (
    <section className="today-stack" aria-labelledby="today-stack-head">
      <h2 id="today-stack-head" className="cap">
        Against your own earlier games
      </h2>
      <ol className="today-rank">
        {measures.map((measure, index) => (
          <MeasureRow
            key={measure.baseKey}
            measure={measure}
            rank={index + 1}
            open={open === measure.baseKey}
            onOpen={() => setOpen(open === measure.baseKey ? null : measure.baseKey)}
          />
        ))}
      </ol>
      <p className="today-stack-key">
        Ordered by how surely each has moved against your earlier games, not by rate: these
        are different jobs, so their rates are not a ranking. A change is called only when
        Forma puts it past its own threshold.
      </p>
    </section>
  );
}

const pct = (value: number): string => `${Math.round(value * 100)}%`;

/**
 * A probability, without letting it round to certainty at either end.
 *
 * The same rule `server/src/estimates/render.ts` applies, and for the same
 * reason in the mirror: a posterior of 0.003 printed as "0%" tells somebody it
 * is impossible their play improved, which no amount of evidence about chess
 * earns. "Under 1%" is the strongest true version of it. The floor is stated
 * rather than derived so the number on screen is one the data supports.
 */
const chance = (value: number): string => {
  // Zero and one are included deliberately. The posterior is stored to five
  // decimal places, so a genuinely small number arrives as 0.00000, and a
  // continuous model cannot produce a true zero in the first place — printing
  // "0%" would turn a rounding artefact into the claim that this player's
  // improvement is impossible.
  if (value < 0.01) return "under 1%";
  if (value > 0.99) return "over 99%";
  return pct(value);
};

/**
 * Percentage points, signed, in the unit the estimator computes them in.
 *
 * A movement that rounds to nothing loses its sign: "+0" is a change being
 * announced and then withdrawn in the same two characters, and the row already
 * says "no clear change" beside it.
 */
const points = (value: number): string => {
  const rounded = Math.round(value * 100);
  if (rounded === 0) return "0";
  return `${rounded > 0 ? "+" : "−"}${Math.abs(rounded)}`;
};

function MeasureRow({
  measure,
  rank,
  open,
  onOpen,
}: {
  measure: Measure;
  rank: number;
  open: boolean;
  onOpen: () => void;
}) {
  const { change } = measure;
  const movement = change ? MOVEMENT_COPY[change.movement] : null;
  const headingId = `measure-${measure.baseKey}`;

  return (
    <li className={`today-rank-row${open ? " is-open" : ""}`}>
      <button
        type="button"
        className="today-rank-head"
        aria-expanded={open}
        aria-controls={`${headingId}-detail`}
        onClick={onOpen}
      >
        <span className="today-rank-no" aria-hidden="true">
          {rank}
        </span>

        <span className="today-rank-name" id={headingId}>
          {measure.name}
          {measure.role ? <small>{measure.role}</small> : null}
        </span>

        {/* The movement is the ranking key, so it is the figure on the row.
            Never a bare arrow: a direction with no certainty behind it is the
            claim this product refuses to make, so the word and the number
            travel together and the colour is only ever a third carrier. */}
        {change && movement ? (
          <span className={`today-rank-move ${movement.tone}`}>
            <b>{points(change.delta)}</b>
            <small>{movement.label}</small>
          </span>
        ) : (
          <span className="today-rank-move is-unclear">
            <small>Not compared yet</small>
          </span>
        )}
      </button>

      <div id={`${headingId}-detail`} className="today-rank-detail" hidden={!open}>
        {measure.rate === null ? (
          <p className="today-rank-none">{unavailableText(measure.unavailableReason)}</p>
        ) : (
          <>
            {/* The standing rate with its interval drawn to scale. A point
                estimate on its own is a stronger claim than the estimator
                made, so the interval is the mark and the point sits inside
                it. */}
            <p className="today-rank-rate">
              You take <b>{pct(measure.rate)}</b> of these, over{" "}
              {measure.sample.toLocaleString()} recorded{" "}
              {plural(measure.sample, "chance", "chances")}.
              {measure.intervalLow !== null && measure.intervalHigh !== null ? (
                <>
                  {" "}
                  The evidence puts the real rate between{" "}
                  <b>{pct(measure.intervalLow)}</b> and <b>{pct(measure.intervalHigh)}</b>.
                </>
              ) : null}
            </p>
            {measure.intervalLow !== null && measure.intervalHigh !== null ? (
              <Interval
                low={measure.intervalLow}
                high={measure.intervalHigh}
                value={measure.rate}
              />
            ) : null}
          </>
        )}

        {change ? (
          <p className="today-rank-change">
            Earlier games <b>{pct(change.from)}</b>, recent games <b>{pct(change.to)}</b>, over{" "}
            {change.sample.toLocaleString()} recent{" "}
            {plural(change.sample, "chance", "chances")}.
            {change.improvementProbability !== null ? (
              <>
                {" "}
                Forma puts the chance this is a real improvement at{" "}
                <b>{chance(change.improvementProbability)}</b>.
              </>
            ) : null}
          </p>
        ) : null}

        {measure.definition ? (
          <p className="today-rank-definition">{measure.definition}</p>
        ) : null}
      </div>
    </li>
  );
}

/**
 * An interval, drawn to the 0–100 scale it is a share of.
 *
 * Deliberately not scaled to the interval's own width: a narrow interval and a
 * wide one would then look identical, which is the one thing this mark exists
 * to distinguish. The full scale is the frame, so a measure Forma knows to
 * within two points reads as tight and one it knows to within twenty reads as
 * the guess it is.
 */
function Interval({ low, high, value }: { low: number; high: number; value: number }) {
  return (
    // The scale is labelled at both ends because without them the mark is a dot
    // at an arbitrary position on an unlabelled rule: a reader cannot tell 84%
    // from 8% without knowing where the track starts and stops. The numbers
    // themselves are in the sentence above; what this adds is the position and
    // the width, which prose carries badly.
    <span className="today-interval-row" aria-hidden="true">
      <span className="today-interval-end">0%</span>
      <span className="today-interval">
        <span
          className="today-interval-band"
          style={{ left: `${low * 100}%`, width: `${Math.max(high - low, 0) * 100}%` }}
        />
        <span className="today-interval-point" style={{ left: `${value * 100}%` }} />
      </span>
      <span className="today-interval-end">100%</span>
    </span>
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
            quiet reclassification the tolerance is versioned to prevent. Both
            surfaces now read the canonical graph — /openings moved onto it with
            the sheet — so the two figures agree, and each still names the rule
            it was counted by. */}
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
function Next({
  lastGame,
  run,
  report,
}: {
  lastGame: RecentGame | null;
  run: Destination | null;
  report: TodayReport | null;
}) {
  const items: NextItem[] = [];

  const fromRun = run ? runItem(run) : null;
  if (fromRun) items.push(fromRun);

  // The full report, as a row with a counted reason rather than a nav item
  // called "Report". It used to be the page's primary button, which spent the
  // one accented control on going to another screen instead of on playing
  // chess; the practice control above it is the action now.
  //
  // The conclusion count is deliberately absent. The findings on the published
  // report are duplicated across two statistical frames, so the honest figure
  // is not the row count, and the measured areas are the thing this page can
  // stand behind.
  if (report && report.measured > 0) {
    items.push({
      key: "report",
      title: "Everything Forma measured",
      fact: `${report.measured} measured ${plural(report.measured, "area", "areas")} across ${report.games.toLocaleString()} ${plural(report.games, "game", "games")}`,
      to: "/profile",
      cta: "Open",
    });
  }

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

/**
 * How this account is doing against the goal it set, from the day it started
 * to now.
 *
 * There is no goal-setting screen yet, so an account that has never set one is
 * the ordinary case, not a failure — the empty state says exactly that rather
 * than a control that has nowhere to go. `/v1/goals` already separates
 * adherence (what was done) from readiness (how close the estimate is to the
 * target) and real-game evidence (the only thing that can complete a goal);
 * this section keeps that apart rather than folding it into one bar, because a
 * client that renders progress from the activity counter is telling the
 * reader that practising is the same as improving.
 */
function Progress({ goal, progress }: { goal: GoalView | null; progress: GoalProgress | null }) {
  if (!goal) {
    return (
      <section className="today-progress" aria-labelledby="today-progress-head">
        <p className="cap" id="today-progress-head">Progress</p>
        <EmptyState
          title="No goal set yet"
          detail="Set a goal and this fills in with how you are doing against it, from the day you set it to now — measured from the games you actually play, not from how much you practised."
        />
      </section>
    );
  }

  if (!progress) {
    return (
      <section className="today-progress" aria-labelledby="today-progress-head">
        <p className="cap" id="today-progress-head">Progress</p>
        <EmptyState
          title={goal.statedObjective}
          detail="Nothing has been measured on this goal yet. That fills in once games are played and analysed against it."
        />
      </section>
    );
  }

  const { metrics, adherence, realGameEvidence } = progress;

  return (
    <section className="today-progress" aria-labelledby="today-progress-head">
      <p className="cap" id="today-progress-head">Progress</p>
      <div className="today-progress-card">
        <h2>{goal.statedObjective}</h2>

        {metrics.length > 0 ? (
          <ul className="today-progress-metrics">
            {metrics.map((metric) => (
              <li key={metric.metricKey}>
                <ClaimBadge state={metric.claimState} />
                <span className="today-progress-metric-key">{metric.metricKey}</span>
                {metric.readiness !== null ? (
                  <span className="today-progress-readiness">
                    {Math.round(metric.readiness * 100)}% of the way there
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}

        <p className="today-progress-note">
          {realGameEvidence} {plural(realGameEvidence, "real game has", "real games have")}{" "}
          counted as evidence toward this. {adherence.note}
        </p>
      </div>
    </section>
  );
}
