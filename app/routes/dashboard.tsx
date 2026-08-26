import { useCallback, useEffect, useState } from "react";
import { useLoaderData, useRevalidator } from "react-router";
import type { Route } from "./+types/dashboard";
import { Today, leadTask, type LeadTask } from "../components/Today";
import { Primer } from "../components/onboarding/Primer";
import { RouteError } from "../components/RouteError";
import { markPrimerSeen, primerSeen } from "../lib/onboarding/primer";
import { requireSession } from "../lib/session";
import { deriveTearSheet } from "../lib/tearSheet";
import { openingShape, type OpeningShape } from "../lib/todayShape";
import { getCached, invalidateCache, setCached } from "../lib/loaderCache";
import { getOnboarding, getWorkflow } from "../lib/onboarding/api";
import { nextScreen, type Destination } from "../lib/onboarding/nextScreen";
import { fetchRecentGames, type RecentGame } from "../lib/v1/games";
import { getDashboard, todayReport, type TodayReport } from "../lib/v1/dashboard";
import { activeGoal, getGoalProgress, listGoals, type GoalProgress, type GoalView } from "../lib/v1/goals";
import {
  explorerEmptyReason,
  getOpeningExplorer,
  walkable,
  type ExplorerEmptyReason,
} from "../lib/v1/openings";

/**
 * `/today`, read from the canonical system.
 *
 * Every figure on this page used to come from the prototype API: a summary
 * built from `public.games`, an opening explorer keyed by `?username=`, and a
 * coverage call that compared the two. Those tables stopped being written when
 * the pipeline moved, so the page reported a smaller archive than the one that
 * exists and no analysis at all over an archive that had been analysed twice.
 *
 * What it reads now, and nothing else:
 *
 *   * `GET /v1/dashboard`, for what the published report concludes;
 *   * `GET /v1/openings/explorer` per colour, for the shape and the lead;
 *   * `GET /v1/games/recent`, for the last game;
 *   * `GET /v1/onboarding` plus its sync workflow, for where the run stands;
 *   * `GET /v1/goals` plus `GET /v1/goals/{id}/progress`, for the active goal.
 *
 * No call carries a username. The subject is resolved from the access token on
 * the server, which is what stops a client naming somebody else's games.
 *
 * The rating and the trajectory used to be stated absences here, because the
 * figures that once filled them came from tables the pipeline stopped writing
 * and `/v1` published nothing to replace them. `/v1/dashboard` publishes both,
 * so the page now opens on a measurement again. The import control is still
 * gone — `/v1` has no importer, because games arrive with an examination run
 * rather than on demand.
 */

interface TodayData {
  /** Where in a game the player's opening mistakes fall. */
  shape: OpeningShape;
  /** The single line worth opening on, or null when nothing qualifies. */
  lead: LeadTask | null;
  /** Why there is no graph at all, when there is none. */
  empty: ExplorerEmptyReason | null;
  /** Games behind the opening graph, both colours pooled. */
  games: number;
  /** Of those, the ones no analysis has reached yet. */
  unanalysed: number;
  lastGame: RecentGame | null;
  run: Destination | null;
  /** The run's own stage, which decides which phase the top bar names. */
  runStage: string | null;
  /** Whose page this is. The introduction is remembered per person. */
  userId: string;
  /** What the published report concludes, or null when nothing is published. */
  report: TodayReport | null;
  /** The goal this account is actively working, or null with none set. */
  goal: GoalView | null;
  /** That goal's progress, or null when nothing has been measured on it yet. */
  goalProgress: GoalProgress | null;
}

export function meta() {
  return [
    { title: "Today · Forma" },
    {
      name: "description",
      content: "The one line worth fixing today, and what to do after it.",
    },
  ];
}

/**
 * Where the examination stands.
 *
 * The workflow is fetched as well as the run, and that is not belt and braces:
 * when a sync dies the run does not notice — its status stays `active` and its
 * next action stays `wait` — so a row built from the run alone would tell
 * somebody Forma was still reading their games for as long as they kept
 * visiting. `nextScreen` closes that, but only if it is handed the workflow.
 *
 * A failure here is a missing row, not a failed page. Where the run stands is
 * context for the page, and /onboarding is the screen that owns it.
 */
async function readRun(): Promise<{ destination: Destination | null; stage: string | null }> {
  try {
    const state = await getOnboarding();
    const workflow = state.syncWorkflowId
      ? await getWorkflow(state.syncWorkflowId).catch(() => null)
      : null;
    // The stage travels with the destination because the bar needs both: the
    // destination says whether work is running, and the stage is the only thing
    // to go on in the opening seconds, before any workflow has been read.
    return { destination: nextScreen({ state, workflow }), stage: state.stage };
  } catch (error) {
    if (error instanceof Response) throw error; // a 401 redirect must land
    return { destination: null, stage: null };
  }
}

