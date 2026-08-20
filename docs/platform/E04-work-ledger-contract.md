# E04 — durable work ledger, outbox, leases, and Cloud Tasks dispatch

Status: implemented on `epic/e04`
Migration: `server/drizzle/0014_e04_work_ledger.sql`
Sources: platform audit §§4 A-03, 5, 7–8; platform spec §§7–8, 16, 19–20;
API contract §§2.1, 6, 15; database architecture §14, §28 Q10, §30;
delivery plan §§1, 3/E04, 8, 10

---

## 1. What E04 ships, and what it deliberately does not

It ships the durable record of work: `ops.workflows`, `ops.work_items`,
`ops.work_item_dependencies`, `ops.work_attempts` and `ops.outbox_events`; the
transactional creation, dispatch, conditional claim, lease, heartbeat, retry,
cancellation, dead-letter and recovery paths over them; `/v1/workflows`; and the
private `/internal/v1` dispatch, recovery and worker endpoints with a Cloud
Tasks transport whose message carries only identity and trace metadata.

It does not ship a business handler. Provider sync, Stockfish and analysis
handlers are named scope for later epics, and the registry in
`src/ops/handlers.ts` is the boundary they plug into. A message routed to a
deployment that has not registered its task type is dead-lettered as
`unsupported`, which is a routing bug an operator can see rather than a silent
success in a process that had no business doing the work.

It does not deploy the ops or worker services. E05 owns that. Until then the one
production workflow — the shadow beside the legacy import pipeline — is
`in_process`, and the private surface is mounted only where its configuration is
present.

## 2. State machines

Workflow: `queued`, `running`, `succeeded`, `failed`, `cancelling`, `cancelled`.
Work item: `blocked`, `ready`, `leased`, `succeeded`, `retry_wait`, `dead`,
`cancelled`.

Terminal states are `succeeded`/`failed`/`cancelled` and
`succeeded`/`dead`/`cancelled`. A terminal state never becomes nonterminal.
That is enforced twice: `src/ops/state.ts` refuses the transition and names both
ends, and `ops.guard_workflow_transition()` / `ops.guard_work_item_transition()`
raise on it in the database. Neither is redundant — the trigger cannot say why a
transition was wrong, and the transition table cannot stop a statement written by
a future call site.

Workflow state is *derived* from the items, never tracked by a counter a worker
increments. `deriveWorkflowState` reads a per-status tally the database produces
with one aggregate, so a workflow holding hundreds of items still settles in a
single round trip.

Cancellation is cooperative. A request stops every `blocked`, `ready` and
`retry_wait` item at once and leaves a leased attempt to finish its bounded unit;
the workflow sits in `cancelling` until it does. A workflow whose items all
succeeded before the request landed settles as `succeeded`, because API contract
§6 says cancellation does not undo already published facts.

## 3. Progress

`completedWeight` is the weight of succeeded items; `totalWeight` is the weight
of every item that is not cancelled. `percent` is `null` when the total is zero,
which is §2.1's "null when total work is not yet known" rather than a `0` that
claims knowledge.

Cancelled items leave both numerator and denominator, so cancelling outstanding
work can only raise the percentage — progress is monotonic. Dead items stay in
the denominator, so a failed workflow stalls below 100% instead of reporting
completion it never reached.

## 4. Retry classification and backoff

Classes, from platform spec §8: `transient`, `rate_limit`, `invalid_input`,
`unsupported`, `unauthorized`, `budget`, `permanent`. Only `transient` and
`rate_limit` schedule another attempt; everything else is dead on the first
failure, because an unsupported variant is unsupported on the fifth attempt too.

