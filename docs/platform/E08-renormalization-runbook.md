# E08 — renormalizing the replays the canonical sync stored as SAN

Every game the canonical sync committed before `e08-normalizer-2` has SAN
strings in a field named `uci`. This is what that means, what it broke, and the
one way to correct it that the canonical record permits.

## 1. What was wrong

`GET /api/games/user/{name}` with `moves=true` returns **SAN** in the `moves`
string — `e4 e5 Nf3 d6 d4 Nd7 Nc3 h6 Bb5 Qf6` — not coordinates. Verified
against the live endpoint for `ncarcasc`: all 337 games return SAN tokens, and
none of them return a token matching `^[a-h][1-8][a-h][1-8][qrbn]?$`.

`lichessGameInput` split that string on whitespace and wrote each token straight
into `uci`, leaving `san` null. So `chess.game_replay_revisions.normalized_replay`
holds, for every game the canonical sync committed:

```json
{"moves": [{"uci": "e4", "san": null, "clockMs": 180000}, ...]}
```

The rest of the codebase already knew better. `ingest/lichess.ts` detects the
token shape and falls back to `chess.move(token)`, and `backfill/provider-proof.ts`
converts SAN to coordinates before it normalizes. Only the path the product
actually uses did not.

`3676600` added the conversion. What it did not add, and what the rest of this
document is about, is everything the conversion implies: three shapes of game it
still refuses, one spelling it gets wrong, and the fact that the rows already in
the database do not correct themselves.

### The four the conversion left

- **A replay in coordinates is dropped.** `parseSan` accepts `e2e4` — it reads
  as a file-disambiguated `e4` — and refuses `g1f3`, so a coordinate line dies
  at its first piece move. The two fixtures in `pagination.test.ts` are
  `"e2e4 e7e5"` and `"d2d4"`, both pawns, both accidentally fine, which is why
  the gap looked covered.
- **`initialFen: "startpos"` is dropped.** It is Lichess naming the standard
  position, not offering a FEN of it; `parseFen` errors and the game is
  discarded whole. `ingest/lichess.ts` has guarded this since it was written.
- **A dropped game leaves no trace.** Returning null from the adapter counts the
  record in `received` and puts it in no rejection tally, so a variant game
  stops being counted as `non_standard_variant` and a line we could not read is
  invisible on the run. Refusing it through the normalizer instead keeps each
  reason.
- **Castling was spelled for the wrong reader.** `makeUci` writes king-takes-rook
  (`e1h1`), the Chess960 convention. Stockfish is never put in 960 mode here and
  reports `e1g1`, and `assessments.ts` matches the played move against the
  engine's candidates with `indexOf`. Both spellings replay to the same board,
  so nothing fails — every castle just ranks null, which reads as "not among the
  lines this search retained" about the most ordinary move in chess.

## 2. Blast radius

What the rows already in the database do, which is unchanged by the adapter
being fixed: they are still there, and nothing rewrites them.

Exactly one runtime consumer reads `normalized_replay.moves[].uci`:
`materializeReplayRevision` in `server/src/positions/worker.ts`, which hands the
list to `materializeReplay` and thence to `chessops`' `parseUci`.

No SAN token can be misread as a legal coordinate move. `parseUci` needs
`[a-h][1-8]` in both halves, and a SAN token never has that shape: `e4` and
`Nf3` are too short, `exd5` and `Nbd7` fail on their second character, `O-O`
fails on all of them. So the failure is loud and total rather than silent:

- **Materialization** throws `ReplayMaterializationError(ply 1, unparsable_move)`
  for every synced replay. That is not a `WorkFailure`, so the executor reads it
  as `transient` / `handler_error`, retries it to the attempt ceiling and then
  dead-letters it. Each affected game burns its whole retry budget on work that
  could never succeed.
- **Everything downstream is starved, not corrupted.** The opening explorer
  (`openings/subject-explorer.ts`), the engine recipe (`engine/recipe.ts`),
  review, practice and the analysis planner all read
  `chess.position_occurrences` / `chess.position_transitions`, which are written
  only by a materialization run that completed. None exists for these games, so
  there is no bad data anywhere downstream — there is no data.
- **No analysis is invalidated.** `planPendingGameAnalyses` joins a published
  materialization run, so no analysis run was ever planned over a SAN replay.
- **Relational columns are unaffected.** `result`, `ply_count`, `played_at`,
  participants and the subject links were all correct; only the jsonb replay was
  wrong. `analysis/game-view.ts` reads those columns and never the jsonb.

`backfill/provider-proof.ts` is not affected: it does its own SAN conversion
before calling `normalizeGame`.

## 3. The decision: a `renormalized` revision sweep