/**
 * What the published report says, or nothing.
 *
 * A 404 is the ordinary state of somebody who has not been examined yet and is
 * already null. Anything else is swallowed for the same reason the run is: this
 * is the top of a page that has other things to show, and a failed read of one
 * panel must not take the page with it. `/profile` reads the same endpoint and
 * does let it throw, because there the dashboard *is* the page.
 */
async function readReport(): Promise<TodayReport | null> {
  try {
    const result = await getDashboard();
    return result === null ? null : todayReport(result.data);
  } catch (error) {
    if (error instanceof Response) throw error; // a 401 redirect must land
    return null;
  }
}

/**
 * The goal this account is working, and what has been measured on it.
 *
 * `/v1/goals` has no active-goal filter, so the whole list is read and the
 * active one picked here. Nothing here is a claim about the player yet — the
 * ordinary state, for an account that has never set one, is `goal: null`, and
 * the page has to say that rather than nothing at all.
 */
async function readGoal(): Promise<{ goal: GoalView | null; progress: GoalProgress | null }> {
  try {
    const goal = activeGoal(await listGoals());
    if (!goal) return { goal: null, progress: null };
    const progress = await getGoalProgress(goal.goalId);
    return { goal, progress };
  } catch (error) {
    if (error instanceof Response) throw error; // a 401 redirect must land
    return { goal: null, progress: null };
  }
}

export async function clientLoader(): Promise<TodayData> {
  const session = await requireSession();

  // Keyed by the profile rather than a username. The username is no longer
  // part of what identifies this data — the server resolves the subject from
  // the token — and keying on a handle that can be null would collide two
  // people's pages into one cache entry.
  const cacheKey = `today:${session.userId}`;
  const cached = getCached<TodayData>(cacheKey, 60_000);
  if (cached) return cached;

  /**
   * Both colours, because the lead has to name a side to link a drill at, and
   * a pooled graph cannot. `walkable` is the whole adapter: the v1 graph and
   * the legacy one differ only in a loss field the tear sheet never reads.
   */
  const [white, black, recent, run, report, { goal, progress }] = await Promise.all([
    getOpeningExplorer({ color: "white" }),
    getOpeningExplorer({ color: "black" }),
    fetchRecentGames(1),
    readRun(),
    readReport(),
    readGoal(),
  ]);

  const sheet = deriveTearSheet(
    white.graph ? walkable(white.graph) : null,
    black.graph ? walkable(black.graph) : null,
  );

  // Disjoint sets: a game has one subject colour, so the two coverage blocks
  // never count the same game twice.
  const games = white.coverage.games + black.coverage.games;
  const unanalysed = white.coverage.unanalysedGames + black.coverage.unanalysedGames;

  const data: TodayData = {
    shape: openingShape(sheet),
    lead: leadTask(sheet),
    // Asked against a pooled view with no filters set. Each request carries a
    // colour, and passing one of them through would report "no games match
    // these filters" to a player who chose no filters and has no games.
    empty:
      white.graph || black.graph
        ? null
        : explorerEmptyReason({
            coverage: { games },
            filters: { color: null, speed: null, provider: null, family: null },
          }),
    games,
    unanalysed,
    lastGame: recent[0] ?? null,
    run: run.destination,
    runStage: run.stage,
    userId: session.userId,
    report,
    goal,
    goalProgress: progress,
  };
  setCached(cacheKey, data);
  return data;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return <RouteError title="Could not load your games" error={error} />;
}

export default function TodayRoute() {
  const data = useLoaderData() as TodayData;
  const revalidator = useRevalidator();

  /**
   * The four cards, once per person.
   *
   * Read in an effect rather than during render because it touches
   * localStorage, and a loader that did it would make the answer part of the
   * cached page — so the second visit in a minute would show the introduction
   * again, or never. Deciding after mount also means the dashboard paints
   * first and the card arrives over a page that is already there, which is the
   * whole point of sending somebody here rather than to a progress screen.
   */
  const [primer, setPrimer] = useState(false);
  useEffect(() => {
    if (!primerSeen(data.userId)) setPrimer(true);
  }, [data.userId]);

  const closePrimer = useCallback(() => {
    markPrimerSeen(data.userId);
    setPrimer(false);
  }, [data.userId]);

  /**
   * The examination finished under the page. Everything on it is loader data
   * with a minute of cache behind it, so without this the report a person just
   * watched arrive would not appear until they navigated away and back.
   */
  const onSettled = useCallback(() => {
    invalidateCache(`today:${data.userId}`);
    void revalidator.revalidate();
  }, [data.userId, revalidator]);

  return (
    <>
      <Today {...data} onSettled={onSettled} />
      <Primer open={primer} live={data.run?.kind === "wait"} onClose={closePrimer} />
    </>
  );
}