Backoff is exponential (transient: 2s base, 15 min cap; rate limit: 60s base per
§7's ">=60s" rule, 30 min cap) with a jitter spread of up to 25%. The spread is
derived from an HMAC of the item identity and attempt number rather than
`Math.random()`, so a hundred items failing on one provider outage do not return
together *and* a failed attempt stays reproducible in an incident review. A
provider's `Retry-After` raises the delay but never past the policy ceiling, and
a `Retry-After: 0` does not licence an immediate retry.

The next attempt time is a column, not a timer: `available_at` survives the
process that scheduled it.

## 5. Dispatch, delivery, and the attempt token

Creation writes the workflow, its items, its dependency edges and the outbox rows
in one transaction. That is the whole "a committed command cannot be lost"
claim: a process that dies between commit and dispatch leaves the row for the
next dispatcher.

The dispatcher runs three transactions with the network call between them —
claim a batch (pushing `available_at` forward, so the claim is the lease), create
the tasks outside any transaction, record the outcome. A crash between the second
and third redelivers the row and recreates the task under the same deterministic
name, which Cloud Tasks refuses with `ALREADY_EXISTS`; that is counted as a
duplicate, not an error.

The queue message is exactly `workItemId`, `attemptToken` and `traceparent`.
`assertMinimalTaskPayload` refuses anything else, and the dispatcher runs it on
every message — a guard rather than a comment, because the way a PGN reaches a
queue is someone adding a "small" field to a builder in an unrelated epic.

`attemptToken` is an HMAC over the work item and its **dispatch epoch**. The
epoch increments whenever an item is made ready again (retry, recovery,
dependency release), so a superseded message identifies itself and is
acknowledged without executing. The token is not authentication — the caller is
authenticated by Google-signed OIDC at the ingress — it says *which attempt this
delivery is for*, and the conditional claim is what actually stops two workers
running the same item.

An outbox row whose item has moved on is `superseded`, not `dead`: a supersession
is not a dead letter and must not be counted as one.

## 6. Claiming, leases and acknowledgement

A claim locks the workflow, then the item; checks the presented token against the
epoch the row currently carries; and updates conditionally on the status it read.
Twenty simultaneous deliveries of one message produce exactly one claim and
exactly one attempt row (proven in the performance gate).

Lock ordering is stated once and followed everywhere: **workflow first, then work
items**. Cancellation naturally starts at the workflow and completion naturally
starts at the item, so without a stated order those paths would take the same
pair of locks in opposite directions and deadlock under exactly the concurrency
this epic exists to support. Lease recovery therefore reads its candidates
without a lock and settles each one in its own short transaction.

Acknowledgement follows the commit. Every `executeWorkItem` outcome that becomes
a 204 has already committed an authoritative transition or established that there
is none to make. A delivery that arrives before `available_at` is answered
`503 WORK_NOT_READY` with `Retry-After`, so the transport holds it.

Lease expiry reconciles before it retries. Platform spec §8: "lease expiry does
not imply side effects did not occur; retry rechecks output." An item that
recorded an `output_ref` before its process died *did* the work, so recovery
completes it; only an item with no output is requeued, and its abandoned attempt
is closed as `abandoned` rather than rewritten.

## 7. Dependencies

Edges live in `ops.work_item_dependencies` and may only point at a *lower*
identity. Identities are assigned in creation order, so no sequence of inserts
can close a cycle — the DAG constraint is structural, not a trigger.

An item that succeeds releases every blocked dependent whose upstream items have
all succeeded, giving each a new epoch and an outbox row. An item that dies takes
its blocked descendants with it, transitively, marked `dead` with
`dependency_failed`. Without that cascade a dead item leaves its dependents
blocked forever: the workflow never settles, the owner watches a bar that never
moves, and no alert fires because nothing failed. They are `dead` rather than
`cancelled` on purpose — cancelled work leaves the progress denominator, and a
workflow showing 100% because the rest of it can never run would be a lie.

## 8. API surface

`GET /v1/workflows`, `GET /v1/workflows/{workflowId}`,
`POST /v1/workflows/{workflowId}/cancel` — the three endpoints API contract §6
names, and no endpoint that exposes items, attempts, payloads or lease state.

Ownership is an argument, not a filter a handler remembers to apply:
`readWorkflow` and `listWorkflows` have no overload that omits the owner. A
workflow belonging to someone else is reported exactly as one that does not
exist — same status, same body — and the denial is audited as
`workflow.access_denied`.

The single-workflow read is ETagged with `private, max-age=0, must-revalidate`,
so a client polling a running workflow gets 304s rather than repeated bodies.
The list is `private, no-store`.

`progress.message` is `null`. §2.1 gives progress a human message and E04 has no
copy to put in it; `stage` carries the task type of the oldest outstanding item,
which is a fact.

## 9. The private surface

`/internal/v1` under private ingress, Google-signed OIDC, and two disjoint
service-account allowlists:

| Endpoint | Allowlist |
| --- | --- |
| `POST /internal/v1/work-items/{id}/execute` | worker |
| `POST /internal/v1/outbox/dispatch` | ops |
| `POST /internal/v1/work-items/recover-leases` | ops |
| `GET /internal/v1/ready` | either |

Verification is ours as well as the platform's, because "private ingress will
stop the wrong caller" stops being true the first time someone opens it to debug
something. The token's issuer, audience, signature, `email_verified` and exact
service-account address are all checked, and the account comes from the verified
claim rather than from a header.

These routes get no browser CORS, no `Deprecation` header, and no entry in the
OpenAPI document: §15 is a contract between our own deployments, and publishing
it in the document a browser client generates from would advertise the surface
that has no browser authentication.

They declare `idempotency: "ledger"`, the one exception to the kernel's rule that
every command carries an `Idempotency-Key`. Cloud Tasks has no key to offer and
needs none — the duplicate it will eventually deliver is stopped by the
conditional claim, which is a stronger guarantee than a header. The registry
*asserts* that the exception is only reachable on an internal route, because the
value of the `/v1` rule is that it has no exceptions.

## 10. Grants and roles

No runtime role holds `delete` on any ledger table. A workflow, an item, an
attempt and an outbox row are the evidence that committed work existed, and the
rollback contract is forward recovery.

| Role | workflows | work_items | dependencies | attempts | outbox |
| --- | --- | --- | --- | --- | --- |
| `forma_api` | s,i,u | s,i,u | s,i | s,i,u | s,i |
| `forma_ops` | s,i,u | s,i,u | s,i | s,i,u | s,i,u |
| workers | s,u | s,u | s | s,i,u | s,i |

Only `forma_ops` updates the outbox, because only it dispatches. Workers cannot
create work, only progress it.

`forma_api` holds insert and update on `ops.work_attempts` for one reason that is
a fact about today rather than a design: the legacy analysis pipeline still runs
inside the API process (audit §4 A-03), so that process is currently also a
worker. E05 moves the runner to its own deployment; those two grants are what to
drop when it does.

RLS is enabled and forced on all five tables. As with E03's operational tables
the policies carry no actor predicate — these are not tenant-partitioned tables,
and tenancy is the API's actor→subject check against `owner_profile_id`. No
browser role holds any privilege on any of them, which the security gate proves
by connecting as `authenticated` and being refused by PostgreSQL itself.

E04 also widened `inspectRuntimeConfig` to accept any of E02's five deployment
roles rather than `forma_api` alone. E01's finding was that the runtime connected
as the *owner*; `postgres` and `forma_migrator` are still refused, as are the
browser roles. Without this the ops and worker deployments these endpoints belong
to could not have started at all.

## 11. Migration, rollout, reconciliation and rollback

`0014` is additive and forward-only: five new tables, three guard functions, one
foreign key with its index, and no change to any existing row. It runs inside one
transaction, so an interrupted deploy is a rollback and forward recovery is
simply running it again. The migration gate proves it from empty, from the
production-shaped state `0013` leaves, twice in a row, and after a simulated
interruption — and proves that a re-run keeps rows written since the first one.

**Shadow.** `createImport` now writes a `game_import` workflow with one
`in_process` work item inside the transaction that creates the
`analysis_imports` row. If that write fails, the import fails — a durable record
of a committed command is not best-effort. Afterwards `mirrorImportStatus` drives
that item through the ordinary claim/heartbeat/complete/fail API as the legacy
run progresses; that half only observes, and logs rather than failing, because
the legacy pipeline is still the executor and a lagging mirror must not take a
user's analysis down with it.

**Reconciliation.** `npm run ops:reconcile` prints legacy import count, shadow
count, missing shadows and state disagreements, with up to ten example
identifiers. It reads and never repairs: a reconciliation that quietly fixed what
it measured could not be used to decide whether a cutover is safe. It exits
non-zero when anything disagrees.

**Rollback.** Dispatch routing is a column. Setting `dispatch_mode = 'in_process'`
(and clearing `queue`) on newly created items returns work to a co-located runner
while every committed row and every attempt stays exactly where it is. There is
no destructive rollback of `0014`; reversing it is a paired forward migration.

## 12. Observability

Structured ops events, closed field list, serializer that knows only those
fields — the same discipline as the request log, for the same reason.

| Event | Answers |
| --- | --- |
| `work_item_transition` | attempts, retry class, duplicate delivery, cancellation, trace continuity |
| `workflow_state` | workflow/item state and progress |
| `outbox_dispatch` | dispatch lag, duplicates, supersessions, dead letters, pending depth |
| `work_depth` | §19's queue depth and oldest ready-item age **by class** |
| `lease_recovery` | lease expiry, reconciliation, requeue, dead letters |

Absent by construction: payloads, input references, owners, emails, provider
bodies, task URLs. The security gate asserts that no forbidden key can reach a
line even when a caller passes one.

`work_depth` is the query `work_items_claim_idx` exists for — database
architecture §28 Q10's partial composite index over ready work, by resource
class. The in-process pull claim has its own narrower partial index; the
performance gate asserts both plans rather than assuming them.

## 13. Budgets and thresholds

Measured on a disposable local cluster with 20,000 items across 400 workflows.
Wall-clock references are reported, never asserted — a shared runner's tail is
noise, not a regression.

| Measure | Reference | Observed p50/p95 |
| --- | --- | --- |
| conditional claim by identity | 25 ms | 44 / 71 ms |
| in-process claim scan | 25 ms | 0.5 / 1.1 ms |
| workflow read with derived progress | 25 ms | 0.7 / 0.8 ms |
| workflow page of 25 | 40 ms | 1.0 / 1.4 ms |
| outbox claim of 100 | 60 ms | 1.3 / 2.1 ms |

The claim is ~9 round trips (lock ordering costs one extra read on purpose), so
its absolute number is round-trip bound rather than index bound.

Blocking thresholds — the ones noise cannot fake:

- the claim's cost must not grow more than **5×** between a near-empty ledger and
  a production-shaped one, measured in the same run so the environment cancels
  out (observed: 1.6×);
- the queue-depth, in-process claim, lease recovery and outbox claim queries must
  use their partial indexes;
- exactly **one** of twenty simultaneous deliveries may claim an item, and twenty
  scanning workers may never take the same item twice;
- a service must hold no more backends than its `SERVICE_BUDGETS` pool allows.

## 14. Test contract

| Gate | Command | Proves |
| --- | --- | --- |
| unit | `npm run ops:unit` | state machines, progress, retry arithmetic, token binding, payload minimality, vocabulary/DDL agreement |
| integration | `npm run ops:integration` | commit→dispatch→deliver→acknowledge, duplicates, retries, dead letters, the DAG, cancellation, lease recovery, the shadow, dispatch failure |
| security | `npm run ops:security` | ownership, anonymous/cross-account/revoked callers, OIDC forgeries, allowlist separation, forged attempt tokens, grants, RLS, redaction |
| migration | `npm run ops:migration` | empty, prior-state, repeat, partial failure, constraint enforcement, routing rollback |
| performance | `npm run ops:performance` | index use, growth ratio, claim exclusivity, connection budget |

All five run only against a disposable PostgreSQL: they create roles, log in with
a synthetic password, and probe denied privileges. The harness refuses a
non-loopback target.

## 15. Decisions recorded rather than invented

- **Queue naming is a column, not a derivation.** Platform spec §7 splits
  ingestion per provider, which is a property of the job rather than of the
  capability that runs it. Deriving a queue from `resource_class` would have
  meant inventing a routing rule the spec states per queue, so the creator of
  the work names it and a check constraint holds it to §7's six names.
- **Q10's `queued` is this schema's `ready`.** §14.2's vocabulary renamed it. The
  index keeps §28 Q10's shape and predicate.
- **`superseded` is a fourth outbox state.** Marking a message for work that
  moved on as `published` would be false and as `dead` would corrupt the
  dead-letter signal.
- **An unknown retry class reads as `transient`.** A worker reporting a class we
  do not know is a bug in the worker, and the safe reading of "I do not know why
  this failed" is one that retries under the attempt ceiling rather than
  abandoning the work.
- **`::text::jsonb`, not `::jsonb`.** postgres.js reads the trailing cast to pick
  a serializer, and a bare `::jsonb` makes it JSON-encode a string we already
  encoded — storing `"{}"` instead of `{}`. E03's audit and idempotency writes
  were hardened the same way.