**An in-place backfill is not available.** `chess.game_replay_revisions` is
immutable by trigger (`refuse_revision_mutation`, migration `0019`), and that is
deliberate: an analysis pins a revision id, so a row that could change under it
would make the pin a lie. Any correction is therefore an appended revision. The
choice was never really between two mechanisms; there is one, and the only
question is what the new revision says about itself.

So: **a renormalized revision sweep, carried by a `reconcile` sync, with
`NORMALIZER_VERSION` bumped to `e08-normalizer-2`.**

The version bump is not an alternative to the sweep. It is what makes the sweep
truthful and findable:

- The column exists to record which component produced a row. A normalizer that
  writes provider tokens into `uci` and one that writes coordinates are not the
  same component, and leaving the version alone would make the two revisions of
  the same game distinguishable only by re-parsing their jsonb.
- `commitBatch` now derives `revision_reason` from it: same normalizer, different
  digest means the provider changed the game (`provider_correction`); different
  normalizer means we changed our reading of an unchanged payload
  (`renormalized`). Without the bump, the sweep would file a row per game
  claiming Lichess corrected a game it never touched.
- It gives an operator the query in §5 for finding what is still unswept.

The digest changes because `replayDigest` hashes `[uci, san, clockMs]` per move,
and both of the first two are now different. That is the mechanism, not a side
effect: a changed digest is what makes `commitBatch` append rather than count a
duplicate, which is what moves `subject_games.latest_replay_revision_id`, which
is what makes `planPendingMaterializations` see a revision with no published run.

## 4. Running the sweep

For each active linked account, enqueue one `provider_account_sync` item with
`mode: "reconcile"`. Reconcile starts from a null cursor, so it re-reads the
whole archive rather than resuming; the commit is idempotent per game, so
nothing needs deleting first.

```
taskType: provider_account_sync      (ACCOUNT_SYNC_TASK)
payload:  { linkedAccountId, subjectId, mode: "reconcile" }
queue:    provider-lichess
```

There is no operator CLI for this yet; it is a `createWorkflow` call against the
work ledger. Rate limits still apply — one account is up to `MAX_PAGES_PER_ITEM`
(20) pages per item, and the walk reports `moreAvailable` when it stops short.

Then run the existing sweep, which needs no new code:

```ts
await planPendingWork(sql);   // server/src/analysis/planner.ts
```

`planPendingMaterializations` keys its work items on the revision id, so the new
revisions get fresh items rather than colliding with the dead-lettered ones from
the old ids.

Expect, per swept account:

| Counter | What it will say |
| --- | --- |
| `sync_runs.games_accepted` | 0 for games already stored |
| `sync_runs.games_corrected` | one per game renormalized |
| `sync_runs.games_duplicate` | one per game already at the new digest, on a re-run |

`games_corrected` counts every replacing revision whichever side caused it,
because the run has one column for "a canonical replay was superseded". The
revision's own `revision_reason` is where the two are told apart.

## 5. Verifying

Rows still on the old normalizer, and of those, the ones whose first move is not
coordinate-shaped:

```sql
select normalizer_component_version_id, count(*)
  from chess.game_replay_revisions
 group by 1 order by 2 desc;

select count(*)
  from chess.game_replay_revisions
 where normalizer_component_version_id = 'e08-normalizer-1'
   and normalized_replay #>> '{moves,0,uci}' !~ '^[a-h][1-8][a-h][1-8][qrbn]?$';
```

Revisions written by fixtures and gates use `norm-v1` and are not part of this.

That the sweep landed, and that materialization can now read what it produced:

```sql
select r.revision_reason, count(*)
  from chess.game_replay_revisions r
 where r.normalizer_component_version_id = 'e08-normalizer-2'
 group by 1;

select count(*) filter (where m.id is null) as unmaterialized,
       count(*) filter (where m.id is not null) as materialized
  from chess.subject_games sg
  left join chess.materialization_runs m
    on m.replay_revision_id = sg.latest_replay_revision_id and m.state = 'published'
 where sg.status = 'included';
```

## 6. What the sweep does not do

- **It does not remove the old revisions.** They stay, immutable, at
  `e08-normalizer-1`, no longer pointed at by
  `provider_games.current_replay_revision_id` or
  `subject_games.latest_replay_revision_id`. That is the design: the record of
  what we once stored survives us correcting it.
- **It does not clean up the dead materialization items.** The work items keyed
  `materialize:<old-revision-id>` stay dead in the ledger. They are the evidence
  of the failure and they are keyed to revisions nothing points at, so they are
  harmless; deleting them is a separate decision.
- **It does not reach Chess.com.** There is no canonical adapter for it, which is
  why no Chess.com game was stored wrong.
