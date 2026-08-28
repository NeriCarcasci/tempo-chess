import { Link } from "react-router";
import { Board } from "./Board";
import { FigureNote } from "./FigureNote";
import { ExaminationBar } from "./onboarding/ExaminationBar";
import { PhaseRow } from "./phases";
import { MarkChart, MarkClock, MarkEye } from "./marks";
import { MarkDrill as MarkTarget } from "./pathMarks";
import { TopNav } from "./TopNav";
import { EmptyState } from "./v1/Honesty";
import { relTimeIso } from "../lib/format";
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
  /** The run's own stage, for the bar. Null when there is no run to read. */
  runStage?: string | null;
  /** What the published report says, or null when nothing is published. */
  report: TodayReport | null;
  /** What is due in the practice queue, or null when it could not be read. */
  queue: { due: number; overdue: number } | null;
  /** The goal this account is actively working, or null with none set. */
  goal: GoalView | null;
  /** That goal's progress, or null when nothing has been measured on it yet. */
  goalProgress: GoalProgress | null;
  /** Re-read the page's data. Called when the examination finishes under it. */
  onSettled?: () => void;
}

/**
 * The hub, while the first examination is still running.
 *
 * A person now lands here the moment they press "Read my games", minutes before
 * anything can be measured about them. The alternative was to hold them on a
 * progress screen until the report existed, and that is the version that loses
 * people: a wait with no product behind it reads as a product that is not
 * there.
 *
 * So the page opens, with a bar across the top saying how far the read has got,
 * and the panels that have nothing to say yet drawn as the shape of what is
 * coming. Two rules keep that from becoming a lie:
 *
 *   * **A pending panel says what will be in it and never guesses.** No greyed
 *     figure, no placeholder rating, nothing that could be mistaken for a
 *     measurement that came out low.
 *   * **Real beats pending, always.** The opening graph exists before the
 *     report does, so as soon as there are mistakes to draw, the real section
 *     replaces its own skeleton. Nothing is held back to keep the page tidy.
 */
