# E03 — `/v1` API kernel runbook

Scope: `server/src/v1/**`, `server/drizzle/0013_e03_api_kernel.sql`,
`server/openapi/v1.json`, and the kernel wiring in `server/src/index.ts` and
`server/src/auth.ts`. The frozen contract is
[`E03-api-kernel-contract.md`](./E03-api-kernel-contract.md).

## 1. What changed operationally

- `/v1` is mounted beside the unversioned routes. Four routes ship:
  `GET /v1/openapi.json`, `GET /v1/public/stats`, `GET /v1/public/plans`,
  `POST /v1/public/beta-signups`. No frontend route calls them yet; the shipped
  client still uses the legacy paths, unchanged.
- Every unversioned route now answers with `Deprecation: true`, a `Sunset` date,
  and — where a successor exists — a `Link: <...>; rel="successor-version"`.
  Bodies and statuses are byte-for-byte as they were.
- Token verification moved from a Supabase round trip per request to a local
  JWKS check, for `/v1` **and** for the legacy routes, which share the verifier.
  Supabase `getUser` remains the fallback for legacy symmetric tokens and for
  routes that declare `revocationSensitive`.
- Three new `ops` tables: `idempotency_records`, `audit_events`,
  `rate_limit_counters`. All additive; nothing existing was altered.
- Rate limiting for public endpoints is now shared across instances instead of
  per-process.

## 2. Required configuration before deploying this branch

One new secret:

| Variable | Value | Where |
| --- | --- | --- |
| `FORMA_API_SIGNING_KEY` | ≥ 32 bytes of random data | Secret Manager reference on the Cloud Run service |

Generate with `openssl rand -base64 48`.

**A deployed process without it refuses to start.** That is deliberate: the key
signs pagination cursors, idempotency digests, and rate-limit subject keys, and
a process that silently fell back to a per-instance random key would issue
cursors that stop verifying the moment it scaled or restarted. The failure is a
`KernelConfigError` with code `API_SIGNING_KEY_MISSING`, logged through the
redaction layer and never carrying the value.

Rotating the key is safe and has two visible effects, both recoverable without
data loss:

- outstanding cursors stop verifying — a caller receives
  `400 VALIDATION_FAILED` with `errors[0].code = CURSOR_INVALID` and restarts
  the list;
- in-flight idempotency digests no longer match — a retry after rotation is
  treated as a new command rather than a replay. Rotate during a quiet period
  if that matters, or accept it: the window is the 24-hour record TTL.

## 3. Applying the migration

```bash
export DATABASE_URL="$(/home/nericarcasci/forma-automation/bin/forma-db-url.sh)"
cd server && npm run db:migrate
```

The helper returns the session-mode pooler; the runbook's direct endpoint is
IPv6-only and unreachable from the automation host. Do not rewrite it to 6543.

Then verify rather than assume:

```sql
select c.relname, pg_get_userbyid(c.relowner) as owner,
       c.relrowsecurity as rls, c.relforcerowsecurity as forced,
       coalesce(array_to_string(c.relacl, ' | '), '(owner only)') as acl
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'ops'
  and c.relname in ('idempotency_records','audit_events','rate_limit_counters');
```

Expected on the live project (verified 2026-08-17):

| Table | Owner | RLS | Forced | `forma_api` |
| --- | --- | --- | --- | --- |
| `idempotency_records` | `forma_migrator` | yes | yes | `arw` (insert, select, update) |
| `audit_events` | `forma_migrator` | yes | yes | `ar` (insert, select) — append only |
| `rate_limit_counters` | `forma_migrator` | yes | yes | `arwd` |

No `anon`, `authenticated`, `service_role`, or `PUBLIC` entry appears on any of
them. `forma_api` deliberately holds no `update` or `delete` on `audit_events`:
the process that writes an audit row cannot rewrite it.

## 4. Rollback

Revert the deployment image. That is the whole rollback.

The three `ops` tables stay. They are additive, nothing reads them except the
kernel, and they hold idempotency and audit evidence that this epic forbids
deleting as part of a rollback. If they ever have to go, that is a reviewed
forward migration, not a rollback step.

