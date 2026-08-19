/**
 * One subject game as the API reads it, with its publication state.
 *
 * This is E11's version-bearing read: the first place a `/v1` response carries
 * the API contract's §1.2 version block, because it is the first place Forma
 * has a publication to name. Everything in the block comes from the pointer —
 * publication id, when it was installed, the recipe, and the exact component
 * versions behind it — so a client can tell that yesterday's review used
 * `estimator@1.2` and today's uses `estimator@1.3` without release notes.
 *
 * Ownership is an argument, not a filter. `readSubjectGame` has no overload
 * that omits the owner, so a game belonging to someone else is indistinguishable
 * from one that does not exist — which is what stops an identifier being probed.
 *
 * The analysis state is derived, never stored. A stored state column would be a
 * fourth thing that can disagree with the run, the publication and the replay
 * revision; deriving it means `stale` is a fact about which revision the current
 * publication pinned, not a flag someone remembered to set after a correction.
 */

import type { Queryable } from "../db/queryable.js";
import type { VersionBlock } from "../v1/envelope.js";

/**
 * Where the game's analysis stands.
 *
 * `stale` is the interesting one: a publication exists, but the provider has
 * since corrected the replay, so what is published was computed from a replay
 * that is no longer current. Saying `published` there would attach a claim to
 * evidence that has moved.
 */
export type GameAnalysisState = "published" | "stale" | "running" | "failed" | "unavailable";

export interface GameParticipant {
  color: "white" | "black";
  username: string | null;
  title: string | null;
  rating: number | null;
  ratingChange: number | null;
  outcome: "win" | "loss" | "draw";
  isBot: boolean | null;
}

export interface SubjectGameView {
  id: string;
  provider: string;
  providerUrl: string | null;
  playedAt: string;
  rated: boolean | null;
  speed: string | null;
  timeControl: string | null;
  result: "white" | "black" | "draw";
  termination: string | null;
  plyCount: number;
  subject: { color: "white" | "black" | null; status: string };
  replayRevision: { id: string; revisionNo: number; reason: string };
  analysis: {
    state: GameAnalysisState;
    /** The published run, when one is current. */
    runId: string | null;
    /** The revision the published run read, which may be older than the current one. */
    publishedRevisionId: string | null;
  };
  /** §1.2's version block. Null until something is published about this game. */
  version: VersionBlock | null;
  participants: GameParticipant[];
}

interface GameRow {
  id: string;
  provider: string;
  provider_url: string | null;
  played_at: string;
  rated: boolean | null;
  speed: string | null;
  time_control: string | null;
  result: "white" | "black" | "draw";
  termination: string | null;
  ply_count: number;
  subject_color: "white" | "black" | null;
  status: string;
  revision_id: string;
  revision_no: number;
  revision_reason: string;
  published_run_id: string | null;
  published_revision_id: string | null;
  publication_id: string | null;
  published_at: string | null;
  recipe_version_id: string | null;
  latest_run_status: string | null;
}

/**
 * Read one game the caller's account owns, or null.
 *
 * One query. The publication, the current revision and the newest run for that
 * revision are all needed to answer "what state is this in", and three round
 * trips could observe three different moments.
 */
export async function readSubjectGame(
  sql: Queryable,
  input: { subjectGameId: string; ownerProfileId: string },
): Promise<SubjectGameView | null> {
  const [row] = await sql<GameRow[]>`
    select sg.id, p.slug as provider, rev.provider_url, rev.played_at, rev.rated, rev.speed,
           rev.time_control, rev.result, rev.termination, rev.ply_count,
           sg.subject_color, sg.status,
           rev.id as revision_id, rev.revision_no, rev.revision_reason,
           pub.run_id as published_run_id, pub.replay_revision_id as published_revision_id,
           pub.publication_id, pub.published_at, pub.recipe_version_id,
           (
             select r.status from analysis.runs r
             where r.subject_game_id = sg.id and r.replay_revision_id = rev.id
             order by r.created_at desc, r.id desc limit 1
           ) as latest_run_status
    from chess.subject_games sg
    join app.analysis_subjects s on s.id = sg.subject_id
    join chess.game_replay_revisions rev on rev.id = sg.latest_replay_revision_id
    join chess.provider_games pg on pg.id = sg.provider_game_id
    join app.providers p on p.id = pg.provider_id
    left join analysis.subject_game_publications pub on pub.subject_game_id = sg.id
    where sg.id = ${input.subjectGameId} and s.owner_user_id = ${input.ownerProfileId}
  `;
  if (!row) return null;

  const participants = await sql<
    {
      color: "white" | "black";
      username_snapshot: string | null;
      title_snapshot: string | null;
      rating: number | null;
      rating_change: number | null;
      outcome: "win" | "loss" | "draw";
      is_bot: boolean | null;
    }[]
  >`
    select color, username_snapshot, title_snapshot, rating, rating_change, outcome, is_bot
    from chess.game_revision_participants
    where replay_revision_id = ${row.revision_id}
    order by color
  `;

  const version =
    row.publication_id && row.recipe_version_id
      ? {
          publicationId: row.publication_id,
          generatedAt: new Date(row.published_at!).toISOString(),
          // A game analysis is scoped to a replay revision, not to a subject
          // snapshot. Inventing one would attach the claim to evidence it was
          // not built from.
          subjectSnapshotId: null,
          recipeVersionId: row.recipe_version_id,
          policyVersions: await policyVersions(sql, row.recipe_version_id),
        }
      : null;

  return {
    id: row.id,
    provider: row.provider,
    providerUrl: row.provider_url,
    playedAt: new Date(row.played_at).toISOString(),
    rated: row.rated,
    speed: row.speed,
    timeControl: row.time_control,
    result: row.result,
    termination: row.termination,
    plyCount: row.ply_count,
    subject: { color: row.subject_color, status: row.status },
    replayRevision: {
      id: String(row.revision_id),
      revisionNo: row.revision_no,
      reason: row.revision_reason,
    },
    analysis: {
      state: analysisState(row),
      runId: row.published_run_id,
      publishedRevisionId:
        row.published_revision_id == null ? null : String(row.published_revision_id),
    },
    version,
    participants: participants.map((participant) => ({
      color: participant.color,
      username: participant.username_snapshot,
      title: participant.title_snapshot,
      rating: participant.rating,
      ratingChange: participant.rating_change,
      outcome: participant.outcome,
      isBot: participant.is_bot,
    })),
  };
}

function analysisState(row: GameRow): GameAnalysisState {
  if (row.published_run_id) {
    return String(row.published_revision_id) === String(row.revision_id) ? "published" : "stale";
  }
  if (row.latest_run_status === "planned" || row.latest_run_status === "running") return "running";
  if (row.latest_run_status === "failed") return "failed";
  return "unavailable";
}

async function policyVersions(sql: Queryable, recipeVersionId: string): Promise<Record<string, string>> {
  const rows = await sql<{ role: string; component_key: string; version: string }[]>`
    select rc.role, c.component_key, cv.version
    from analysis.recipe_components rc
    join analysis.component_versions cv on cv.id = rc.component_version_id
    join analysis.components c on c.id = cv.component_id
    where rc.recipe_version_id = ${recipeVersionId}
    order by rc.role
  `;
  return Object.fromEntries(rows.map((row) => [row.role, `${row.component_key}@${row.version}`]));
}
