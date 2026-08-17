# E02 — platform foundation runbook

Migration `0012_e02_platform_foundation` creates the eight target namespaces,
the six named roles and their grants, the transaction-local actor helpers, and
the schema catalogue. It is additive: it drops nothing, renames nothing, and
does not touch a single object in the legacy `public` schema.

## Applying it

```
DATABASE_URL="postgresql://<deploy-role>@<session-host>:5432/postgres" npm run db:migrate
```

On the automation host, `bin/forma-db-url.sh` prints the correct URL:
`export DATABASE_URL="$(forma-db-url.sh)"`.

The deploy role for 0012 is the project owner — on Supabase, `postgres`. It is
**not** a superuser. What it must have:

- **A session, never a multiplexed transaction pool.** Migrations take DDL
  locks and must hold one backend for the whole connection. Both the direct
  endpoint on 5432 and the Supavisor **session** pooler on 5432 satisfy this.
  The **transaction** pooler on 6543 does not, and must never be used here.

  In practice the direct endpoint is unreachable from the automation host:
  `db.<ref>.supabase.co` publishes only a AAAA record and the host has no
  IPv6 egress. 0012 was therefore applied over the session pooler
  (`aws-0-eu-west-1.pooler.supabase.com:5432`, user `postgres.<ref>`), which
  assigns one dedicated backend per connection. Enabling the Supabase IPv4
  add-on would restore the documented direct path.
- **`CREATEROLE`.** 0012 creates the four worker roles and comments on all six;
  `forma_migrator` deliberately cannot, because it holds `NOCREATEROLE`.
- **Ownership of the database**, so it can grant `CREATE` on the database to
  `forma_migrator`. Without that, `forma_migrator` cannot run a later migration
  at all: the migration runner's first statement is
  `create schema if not exists drizzle`, which is refused without it even when
  the schema already exists.

It does **not** need to be a member of `forma_migrator` with `SET`. The
membership `CREATEROLE` creates automatically is `ADMIN TRUE, SET FALSE,
INHERIT FALSE`, and under exactly that posture `create schema ... authorization
forma_migrator` fails with `must be able to SET ROLE "forma_migrator"` and
`comment on role` is denied. So 0012 takes `SET` and `INHERIT` on the
memberships it already administers, then creates the schemas and switches to
`set local role forma_migrator` for everything it owns. The switch is
transaction-local and the file ends with `reset role`, so the migration runner's
own ledger insert is still written by the deploying role.

0012 also grants `forma_migrator` `usage, create` on schema `drizzle` and
`select, insert, delete` on `drizzle.__drizzle_migrations` and its sequence.
Ownership of the ledger stays with the deployer; the grants are what let every
*later* migration, and the recovery replay below, run as `forma_migrator`.

No password is set by the migration. Each service's credential is created out of
band and lives only in Secret Manager, one per service.

Re-running is safe. Every statement is guarded or idempotent, and the gate
proves it by replaying the committed SQL against an already-migrated database —
including as `forma_migrator` rather than as an administrator standing in for
it.

## Roles and grants

`USAGE` on a schema is the whole of what a role receives here. No role holds a
privilege on any table it has not been granted by name, and no default privilege
hands a runtime role a table it was never reviewed for.

| Role | app | social | chess | analysis | coaching | ops | api | private |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `forma_api` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `forma_ops` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ |
| `forma_ingestion` | ✓ | — | ✓ | — | — | ✓ | — | ✓ |
| `forma_stockfish` | — | — | ✓ | ✓ | — | ✓ | — | — |
| `forma_analysis` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ |
| `forma_migrator` | owner | owner | owner | owner | owner | owner | owner | owner |

`PUBLIC`, `anon`, `authenticated`, and `service_role` hold nothing on any of the
eight schemas, and nothing on either `private` helper.

`forma_stockfish` is the deliberate outlier: it reaches no identity, social, or
coaching data and holds no actor helper, because an objective engine worker has
no user to act for.

## Adding a table to a target schema

A feature migration that creates a table there must, in the same migration:

1. grant the runtime roles that need it, by name and by privilege — `grant all`
   is never correct;
2. `enable` **and** `force` row level security when the table holds tenant rows,
   and write policies with both `using` and `with check`;
3. index every foreign-key column and every column an RLS policy reads —
   `platform:database` enforces the foreign-key half and fails the build on an
   unindexed one, in any of the eight schemas;