There is no data to reconcile: `0013` transforms nothing and backfills nothing.

## 5. Reading the request log

One line per request, `"event":"http_request"`, with a closed field set:

```json
{"event":"http_request","requestId":"req_…","traceId":"…","route":"/v1/public/stats",
 "method":"GET","status":200,"durationMs":4,"surface":"v1","authMode":"jwks",
 "actorPresent":false,"problemCode":null,"idempotency":"none","cursorRejected":false,
 "rateLimit":"ok","redactions":0,"deprecated":false}
```

`route` is the registered template, never the concrete path, so identifiers stay
out of logs and metric cardinality stays bounded. The line carries no token, no
email, no request body, no client address, no actor id, and no exception text —
by construction, because the serializer only knows about these fields.

Useful queries:

| Question | Filter |
| --- | --- |
| Is anything still calling a legacy route? | `deprecated:true`, group by `route` |
| Are tokens failing to verify? | `problemCode:"AUTH_REQUIRED"`, group by `route` |
| Did JWKS rotation break local verification? | `authMode:"fallback"` rising on `/v1` |
| Is the counter store degraded? | `rateLimit:"degraded"` |
| Are clients sending stale cursors? | `cursorRejected:true` |
| Are duplicate commands arriving? | `idempotency` in `replayed`, `conflict`, `in_progress` |

## 6. Alerts worth setting when E05 wires monitoring

Not created here — E03 owns no dashboard infrastructure — but these are the
thresholds the fields above were chosen to support:

| Signal | Threshold | Why it matters |
| --- | --- | --- |
| `authMode:"fallback"` on `/v1` | > 5% of authenticated requests over 15 min | JWKS fetch is failing; every request is paying a Supabase round trip |
| `rateLimit:"degraded"` | any sustained occurrence | the counter store is unreachable; commands are failing closed |
| `problemCode:"INTERNAL_ERROR"` | > 0.5% of requests over 15 min | a handler is throwing something the kernel had to swallow |
| `idempotency:"conflict"` | a sustained rise | a client is reusing keys across different requests |

## 7. Operating notes

**JWKS rotation.** Supabase rotating its signing key is handled without a
deploy: the cached key set is refetched when an unknown `kid` appears, at most
once per 30 s. During the gap those requests fall back to `getUser` and still
succeed. Watch `authMode` for a brief `fallback` spike, then a return to `jwks`.

**Idempotency records.** They expire 24 hours after creation. Nothing sweeps
them yet — `forma_ops` holds the `delete` grant for when E05 lands its retention
sweeps. At current volumes the table is small; the index on `expires_at` is what
that sweep will use.

**Rate-limit counters.** Expired rows are removed opportunistically, on roughly
one request in fifty, so this table needs no sweeper of its own.

**A degraded counter store fails closed for commands and open for reads.** If
`/v1/public/beta-signups` starts returning `429` with `rateLimit:"degraded"` in
the log, the database is the problem, not an attack.

## 8. Running the gates

```bash
cd server
npm run v1:unit             # 50 offline checks
npm run v1:openapi:check    # the committed document matches the registry
```

The remaining four need a disposable PostgreSQL. Point `FORMA_TEST_DATABASE_URL`
at a throwaway loopback server, or put `initdb`/`pg_ctl` on `PATH` or in
`FORMA_PG_BINDIR`:

```bash
npm run v1:migration        # empty, prior state, repeat, partial failure, recovery
npm run v1:integration      # the kernel through real HTTP and database boundaries
npm run v1:security         # forged tokens, cross-subject denial, grants, log hygiene
npm run v1:performance      # the §11 budgets, with the numbers printed
```

The harness refuses a non-loopback or Supabase-hosted target on purpose. These
four create databases and roles and log in with a synthetic password; none of
them may ever point at the live project.

CI runs all six in `.github/workflows/e03-api-kernel.yml`, using a PostgreSQL
service container as the disposable target.

## 9. Regenerating the OpenAPI document

```bash
cd server && npm run v1:openapi
```

Only after changing a route declaration. `npm run v1:openapi:check` fails the
build when the committed file and the registry disagree, which is what keeps the
document from becoming a hand-maintained artifact.
