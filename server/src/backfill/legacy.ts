/**
 * The legacy backfill, its reconciliation, and the cutover gate.
 *
 * What can and cannot be backfilled is decided by what the legacy system
 * actually holds, and it holds less than the epic assumes. `public.games` has
 * metadata -- players, ratings, result, ply count, url -- and no moves: every
 * `pgn_key` and `analysis_key` is null and no PGN bucket exists. There is
 * therefore no replay to reconstruct and no materialization to compare.
 *
 * So this backfills the ownership graph and nothing more: which provider game a
 * subject saw, and through which linked account. The canonical replay for those
 * games has to come from a provider re-fetch, which is E08's adapters.
 *
 * That is also why `assessCutover` refuses. Switching canonical reads while
 * every game lacks a replay would replace a working legacy view with an empty
 * one; the gate returning `false` is this epic's most useful output.
 */

import { createHash } from "node:crypto";
import type { Sql } from "postgres";

export interface BackfillReport {
  runId: string;
  processed: number;
  created: number;
  skipped: number;
  sourceChecksum: string;
  targetChecksum: string;
  manifest: Record<string, unknown>;
}

const BATCH = 100;

/**
 * Backfill provider games, subject games and their sources from legacy rows.
 *
 * Resumable: the cursor is the last legacy game id in a stable order, and every
 * insert is guarded by its natural key, so resuming re-reads a batch without
 * duplicating anything it already wrote.
 */
export async function backfillLegacyGames(sql: Sql, resumeRunId?: string): Promise<BackfillReport> {
  let runId = resumeRunId ?? "";
  let cursor: string | null = null;

  if (runId) {
    const [existing] = await sql<{ cursor_value: string | null }[]>`
      select cursor_value from ops.backfill_runs where id = ${runId} and kind = 'games'
    `;
    cursor = existing?.cursor_value ?? null;
  } else {
    const [run] = await sql<{ id: string }[]>`
      insert into ops.backfill_runs (kind) values ('games') returning id
    `;
    runId = run.id;
  }

  let processed = 0;
  let created = 0;
  let skipped = 0;

  for (;;) {
    const batch = await sql<
      {
        id: string;
        user_id: string;
        account_id: string;
        platform: string;
        platform_game_id: string;
        color: string;
        played_at: Date | string | null;
        url: string | null;
      }[]
    >`
      select id, user_id, account_id, platform::text as platform, platform_game_id,
             color::text as color, played_at, url
      from public.games
      ${cursor ? sql`where id > ${cursor}::uuid` : sql``}
      order by id
      limit ${BATCH}
    `;
    if (batch.length === 0) break;

    await sql.begin(async (tx) => {
      for (const legacy of batch) {
        const [{ provider_id }] = await tx<{ provider_id: number }[]>`
          select id as provider_id from app.providers where slug = ${legacy.platform}
        `;

        // Provider game identity. Shared, and owned by nobody.
        const [providerGame] = await tx<{ id: string }[]>`
          insert into chess.provider_games (provider_id, provider_game_id, first_seen_at)
          values (${provider_id}, ${legacy.platform_game_id},
                  ${legacy.played_at ?? new Date()})
          on conflict (provider_id, provider_game_id) do update set last_seen_at = now()
          returning id
        `;

        // The subject that owns the evidence. Backfilled identities from 0017
        // gave every legacy profile exactly one active personal subject.
        const [subject] = await tx<{ id: string }[]>`
          select id from app.analysis_subjects
          where owner_user_id = ${legacy.user_id} and kind = 'personal' and status = 'active'
        `;
        if (!subject) {
          skipped += 1;
          continue;
        }

        // The linked account this legacy row came through, mapped to the E06
        // claim for the same owner and provider identity.
        const [claim] = await tx<{ id: string }[]>`
          select nla.id from app.linked_accounts nla
          join app.provider_identities pi on pi.id = nla.provider_identity_id
          join public.linked_accounts old on old.id = ${legacy.account_id}::uuid
          where nla.owner_user_id = ${legacy.user_id}
            and pi.provider_id = ${provider_id}
            and pi.provider_identity_key
                = coalesce(nullif(old.provider_account_id, ''), old.normalized_username)
          limit 1
        `;

        const existing = await tx<{ id: string }[]>`
          select id from chess.subject_games
          where subject_id = ${subject.id} and provider_game_id = ${providerGame.id}
        `;
        if (existing.length === 0) created += 1;

        const [subjectGame] = await tx<{ id: string }[]>`
          insert into chess.subject_games (subject_id, provider_game_id, subject_color, status)
          values (${subject.id}, ${providerGame.id}, ${legacy.color}, 'included')
          on conflict (subject_id, provider_game_id) do update set updated_at = now()
          returning id
        `;

        if (claim) {
          await tx`
            insert into chess.subject_game_sources (subject_game_id, linked_account_id)
            values (${subjectGame.id}, ${claim.id})
            on conflict (subject_game_id, linked_account_id) do update set last_seen_at = now()
          `;
        }
        processed += 1;
      }

      cursor = batch[batch.length - 1].id;
      await tx`
        update ops.backfill_runs
        set cursor_value = ${cursor}, processed = ${processed}, created = ${created},
            skipped = ${skipped}, updated_at = now()
        where id = ${runId}
      `;
    });

    if (batch.length < BATCH) break;
  }

  const { sourceChecksum, targetChecksum, manifest } = await reconcile(sql);
  await sql`
    update ops.backfill_runs
    set state = 'succeeded', finished_at = now(),
        source_checksum = ${sourceChecksum}, target_checksum = ${targetChecksum},
        manifest = ${JSON.stringify(manifest)}::jsonb
    where id = ${runId}
  `;

  return { runId, processed, created, skipped, sourceChecksum, targetChecksum, manifest };
}

