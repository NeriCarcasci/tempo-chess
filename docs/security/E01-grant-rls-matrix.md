# E01 grant, RLS, and policy matrix

The frozen containment shape. These values are contract inputs, reproduced here
for review; the executable copy lives in `server/src/security/contract.ts` and
the gates fail if the two disagree.

Schema: `public`. Runtime role: `forma_api`. Migration role: `forma_migrator`
(frozen in 0011, inert in E01 — no credential, client, job, or executable path).

## Row level security

All 22 tables have `relrowsecurity = true` after 0011. Ten already had RLS
enabled with no policy before it; twelve had it off entirely.

## Policies — 19

One policy per table, named `<table>_forma_api_service_dataplane`, on every table
except `player_opening_stats`, `player_style`, and `puzzles`.

Shape: `AS PERMISSIVE FOR ALL TO forma_api USING (true) WITH CHECK (true)`.

This is role scoping, not tenant authorization. `USING (true)` means the policy
does not distinguish one user's rows from another's — application-level
authorization does, and remains residual risk until E02/E03. The policy must
never be widened to `anon`, `authenticated`, or `PUBLIC`.

## Runtime grants — 54

| Tables | Privileges |
|---|---|
| `analysis_imports`, `analysis_tasks`, `beta_signups`, `game_sources`, `games`, `lesson_progress`, `linked_accounts`, `opening_drills`, `opening_edges`, `opening_positions`, `player_opening_observations` | `INSERT, SELECT, UPDATE` |
| `canonical_moves`, `repertoire_openings` | `DELETE, INSERT, SELECT` |
| `opening_repertoire_moves`, `profiles` | `DELETE, INSERT, SELECT, UPDATE` |
| `mistakes` | `SELECT` |
| `opening_training_results`, `position_eval`, `usage_events` | `INSERT, SELECT` |

11 x 3 + 2 x 3 + 2 x 4 + 1 + 3 x 2 = 54.

## No runtime grant — 3

`player_opening_stats`, `player_style`, `puzzles`. `forma_api` holds no privilege
on these and no policy applies to it.

## Browser roles

`PUBLIC`, `anon`, and `authenticated` hold no privilege on any of the 22 tables
and no `USAGE` on schema `public`. The public-projection allowlist is empty: all
22 tables are internal, so an anonymous `200` on any of them is a failure, not a
projection.

## Role attributes

Both `forma_api` and `forma_migrator`: `rolcanlogin=true`, `rolinherit=false`,
`rolsuper=false`, `rolcreatedb=false`, `rolcreaterole=false`,
`rolbypassrls=false`. `forma_api` owns no table, sequence, routine, or schema in
`public`.
