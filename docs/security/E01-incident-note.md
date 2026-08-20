# E01 incident note — live Supabase exposure

## What happened

`plans/v1-platform-audit.md` section 4 A-01 recorded that anonymous requests
using the browser-safe Supabase key returned rows from `profiles`,
`linked_accounts`, `games`, `analysis_tasks`, and `position_eval`. The `anon` and
`authenticated` roles held broad privileges on all 22 legacy `public` tables, ten
tables had RLS enabled with no policy, twelve had it off, and default privileges
re-granted browser roles on every new object. The audit retained status and count
evidence only; no row bodies were kept, and none are reproduced here.

## What closed it

Migration `0011_e01_containment`, already applied to production
(`oqsjfmgdovvepncbphvk`). It revokes schema, table, sequence, and routine access
from `PUBLIC`, `anon`, and `authenticated`, enables RLS on all 22 tables, creates
one `forma_api`-scoped policy on 19 of them, and grants `forma_api` exactly 54
table privileges.

This branch records and independently verifies that containment. It applies no
migration, makes no production write, and changes no deployment, traffic, secret,
or service configuration.

## Truth classes

- **Observed live** — the serving revision `tempo-chess-api-00004-8dk`, its
  digest, build, 100% traffic, service account, secret binding, the live
  catalogue, and the applied 0011 checksum. All read-only.
- **Historical** — the archived `0011_snapshot.json`, reconciled by size and
  hash and labelled historical. It is not claimed deployed.
- **Branch-only** — the CORS allowlist, the startup role/port/marker gate, the
  private identity check, and the safe-error layer. These are regression safety
  on this branch. **None of them is deployed by E01 recovery**, and the serving
  revision predates all of them.

## Residual risks

1. **Application-level tenant authorization.** The containment policy is
   `USING (true)`: it scopes the data plane to `forma_api` and nothing more.
   Per-user separation is enforced in the API, not the database. Owned by
   **E02/E03**.
2. **Surviving `supabase_admin` default ACLs.** `ALTER DEFAULT PRIVILEGES FOR
   ROLE supabase_admin` raises `insufficient_privilege` and 0011 deliberately
   skips it, so those rows still name `anon` and `authenticated` for future
   objects. A new object created by that grantor would carry browser-role
   privileges. It is *not* reachable today because neither role holds `USAGE` on
   schema `public`, and `REH-ACL-001`..`012` prove exactly that against a real
   new object created under both grantors. This is recorded residual risk, not a
   safe default. Owned by **E02**.
3. **Live `DATABASE_ROLE` absence.** The latest retained complete environment
   inventory for the serving revision does not contain `DATABASE_ROLE`. This is
   observed live configuration drift. `DATABASE_ROLE=forma_api` is a branch and
   rehearsal startup invariant only; it is not deployed, and E01 does not deploy
   it. Correcting the live marker is owned by **E05**.
4. **Unknown serving source commit.** The deployed source bundle carries no Git
   metadata, so the Git commit behind `tempo-chess-api-00004-8dk` is unknown and
   recorded as unknown. No branch or archive commit may be represented as
   serving. Source-to-revision correction is owned by **E05**.
5. **Cached-token revocation latency.** A token already resolved by the API stays
   cached for up to 15 seconds. E01 neither changes nor hides this; the
   revoked-*before-first-use* case is proven to deny within 10 seconds
   (`REH-AUTH-003`, observed 28 ms). Owned by **E03**.
6. **`forma_migrator` exists.** Frozen in 0011, inert here: no credential, client,
   job, executable path, or active session. Operational use is owned by **E05**.
7. **Live CORS.** The serving revision sets `WEB_ORIGINS`, which the deployed
   code did not read, so it fell back to a wildcard. The branch fixes both the
   variable name and the fallback. The fix is **branch-only** until E05 deploys.

## Rollback

Forward-only. See `docs/security/E01-runbook.md`. There is no down-migration and
no 0012/0013.
