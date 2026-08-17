# E04 — work ledger runbook

Operational companion to `E04-work-ledger-contract.md`. What changed, how to
apply it, how to read it, and how to undo the part that can be undone.

## 1. What changed operationally

- Five new tables in `ops`: `workflows`, `work_items`, `work_item_dependencies`,
  `work_attempts`, `outbox_events`. Nothing existing was altered except the E03
  idempotency table, which gained a foreign key and its index.
- `POST /imports/*` (legacy) now writes a shadow `game_import` workflow in the
  same transaction as the import row. If the ledger is unreachable, creating an
  import fails — deliberately.
- A new private surface, `/internal/v1`, mounted **only** where its configuration
  is present. The API deployment does not set those variables, so the surface is
  absent there rather than present and failing.
- `/v1/workflows` is live: list, read, cancel, owner-scoped.

## 2. Configuration

The private surface and the dispatcher stay off until a deployment is configured
for them. That is the intended state for `forma-api`.

| Variable | Needed by | Notes |
| --- | --- | --- |
| `FORMA_INTERNAL_AUDIENCE` | ops, workers | OIDC audience internal callers must present |
| `FORMA_OPS_SERVICE_ACCOUNTS` | ops, workers | comma-separated; operator allowlist |
| `FORMA_WORKER_SERVICE_ACCOUNTS` | ops, workers | comma-separated; worker allowlist |
| `FORMA_TASKS_PROJECT` | ops | GCP project holding the queues |
| `FORMA_TASKS_LOCATION` | ops | e.g. `europe-west1` |
| `FORMA_TASKS_ENDPOINT` | ops | defaults to Cloud Tasks; a loopback value is an emulator |
| `FORMA_WORKER_BASE_URL` | ops | private base URL tasks call |
| `FORMA_TASKS_INVOKER_SERVICE_ACCOUNT` | ops | required for any non-loopback endpoint |

`GET /internal/v1/ready` reports `dispatch: "unconfigured"` rather than failing,
so a deployment that is meant to serve work but not dispatch it looks correct
instead of broken.

E05 owns the Cloud Run services, the Cloud Scheduler jobs (`outbox/dispatch`
every minute, `work-items/recover-leases` every five) and the IAM bindings that
make these allowlists meaningful.

## 3. Applying the migration

```bash
export DATABASE_URL="$(/home/nericarcasci/forma-automation/bin/forma-db-url.sh)"
cd server && npm run db:migrate
```

The helper returns the session-mode pooler; the runbook's direct endpoint is
IPv6-only and unreachable from this host. Do not rewrite it to port 6543.

`0014` runs in one transaction. An interrupted run rolls back; recovery is
running it again. Verify afterwards rather than assuming:

```sql
select table_name from information_schema.tables
 where table_schema = 'ops' order by table_name;

select count(*) from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'ops' and not t.tgisinternal;   -- expect 3

select grantee, table_name, privilege_type
  from information_schema.role_table_grants
 where table_schema = 'ops' and privilege_type = 'DELETE'
   and grantee <> 'forma_migrator';                -- expect zero rows
```

## 4. Rollback

There is no destructive rollback. The ledger holds the record that committed
work existed, and removing it is exactly what the epic forbids.

What *is* reversible is dispatch routing:

```sql
-- Return newly created work to the co-located runner. Rows and attempt
-- history are untouched; only the transport changes.
update ops.work_items
   set dispatch_mode = 'in_process', queue = null
 where status in ('blocked', 'ready', 'retry_wait') and dispatch_mode = 'queue';
```

Pending outbox rows for those items become `superseded` on the next dispatch
pass. To stop dispatching entirely, remove `FORMA_TASKS_*` from the ops
deployment: the endpoint then answers `503` instead of marking rows published
that no queue received.

Reverting the code without reverting the migration is safe — the tables are
additive and nothing else reads them.

## 5. Reconciliation

```bash
cd server && npm run ops:reconcile
```

Prints legacy import count, shadow count, missing shadows, state disagreements
and up to ten example identifiers. Exits non-zero when anything disagrees. It
never repairs.

Expected reading after this epic deploys: `missingShadow` equals the number of
imports created *before* the migration (they predate the shadow and are not
backfilled — backfilling would invent a workflow for work nobody recorded), and
`stateDisagreements` is zero. Both figures are stable, so a rise is a signal.