export function Today({
  shape,
  lead,
  empty,
  games,
  unanalysed,
  lastGame,
  run,
  runStage,
  report,
  queue,
  goal,
  goalProgress,
  onSettled,
}: TodayProps) {
  // `wait` is the one destination that means work is running now. `stuck` and
  // `diagnostic` are stopped states, and drawing a progress bar over either
  // would be telling somebody to hold on for something that is not coming.
  const examining = run?.kind === "wait";

  return (
    <div className="relative z-10 min-h-dvh">
      <a className="skip-link" href="#today-main">Skip to content</a>
      <TopNav current="home" />
      {examining ? (
        <ExaminationBar runStage={runStage ?? "syncing"} onSettled={onSettled} />
      ) : null}
      <main id="today-main" className="today">
        {/* The report's own conclusion, visible.
            It was `sr-only` on the argument that the three dials under it say
            the same thing in colour - which stopped being true the moment a
            young account met three grey dials, and left the page opening on
            three circles with no words at all. It is a real sentence the
            report published and it is the answer to the first of the two
            questions this page exists to answer, so it leads. Modest type:
            the dials are still the picture. */}
        {report ? <h1 className="today-headline">{report.headline}</h1> : null}

        {/* The rating is not inside `Phases` any more. It used to be, so a
            published report whose phase estimates were unpublished rendered
            nothing at all above the action - and dropped a figure the API had
            published along with it. `PhaseRow` already returns null on empty
            readings, so the guard bought nothing and cost the rating. */}
        {report?.rating ? <Rating rating={report.rating} /> : null}

        {report && report.readings.length > 0 ? (
          <Phases report={report} />
        ) : report ? null : examining && shape.total === 0 ? (
          // A published report with no trajectory has no phase reading to
          // give, and the opening-mistake bars are not allowed to take the
          // page in its place: that is the hero this product removed twice.
          <PendingVerdict />
        ) : (
          <Shape shape={shape} empty={empty} games={games} />
        )}

        {/* One thing to do, and the page's only accented control. Everything
            else here is a dial, a card, or a link. */}
        {/* Real beats pending, always - this file's own rule, forty lines up,
            which the phase branch honours and this one did not. A returning
            player with a full report and a due queue who starts a re-sync was
            shown a skeleton saying "the position costing you the most will
            stand here" while the position was sitting in `lead`. */}
        {/* No single accented action card here any more.

            It was a large box saying "10 positions ready", and it was the last
            thing on the hub still trying to be the decision: the path is the
            decision now, and the three rings above are the way into it. A box
            competing with them for the same job read as a second, louder
            answer to a question they had already answered. Whatever is worth
            doing besides walking the path is in the deck below, at the deck's
            own size. */}

        {/* "What moved" used to stand here: three cards, each a measure whose
            posterior had crossed a threshold, with two rates and a sample.
            It was the weakest block on the product. Every card was a verdict
            with nowhere to go, and on an account whose three most certain
            movements are all declines it opened the morning on three red
            chips saying 89% became 80%. A measurement is not motivating
            without the work attached to it.

            Movement did not disappear: it is the stage on the deck it
            belongs to on `/path`, beside the evidence and the drills for
            that exact pattern. The full ranked list is on `/profile`, which
            is the page somebody opens to read every measure. */}
        <Deck
          lastGame={lastGame}
          run={examining ? null : run}
          report={report}
          queue={queue}
        />
        <Progress goal={goal} progress={goalProgress} />
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pending: the shape of an answer that is still being worked out
// ---------------------------------------------------------------------------

/**
 * A block of ghosted lines, shaped like the type it stands in for.
 *
 * Widths are handed in rather than random so two renders of the same panel are
 * identical: a skeleton that reshuffles on every poll is motion with no job,
 * which DESIGN.md refuses, and it also reads as content arriving when nothing
 * has.
 */
function Ghost({ lines }: { lines: readonly string[] }) {
  return (
    <span className="ghost" aria-hidden="true">
      {lines.map((width, index) => (
        <span key={index} className="ghost-line" style={{ width }} />
      ))}
    </span>
  );
}

/** Where the verdict will be. */
function PendingVerdict() {
  return (
    <section className="today-verdict is-pending" aria-labelledby="today-verdict-head" aria-busy="true">
      <h1 id="today-verdict-head">Working out where your games are decided</h1>
      <Ghost lines={["82%", "64%"]} />
      <p className="today-verdict-detail">
        This is where Forma will state its conclusion: the phase your games turn
        in, measured against your own earlier ones, with the evidence behind it
        named. It needs the whole read before it can say anything honest.
      </p>
    </section>
  );
}

/**
 * The three phases, and nothing above them.
 *
 * The hub used to open on a headline sentence over an evaluation graph. Both
 * are gone. The graph drew one line across the whole game and the nodes under
 * it drew three states, and a reader had to reconcile them; the sentence over
 * the top was a third telling of the same thing. The nodes *are* the reading
 * now, and the figures behind them arrive on hover rather than standing in a
 * column of small type nobody scans.
 *
 * ## Why the three are measured differently
 *
 * Because the three phases are different jobs, and the same number cannot
 * score them. This is the mistake the pooled hit rate made — it ranked this
 * account 59 / 76 / 86 with the opening worst, while the games were being
 * lost in the middlegame — and it is not fixed by choosing a better single
 * number. It is fixed by asking each phase its own question:
 *
 *   * **The opening is preparation.** Its failure is a line that leaks, and
 *     the tell is not the median (which sits at level all the way through)
 *     but the spread: the middle half of the games opens from 4 points to 88
 *     before move twelve. Some games are already lost and some are fine,
 *     which is what an unreliable repertoire looks like.
 *   * **The middlegame is holding the thread.** Its failure is measured in
 *     ground: the median falls from level to nothing across it.
 *   * **The endgame is conversion, and it has to be asked conditionally.**
 *     A quarter of these games reach one and the median arrives at zero, so
 *     "ground given up" is vacuous there: there is nothing left to give. The
 *     question that survives is what happened to the endgames that *were*
 *     winnable, which `winning_conversion` counts directly.
 */
/**
 * The hub does not draw the trajectory graph.
 *
 * It did, for one revision, with the phase rings rendered as the graph's own
 * legend - and the two instruments disagreed on sight. The line reads the
 * median evaluation, which collapses in the middlegame; the rings count key
 * moments handled, where the middlegame scores highest because its moments
 * are a different mix. Both are true and the page needed a footnote to hold
 * them apart, which is a hero arguing with itself. The graph's conclusion
 * survives as the headline sentence, which is the part a reader actually
 * takes away; the picture itself lives on `/profile` and `/report`, where
 * reading the evidence behind a sentence is the point.
 */
function Phases({ report }: { report: TodayReport }) {
  const when = new Date(report.publishedAt);
  const dated = Number.isNaN(when.getTime())
    ? null
    : when.toLocaleDateString(undefined, { day: "numeric", month: "long" });

  return (
    <PhaseRow
      readings={report.readings}
      provenance={`Measured over ${report.games.toLocaleString()} ${plural(report.games, "game", "games")}${dated ? `, published ${dated}` : ""}.`}
    />
  );
}

/**
 * The rating, as one figure and nothing else.
 *
 * The first thing any chess player looks for, and Forma publishes it, so
 * withholding it to keep the page tidy would be hiding the number somebody
 * came for. It sits outside `Phases` because it is published independently of
 * them: drawn inside, a report whose phase estimates were unpublished lost the
 * rating too.
 *
 * Not a graph, because there is no history to graph. The dashboard publishes
 * one current rating per pool and `/v1/games/recent` carries only the
 * opponent's, so a line here would be a shape drawn over data that does not
 * exist.
 */
function Rating({ rating }: { rating: NonNullable<TodayReport["rating"]> }) {
  return (
    <p className="today-rating">
      <b className="metric">{rating.rating.toLocaleString()}</b>
      <span>
        {speedLabel(rating.speed)} on {providerLabel(rating.provider)}
      </span>
    </p>
  );
}

/**
 * Provider and speed, as words.
 *
 * `QuotedRating` carries the wire's own keys, and the hub printed them raw:
 * "blitz on chesscom", while every other surface in the product writes
 * "Chess.com". A database key must never reach a customer.
 */
const PROVIDER_LABEL: Record<string, string> = {
  lichess: "Lichess",
  chesscom: "Chess.com",
};
const SPEED_LABEL: Record<string, string> = {
  bullet: "Bullet",
  blitz: "Blitz",
  rapid: "Rapid",
  classical: "Classical",
  correspondence: "Correspondence",
};
/** Falls back to the key rather than inventing one, and never to a blank. */
const providerLabel = (key: string): string => PROVIDER_LABEL[key] ?? key;
const speedLabel = (key: string): string => SPEED_LABEL[key] ?? key;

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
          move it could grade held.
        </p>
      </section>
    );
  }

  /**
   * There are mistakes but no published report, so there are no dials to draw.
   *
   * What used to fill this slot was a bar chart of which move numbers the
   * player's opening mistakes fall on, under a heading like "34% of your
   * opening mistakes land between moves 5 and 7". That is a real measurement
   * and a very small one — a detail of one phase, wearing the largest type on
   * the product — and this file has now removed it from the hero twice for
   * exactly that reason. It is still on `/openings`, drawn properly, where a
   * detail of the opening belongs.
   */
  return (
    <section className="today-shape is-empty" aria-labelledby="today-shape-head">
      <h1 id="today-shape-head">
        {shape.total.toLocaleString()} opening{" "}
        {plural(shape.total, "mistake", "mistakes")} so far.
      </h1>
      <p>Forma is still working out what they add up to.</p>
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
 * The deck: everything else worth doing, as cards rather than rows.
 *
 * Each card is a real destination with a counted reason and a mark of its
 * own, so the eye can tell them apart before reading any of them. A card
 * that cannot state its reason does not render, which is why the deck is
 * short and why its length changes between players.
 *
 * The rows this replaced were the page's fourth identical full-width strip:
 * same height, same left-aligned title over a grey line, same pill on the
 * right, four times. A grid of marked cards says the same things and does
 * not read as a list to skim past.
 */
interface DeckItem {
  key: string;
  /** Its mark. Never decoration: one mark per destination, always the same. */
  mark: React.ReactNode;
  title: string;
  fact: string;
  /** The counted figure, when there is one worth putting on the card. */
  badge?: string;
  to?: string;
  href?: string;
  /** A card that states a fact but has nowhere to send anybody. */
  inert?: boolean;
}

function Deck({
  lastGame,
  run,
  report,
  queue,
}: {
  lastGame: RecentGame | null;
  run: Destination | null;
  report: TodayReport | null;
  queue: { due: number; overdue: number } | null;
}) {
  const items: DeckItem[] = [];

  const fromRun = run ? runItem(run) : null;
  if (fromRun) {
    items.push({
      key: `run:${fromRun.key}`,
      mark: <MarkClock />,
      title: fromRun.title,
      fact: fromRun.fact,
      to: fromRun.to,
      href: fromRun.href,
    });
  }

  // The queue, at the deck's size rather than as the page's one big box. It
  // is a real destination with a counted reason, which is the only test a
  // deck card has to pass.
  if (queue && queue.due > 0) {
    items.push({
      key: "practice",
      mark: <MarkTarget />,
      title: `${queue.due} ${plural(queue.due, "position", "positions")} ready`,
      fact:
        queue.overdue > 0
          ? `Your own mistakes, back for a second look. ${queue.overdue} overdue`
          : "Your own mistakes, back for a second look",
      to: "/practice",
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
    items.push({
      key: "last-game",
      mark: <MarkEye />,
      title: "Your last game",
      fact: `${outcome}${lastGame.opponent ? ` against ${lastGame.opponent}` : ""}${when ? `, ${when}` : ""}`,
      // Only when there is somewhere to go. `providerUrl` is nullable, and
      // without this the render fell through to `to={item.to ?? "/today"}` and
      // the card became a link to the page the reader is already on.
      href: lastGame.providerUrl ?? undefined,
      inert: lastGame.providerUrl === null,
    });
  }

  if (report && report.measured > 0) {
    items.push({
      key: "report",
      mark: <MarkChart />,
      title: "Every measurement",
      fact: `Over ${report.games.toLocaleString()} ${plural(report.games, "game", "games")}`,
      badge: `${report.measured} ${plural(report.measured, "area", "areas")}`,
      to: "/profile",
    });
  }

  if (!items.length) return null;

  return (
    <section className="today-deck" aria-label="Then">
      <h2 className="section-head">Then</h2>
      <div className="deck-grid">
        {items.map((item) => {
          const body = (
            <>
              <span className="deck-mark" aria-hidden="true">
                {item.mark}
              </span>
              <span className="deck-copy">
                <strong>{item.title}</strong>
                <small>{item.fact}</small>
              </span>
              {item.badge ? <span className="deck-badge metric">{item.badge}</span> : null}
            </>
          );
          if (item.inert) {
            return (
              <div key={item.key} className="deck-card is-inert">
                {body}
              </div>
            );
          }
          return item.href ? (
            <a
              key={item.key}
              href={item.href}
              className="deck-card"
              target="_blank"
              rel="noreferrer"
            >
              {body}
            </a>
          ) : item.to ? (
            <Link key={item.key} to={item.to} className="deck-card">
              {body}
            </Link>
          ) : (
            <div key={item.key} className="deck-card is-inert">
              {body}
            </div>
          );
        })}
      </div>
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
        <h2 className="section-head" id="today-progress-head">Progress</h2>
        <EmptyState
          title="No goal set yet"
          detail="Measured from the games you play, not from how much you practise."
        />
      </section>
    );
  }

  if (!progress) {
    return (
      <section className="today-progress" aria-labelledby="today-progress-head">
        <h2 className="section-head" id="today-progress-head">Progress</h2>
        <EmptyState
          title={goal.statedObjective}
          detail="Nothing measured on it yet. That fills in as you play."
        />
      </section>
    );
  }

  const { metrics, realGameEvidence } = progress;

  return (
    <section className="today-progress" aria-labelledby="today-progress-head">
      <h2 className="section-head" id="today-progress-head">Progress</h2>
      <div className="today-progress-card">
        <h2>{goal.statedObjective}</h2>

        {/* A count of published facts, not a rollup. `/v1/goals` returns each
            metric under a database key and no display name, so the rows this
            replaced printed a slug per line — or, with the slug removed, an
            anonymous percentage that told a reader nothing at all. How many of
            the goal's targets are met is the one thing that can be said here
            without naming a metric, and it is also the thing somebody actually
            wants to know. */}
        {metrics.length > 0 ? (
          <p className="today-progress-targets">
            <b className="metric">
              {metrics.filter((metric) => metric.targetAchieved).length}/{metrics.length}
            </b>{" "}
            {plural(metrics.length, "target met", "targets met")}
          </p>
        ) : null}

        <p className="today-progress-note">
          <b className="metric">{realGameEvidence}</b>{" "}
          {plural(realGameEvidence, "real game counts", "real games count")} toward this.
        </p>
      </div>
    </section>
  );
}