/**
 * Compare the legacy source with what the backfill produced.
 *
 * The checksums are over per-owner, per-provider counts rather than over ids: a
 * count that matches on both sides is the claim being made, and a manifest full
 * of game ids would put provider identifiers in a table anyone with ops access
 * can read.
 */
export async function reconcile(sql: Sql): Promise<{
  sourceChecksum: string;
  targetChecksum: string;
  manifest: Record<string, unknown>;
}> {
  const source = await sql<{ user_id: string; platform: string; n: number }[]>`
    select user_id::text as user_id, platform::text as platform, count(*)::int as n
    from public.games group by 1, 2 order by 1, 2
  `;
  const target = await sql<{ owner: string; slug: string; n: number }[]>`
    select s.owner_user_id::text as owner, p.slug, count(*)::int as n
    from chess.subject_games sg
    join app.analysis_subjects s on s.id = sg.subject_id
    join chess.provider_games g on g.id = sg.provider_game_id
    join app.providers p on p.id = g.provider_id
    group by 1, 2 order by 1, 2
  `;

  const sourceRows = source.map((r) => `${r.user_id}:${r.platform}:${r.n}`);
  const targetRows = target.map((r) => `${r.owner}:${r.slug}:${r.n}`);

  // A mismatch is *loss*: fewer canonical rows than legacy for an owner and
  // provider. Having more is not a defect -- it is what a successful sync looks
  // like, since games fetched from the provider were never in the legacy table.
  // Counting "ahead" as a mismatch would make the cutover gate permanently red
  // for the very reason it should eventually go green.
  const mismatches: string[] = [];
  let ahead = 0;
  const targetMap = new Map(target.map((r) => [`${r.owner}:${r.slug}`, r.n]));
  for (const row of source) {
    const key = `${row.user_id}:${row.platform}`;
    const got = targetMap.get(key) ?? 0;
    // Categories only: which owner is never named outside the checksum.
    if (got < row.n) mismatches.push(`missing_canonical:${row.platform}`);
    else if (got > row.n) ahead += got - row.n;
  }

  const [{ replays }] = await sql<{ replays: number }[]>`
    select count(*)::int as replays from chess.provider_games where current_replay_revision_id is not null
  `;
  const [{ games }] = await sql<{ games: number }[]>`
    select count(*)::int as games from chess.subject_games
  `;

  return {
    sourceChecksum: createHash("sha256").update(sourceRows.join("|")).digest("hex"),
    targetChecksum: createHash("sha256").update(targetRows.join("|")).digest("hex"),
    manifest: {
      legacyGames: source.reduce((total, row) => total + row.n, 0),
      canonicalSubjectGames: games,
      canonicalGamesWithReplay: replays,
      ownerProviderPairs: source.length,
      canonicalAheadOfLegacy: ahead,
      mismatchCategories: [...new Set(mismatches)],
      mismatchCount: mismatches.length,
    },
  };
}

export interface CutoverAssessment {
  ready: boolean;
  blockers: string[];
  manifest: Record<string, unknown>;
}

/**
 * Whether canonical reads may replace the legacy ones.
 *
 * Deliberately conservative and deliberately failing today. Ownership backfills
 * cleanly, but every canonical game is missing its replay, because the legacy
 * system never stored one. Switching reads now would trade a working view for
 * an empty one.
 *
 * This returns a reason rather than throwing, so the gate is a fact a runbook
 * can print rather than an exception someone catches.
 */
export async function assessCutover(sql: Sql): Promise<CutoverAssessment> {
  const { manifest } = await reconcile(sql);
  const blockers: string[] = [];

  const legacy = Number(manifest.legacyGames ?? 0);
  const canonical = Number(manifest.canonicalSubjectGames ?? 0);
  const withReplay = Number(manifest.canonicalGamesWithReplay ?? 0);

  if (canonical < legacy) {
    blockers.push(`only ${canonical} of ${legacy} legacy games have a canonical row`);
  }
  if (withReplay < canonical) {
    blockers.push(
      `${canonical - withReplay} canonical games have no replay revision; the legacy system stored no moves, so these must come from a provider re-fetch`,
    );
  }
  if (Number(manifest.mismatchCount ?? 0) > 0) {
    blockers.push(`${manifest.mismatchCount} reconciliation mismatches are unresolved`);
  }

  return { ready: blockers.length === 0, blockers, manifest };
}
