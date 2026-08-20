import { useLoaderData } from "react-router";
import type { Route } from "./+types/dashboard";
import { Today, leadTask, type LeadTask } from "../components/Today";
import { RouteError } from "../components/RouteError";
import { requireSession } from "../lib/session";
import { deriveTearSheet } from "../lib/tearSheet";
import { openingShape, type OpeningShape } from "../lib/todayShape";
import { getCached, setCached } from "../lib/loaderCache";
import { getOnboarding, getWorkflow } from "../lib/onboarding/api";
import { nextScreen, type Destination } from "../lib/onboarding/nextScreen";
import { fetchRecentGames, type RecentGame } from "../lib/v1/games";
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
 *   * `GET /v1/openings/explorer` per colour, for the shape and the lead;
 *   * `GET /v1/games/recent`, for the last game;
 *   * `GET /v1/onboarding` plus its sync workflow, for where the run stands.
 *
 * No call carries a username. The subject is resolved from the access token on
 * the server, which is what stops a client naming somebody else's games.
 *
 * The panels with no `/v1` source say so on screen rather than falling back:
 * the rating, the lifetime record, and the analysed-game and blunder counts.
 * The import control is gone with them — `/v1` has no importer, because games
 * arrive with an examination run rather than on demand.
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
async function readRun(): Promise<Destination | null> {
  try {
    const state = await getOnboarding();
    const workflow = state.syncWorkflowId
      ? await getWorkflow(state.syncWorkflowId).catch(() => null)
      : null;
    return nextScreen({ state, workflow });
  } catch (error) {
    if (error instanceof Response) throw error; // a 401 redirect must land
    return null;
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
  const [white, black, recent, run] = await Promise.all([
    getOpeningExplorer({ color: "white" }),
    getOpeningExplorer({ color: "black" }),
    fetchRecentGames(1),
    readRun(),
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
    run,
  };
  setCached(cacheKey, data);
  return data;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return <RouteError title="Could not load your games" error={error} />;
}

export default function TodayRoute() {
  const data = useLoaderData() as TodayData;
  return <Today {...data} />;
}