4. comment the table and every ambiguous nullable column.

Shared catalogues and caches that hold no tenant rows use explicit grants
instead of an actor predicate; `ops.schema_catalogue` is the worked example.

### Functions need an explicit revoke

PostgreSQL grants `PUBLIC` `EXECUTE` on every new function. Migration 0012
removes that for anything `forma_migrator` creates with:

```sql
alter default privileges for role forma_migrator revoke execute on functions from public;
```

Measured on PostgreSQL 17.6, the production server version: the **database-wide**
form above persists in `pg_default_acl` and works. The otherwise identical
`... in schema private revoke execute ...` form is **silently discarded** — the
catalogue row is never written and the next function created is `PUBLIC`
executable. Do not use the schema-scoped form, and do not assert this property
by reading `pg_proc.proacl`: the browser-denial gate proves it by creating a
function after the migration and being refused.

Every shipped function also carries its own `revoke all ... from public`, so the
guarantee does not rest on the default alone. Keep that convention.

## Actor context

```sql
begin;
select private.set_actor_context($verified_user_id);
-- statements
commit;
```

`set_config(..., true)` is transaction-local, so a pooled connection cannot
carry an actor from one request into the next; the gate proves that on a single
shared backend. `private.current_actor_id()` returns `null` when nothing is
bound or when the setting is malformed, so an unset context denies rather than
widens.

**This is defence in depth, not authentication.** PostgreSQL lets any connected
role set a custom setting directly, so `forma.actor_id` proves only what the
process that set it knew. Two things make it safe:

- the API sets only an actor it verified from the request's JWT, and E03 owns
  that verification;
- a policy always combines the actor with the connecting role's grants, which is
  why `forma_stockfish` receives neither the helper nor `private`.

Never write a policy that treats "an actor is set" as sufficient.

## Connection budget

Cloud Run scales past the database long before it scales past its own limits, so
`max instances` is derived from the budget in `server/src/platform/connection.ts`
and not the other way round. `npm run platform:unit` fails if the arithmetic
stops holding.

| | connections |
| --- | --- |
| Instance maximum | 60 |
| Supabase internals (auth, storage, realtime, pooler admin, autovacuum) | −12 |
| Migration job on the direct endpoint | −3 |
| Operator headroom during an incident | −2 |
| **Available to services** | **43** |
| `forma-api` — 6 instances × 3 | 18 |
| `forma-ops` — 2 × 2 | 4 |
| `forma-ingestion` — 4 × 2 | 8 |
| `forma-stockfish` — 6 × 1 | 6 |
| `forma-analysis` — 3 × 2 | 6 |
| **Allocated at peak** | **42** |

Every runtime service connects through the Supavisor transaction pooler on port
6543 with prepared statements disabled; E01's startup gate already refuses a
deployed API configured any other way. Raising a service's `max instances` or
pool size means re-deriving this table first — one connection of headroom is all
that is left.

## Recovery and rollback

There is no destructive rollback. Repair is forward:

1. Re-run `npm run db:migrate` as `forma_migrator`. If drift is inside 0012's
   scope — a revoked grant, a dropped policy, a deleted catalogue row, a stray
   grant to `anon` — clear the journal row for `0012_e02_platform_foundation`
   from `drizzle.__drizzle_migrations` and re-run; the SQL converges. The gate
   proves this against exactly those four kinds of damage, and proves the
   migration role can do it with the grants 0012 gave it.
2. If drift is outside 0012's scope, write a new forward migration. Never edit
   a committed migration and never hand-apply DDL: 0012 is the one migration
   authority for these objects, and a hand-applied change is invisible to it.

## Gates

```
cd server && npm run platform:unit        # offline: connection budget
cd server && npm run platform:database    # 25 checks against a real PostgreSQL
```

`platform:database` needs a disposable PostgreSQL and refuses anything that is
not one. Either set `FORMA_TEST_DATABASE_URL` to a loopback server it may create
databases in, or put `initdb`/`pg_ctl` on `PATH` or in `FORMA_PG_BINDIR` and it
will start and stop its own cluster. It creates the Supabase role set first, so
the exclusion checks are real rather than vacuous.

## Observability

Log, per migration run: the applied tag, the role that applied it, and the
duration. Monitor, per role: connection count against the budget row above, and
alert before a service reaches its allocation rather than when it exhausts the
instance. Authorization outcomes are logged as the SQLSTATE and the role, never
the actor id or the row.