Baseline recorded immediately after `0014` was applied to
`oqsjfmgdovvepncbphvk`:

    legacyImports 33, shadowWorkflows 0, missingShadow 33, stateDisagreements 0

`missingShadow` therefore stays at 33 and every import created from now on adds
one to both `legacyImports` and `shadowWorkflows`. A `missingShadow` above 33 is
an import that committed without its ledger record, which should be impossible —
they share a transaction — and is worth an incident.

## 6. Reading the ledger

Ordinary questions, as queries. None of these needs a payload.

```sql
-- Queue depth and oldest ready work, by capability.
select resource_class, count(*) as ready,
       max(extract(epoch from (now() - available_at)))::int as oldest_seconds
  from ops.work_items where status = 'ready' group by resource_class;

-- Dispatch lag: committed work nothing has been sent for yet.
select count(*) as pending,
       max(extract(epoch from (now() - available_at)))::int as oldest_seconds
  from ops.outbox_events where state = 'pending' and available_at <= now();

-- Dead letters, and why.
select error_class, error_code, count(*) from ops.work_items
 where status = 'dead' group by 1, 2 order by 3 desc;

-- Leases that are about to be recovered.
select id, workflow_id, lease_owner, lease_expires_at from ops.work_items
 where status = 'leased' and lease_expires_at < now() + interval '1 minute';

-- Why one workflow failed, without reading anyone's data.
select i.id, i.task_type, i.status, i.error_class, i.error_code,
       a.attempt_number, a.deployment, a.outcome, a.trace_id
  from ops.work_items i left join ops.work_attempts a on a.work_item_id = i.id
 where i.workflow_id = $1 order by i.id, a.attempt_number;
```

## 7. Structured events

One JSON line per occurrence, on stdout, with a closed field list.

| Event | Watch for |
| --- | --- |
| `outbox_dispatch` | `pending` climbing, `oldestPendingAgeSeconds` above a minute, any `deadLettered` |
| `work_depth` | `oldestReadyAgeSeconds` climbing for one `resourceClass` |
| `work_item_transition` | `duplicateDelivery: true` becoming common, `retryClass` concentrating |
| `lease_recovery` | `requeued` climbing (workers dying), `reconciledSucceeded` climbing (workers dying *after* doing the work) |

Alerts worth setting when E05 wires monitoring, each with an owner and this
runbook as its link:

- oldest pending outbox row older than 5 minutes — dispatch is not running;
- oldest ready item of any class older than 15 minutes while dispatch is healthy
  — no worker is consuming that queue;
- any outbox row in `dead` — a message that will never be sent;
- dead-lettered work items rising above baseline;
- duplicate deliveries rising sharply — usually a queue retrying because a
  worker is timing out rather than answering.

`superseded` is not a failure and should not alert.

## 8. Running the gates

```bash
cd server
npm run ops:unit           # offline
npm run ops:integration    # disposable PostgreSQL + loopback Cloud Tasks
npm run ops:security       # disposable PostgreSQL; creates roles
npm run ops:migration      # disposable PostgreSQL; creates databases
npm run ops:performance    # disposable PostgreSQL; ~20k seeded rows
```

Four of the five need a disposable server. Point them at one with
`FORMA_TEST_DATABASE_URL`, or put `initdb`/`pg_ctl` on `PATH` or in
`FORMA_PG_BINDIR`. They create roles, log in with a synthetic password and
deliberately probe denied privileges, so they must never target the live project
— the harness refuses a non-loopback host on purpose.

## 9. Operating notes

- **A committed command cannot be lost, but it can be undelivered.** If the
  dispatcher is down, work sits in `ops.outbox_events` and nothing is dropped.
  Restarting the dispatcher drains it.
- **A duplicate delivery is normal.** Cloud Tasks is at-least-once. The claim is
  what makes the effect once, and `duplicateDelivery` in the logs is expected at
  a low rate.
- **An expired lease does not mean the work did not happen.** Recovery checks the
  output reference first and completes the item if it landed. Never requeue by
  hand without checking `output_ref`.
- **Do not edit a terminal row.** The triggers will refuse, and that refusal is
  the invariant working.
- **Do not add a field to a queue message.** `assertMinimalTaskPayload` will
  throw, which is cheaper than discovering a PGN in a queue.
