# E03 — `/v1` API kernel and authorization contract

Status: frozen for implementation (FOR-36)
Authorities: `plans/v1-api-contract.md` §§1–2, 6, 15–16; `plans/v1-platform-spec.md`
§§6.1, 8, 16–17, 20, 22; `plans/database-architecture.md` §§3.5, 7, 14.7–14.8, 25;
`plans/v1-platform-audit.md` §§5, 7, 10; `plans/v1-delivery-plan.md` §§1, 3/E03, 8, 10

This document freezes the decisions an implementation must not re-invent. Where a
canonical plan already states a rule, this document points at it rather than
restating it; what follows is the part the plans leave to the kernel.

---

## 1. What E03 ships, and what it deliberately does not

E03 delivers the kernel — the middleware and libraries every later `/v1` endpoint
composes — plus the smallest real `/v1` surface that exercises it in production.

Shipped `/v1` routes:

| Route | Kind | Why it is E03's and not a later epic's |
| --- | --- | --- |
| `GET /v1/openapi.json` | public read | The generated contract document itself. |
| `GET /v1/public/stats` | public read | API contract §3; assigned to no later epic. Proves envelope, ETag, caching. |
| `GET /v1/public/plans` | public read | API contract §3; the display catalogue, not billing state (E19 owns `/v1/billing/*`). |
| `POST /v1/public/beta-signups` | public command | API contract §3, which requires "distributed IP/email abuse controls" — exactly E03's in-scope edge controls. Proves `Idempotency-Key`, 202, problem details. |

Not shipped, on purpose: `/v1/me*`, `/v1/me/accounts*` and the directory
(E06), `/v1/workflows` (E04), `/v1/billing/*` (E19), provider lookup and engine
routes (E08/E12). Migrating a product endpoint or a frontend journey is
explicitly out of scope for this epic; adding `/v1` *beside* legacy is the
required rollout step.

The protected half of the kernel — JWT verification, actor resolution,
actor→subject authorization, `If-Match`, signed cursors — is production code
used by the legacy adapter today and by E06's endpoints tomorrow. It is proven
by integration and security gates that mount the real middleware over a real
disposable PostgreSQL, not by shipping a placeholder protected route.

Legacy unversioned routes keep their exact current bodies and statuses. They gain
`Deprecation`/`Sunset` headers and usage measurement, and their authentication is
re-pointed at the kernel verifier. Nothing about their response shape changes.

## 2. Envelopes

Per API contract §1.2. Frozen kernel details:

- `meta.requestId` is always present, on every success and every problem.
- `meta.redactions` is present only when at least one field was withheld. Each
  entry is `{ "path": "data.foo", "reason": "entitlement" | "projection" }`.
- Collections always carry `page: { nextCursor, hasMore }`; `nextCursor` is
  `null` when `hasMore` is false.
- Claim-bearing reads add the version block from §1.2. The kernel provides the
  type; no E03 route produces one, because E03 publishes no claims.
- Unknown scalars are `null`, known-empty collections are `[]`. The kernel never
  substitutes `0` or `""` for an unknown.

## 3. Problem details

`application/problem+json` per API contract §1.3. The kernel owns a closed code
table; a handler cannot invent a code at runtime.

| Code | Status | Retryable |
| --- | --- | --- |
| `AUTH_REQUIRED` | 401 | no |
| `FORBIDDEN` | 403 | no |
| `NOT_FOUND` | 404 | no |
| `VALIDATION_FAILED` | 400 | no |
| `CONFLICT` | 409 | no |
| `IDEMPOTENCY_CONFLICT` | 409 | no |
| `IDEMPOTENCY_IN_PROGRESS` | 409 | yes, with `retryAfterSeconds` |
| `PRECONDITION_REQUIRED` | 428 | no |
| `PRECONDITION_FAILED` | 412 | no |
| `RATE_LIMITED` | 429 | yes, with `retryAfterSeconds` |
| `ENTITLEMENT_REQUIRED` | 402 | no |
| `PROVIDER_UNAVAILABLE` | 503 | yes |
| `PROVIDER_RATE_LIMITED` | 429 | yes |
| `UNSUPPORTED_GAME` | 422 | no |
| `INSUFFICIENT_COVERAGE` | 409 | no |
| `WORKFLOW_NOT_CANCELLABLE` | 409 | no |
| `INTERNAL_ERROR` | 500 | yes |

§1.3 says "stable codes **include**" its list, so the table is a superset, not a
contradiction. The three additions are `IDEMPOTENCY_IN_PROGRESS` (a duplicate
arriving while the original is still running has no original response to replay
yet, and is not the same event as a digest conflict), `PRECONDITION_REQUIRED`
and `PRECONDITION_FAILED` (the `If-Match` contract of §1.6 has no other honest
status). Adding a code is an additive contract change under platform spec §22.

Rules the kernel enforces:

- `detail` is either a curated string written for the caller or absent. An
  exception message, SQL text, a provider body, or a stack frame never becomes
  `detail`; the existing `server/src/security/redaction.ts` allowlist is the one
  gate, reused unchanged.
- `title` is a fixed phrase per code. `type` is
  `https://docs.formachess.com/problems/<kebab-code>`.
- `instance` is the request path, never the query string (a cursor or an email in
  a query string must not be reflected).
- `errors[]` appears only for `VALIDATION_FAILED`, and each entry is
  `{ path, code, message }` derived from the schema, never from the input value.
- Every problem carries `requestId`.

## 4. Authentication

Per platform spec §6.1. Three auth modes, recorded on every request:

| Mode | When | Cost |
| --- | --- | --- |
| `anonymous` | no bearer token, public route | none |
| `jwks` | token header `alg` ∈ {ES256, RS256} and `kid` resolves in the cached JWKS | local, no network on the hot path |
| `fallback` | legacy HS256 token, unknown `kid` after one bounded refresh, or a route marked revocation-sensitive | one `supabase.auth.getUser` round trip |

Frozen rules:

- Issuer must equal `${SUPABASE_URL}/auth/v1`. Audience must equal
  `authenticated`. `exp` and `nbf` are checked with 5 s clock tolerance; there
  is no "skip expiry" switch.
- `alg: none`, symmetric algorithms presented with an asymmetric `kid`, and any
  algorithm outside the allowlist are rejected outright — never referred to the
  fallback, so a forged header cannot buy a network verification attempt.
- JWKS is cached for 10 minutes. An unknown `kid` triggers at most one refetch
  per 30 s cooldown, shared process-wide, so key rotation is picked up within a
  bounded window without a refetch storm on garbage input.
- JWKS fetch failure does not fail open. With a warm cache the kernel keeps
  serving from it; with a cold cache the request is referred to the fallback,
  and if that also fails the request is `AUTH_REQUIRED`.
- Only the token's *digest* is used as a cache key. A raw bearer token is never
  a map key, a log field, or an error argument. (Audit §10 finding: the current
  cache keys on the raw token.)
- Revocation: local verification cannot see a revoked session, so a route may
  declare `revocationSensitive`, which forces `fallback`. E03 ships no such
  route; the flag exists because E06's destructive account routes need it.

## 5. Authorization context

```ts
interface AuthorizationContext {
  actorId: string;        // Supabase auth.uid() — never client-supplied
  profileId: string;      // profiles.id; equal to actorId in v1
  email: string | null;
  plan: "free" | "pro";
  authMode: "jwks" | "fallback";
  subjects: readonly string[];  // subject ids this actor may act on
}
```

Frozen rules:

- The client never supplies `userId`, `profileId`, `subjectId`, or any other
  identity. A request body or query string containing one is a
  `VALIDATION_FAILED`, not a silently ignored field.
- `authorizeSubject(context, subjectId)` is the only ownership primitive.
  It denies on an unknown subject, on a subject owned by someone else, and on an
  empty subject list. Denial emits `FORBIDDEN` and an audit row; it never emits
  `NOT_FOUND` for a subject the actor does own.
- E02's `app.analysis_subjects` does not exist yet — E06 creates it. Until then
  the personal subject is the profile itself, and `subjects` contains exactly
  `[profileId]`. This is recorded in code as a single resolver so E06 replaces
  one function, not every call site. It is not a placeholder: the authorization
  decision it produces is the real one for the data that exists today.
- Actor propagation: a `/v1` handler that reads or writes through the pooled
  connection runs inside `withActorContext(actorId, fn)`, which opens a short
  transaction and calls E02's `private.set_actor_context(uuid)`. The setting is
  transaction-local, so a pooled connection cannot carry an actor into the next
  request. This is defence in depth behind the API's own checks, exactly as
  E02's runbook states — it is not the authorization boundary.

## 6. Idempotency

Per API contract §1.4 and database architecture §14.7.

`Idempotency-Key` is required on every command. Missing, empty, longer than 128
characters, or containing anything outside `[A-Za-z0-9._~:@!$&'()*+,;=-]` is
`VALIDATION_FAILED`.

Request digest is `HMAC-SHA256(kernel signing key, method \n route key \n
canonical-JSON(body))`. It is keyed rather than plain so a stored digest cannot
be tested offline against a guessed body — the row must never become a way to
confirm that a particular email signed up.

State machine on `ops.idempotency_records`:

```
            insert (unique violation → read existing)
   (none) ─────────────────────────────► processing
                                            │
             handler returns 2xx/4xx        │  handler throws / 5xx
              ┌─────────────────────────────┴──────────────────┐
              ▼                                                ▼
          completed  ──── identical replay ──► original       failed
              │            status + body                        │
              └──── different digest ──► 409 IDEMPOTENCY_CONFLICT│
                                                                ▼
                                              same key retried → back to processing
```

- identical actor + route + digest, state `completed` → replay the stored status
  and body verbatim, with `Idempotency-Replayed: true`;
- identical actor + route, different digest → `409 IDEMPOTENCY_CONFLICT`;
- state `processing` and not expired → `409 IDEMPOTENCY_IN_PROGRESS`, retryable,
  `retryAfterSeconds: 1`;
- state `failed` → the key is reusable; the row moves back to `processing` by
  compare-and-set, so exactly one retry proceeds;
- a `processing` row older than the 60 s lease is treated as `failed` — a
  process that died mid-command must not wedge the key forever.

Records expire 24 h after creation. No bearer token, raw request body, email, or
provider payload is stored: only the keyed digest and the kernel's own safe
response envelope.

Anonymous commands (`POST /v1/public/beta-signups`) store `actor_profile_id`
null and `actor_key = 'anon'`. Replay is therefore keyed by the client-generated
opaque key alone. That is acceptable *only* because the stored response for an
anonymous command is content-free by construction (`{ "accepted": true }`, never
"this email already exists"), which is the same non-disclosure §3 already
requires of that endpoint. A future anonymous command that returns caller data
must bind a stronger actor key first.

## 7. Pagination

Cursors are opaque and signed. Wire form: `base64url(payload) + "." +
base64url(HMAC-SHA256(kernel signing key, version || payload))`.

Payload: `{ v: 1, k: <route key>, f: <filter digest>, s: <sort key>, a: [...] }`
where `a` is the keyset anchor (last row's sort columns plus its id). The filter
digest binds the cursor to the exact filter set, so a cursor cannot be replayed
against a different query. `limit` defaults to 25 and is capped at 100.

Any of: bad base64, bad signature, wrong version, mismatched route key, or
mismatched filter digest → `400 VALIDATION_FAILED` with
`errors[0] = { path: "cursor", code: "CURSOR_INVALID" }`, and a
`cursor_rejected` metric. The rejection reason is never disclosed in the
response; a caller learns "invalid", not "signature failed".

Sort order always ends with `id` as the final tiebreaker so the keyset is total.

## 8. Concurrency and caching

- Every `/v1` read returns a strong `ETag` computed as
  `"` + sha256(canonical-JSON(body minus `meta`)) truncated to 32 hex + `"`.
  `meta.requestId` changes per request and must not change the ETag.
- `If-None-Match` matching returns `304` with no body.
- A route may declare `ifMatch: "required"`. Missing header →
  `428 PRECONDITION_REQUIRED`; present but not matching current state →
  `412 PRECONDITION_FAILED`. E03 ships no mutating resource, so the primitive is
  covered by unit and integration fixtures rather than by a shipped route.
- Commands set `Cache-Control: no-store`. Public reads set
  `Cache-Control: public, max-age=<route>`; authenticated reads set `private`.

## 9. Distributed rate and abuse controls

Fixed window counters in `ops.rate_limit_counters`, incremented by a single
atomic upsert, so the limit is shared by every instance rather than per-process
(audit §10: the current limiter is instance-specific).

The identity is never stored raw. `subject_key` is
`HMAC-SHA256(kernel signing key, policy || identity)`, so the table cannot be
mined for client addresses or emails.

Policies frozen for E03:

| Policy | Identity | Window | Max |
| --- | --- | --- | --- |
| `public_read` | client address | 60 s | 120 |
| `public_beta_signup_ip` | client address | 3600 s | 5 |
| `public_beta_signup_email` | normalized email | 86400 s | 3 |

Exceeding a policy returns `429 RATE_LIMITED` with `Retry-After` and
`retryAfterSeconds`. If the counter store is unavailable the kernel fails
**closed** for commands and **open** for public reads, and says which in the
structured log — a database outage must not become a free write channel, and
must not black out the landing page.

Expired rows are removed opportunistically (a bounded delete on roughly one
request in fifty), so the table needs no sweeper of its own.

## 10. Request, correlation, and trace identifiers

- `X-Request-Id` is accepted from the caller only if it matches
  `^[A-Za-z0-9_-]{8,64}$`; otherwise a fresh `req_<26 char base32>` is minted.
  A caller-supplied value is never used as a database key.
- `traceparent` (W3C) and GCP's `X-Cloud-Trace-Context` are both parsed for a
  trace id; a new one is minted when neither is present or valid.
- Both are echoed: `X-Request-Id` on every response, and `meta.requestId` /
  problem `requestId` in the body.

## 11. Observability

One structured line per request, `event: "http_request"`, fields:
`requestId`, `traceId`, `route` (the registered template, never the raw path),
`method`, `status`, `durationMs`, `authMode`, `actorPresent` (boolean, never the
id), `problemCode`, `idempotency` (`none|stored|replayed|conflict|in_progress`),
`cursorRejected`, `rateLimit` (`ok|limited|degraded`), `redactions` (count),
`apiVersion` (`v1` or `legacy`), and for legacy routes `deprecated: true`.

Suppressed by construction: bearer tokens, emails, PGN/FEN, request bodies,
signed URLs, client addresses, subject ids, and exception messages. The line is
built from a closed field list, so a new field cannot leak by accident.

Counters derivable from the line: request rate by route/status/problem code,
auth-mode split, idempotency outcomes, cursor rejections, rate-limit outcomes,
legacy route usage by route, and a latency histogram.

Budgets (platform spec §19, measured in `server/src/v1/gates/performance.ts`):

| Measure | Budget |
| --- | --- |
| kernel overhead per bounded read, p95 | ≤ 15 ms above the bare handler |
| `/v1/public/stats` p95 (warm cache) | ≤ 500 ms |
| command acknowledgement p95 | ≤ 750 ms |
| local JWT verification, p95 | ≤ 3 ms |
| idempotency lookup + insert, p95 | ≤ 25 ms |
| rate-limit check, p95 | ≤ 25 ms |

The blocking threshold is the budget; a run that exceeds it fails the gate
rather than being recorded as "seems fast".

## 12. OpenAPI 3.1

The document is generated from the kernel's route registry and each route's zod
schemas (`z.toJSONSchema`, which emits JSON Schema 2020-12 — the dialect OpenAPI
3.1 uses). It is committed at `server/openapi/v1.json`, served at
`GET /v1/openapi.json`, and a gate fails if the committed file differs from the
generated one, so the document cannot drift from the implementation.

The frontend consumer fixture asserts the shapes `app/lib/api.ts` would consume:
success envelope, problem body, and the exact legacy `{ error }` body that the
existing client still parses.

## 13. Legacy compatibility and deprecation

Every unversioned route is wrapped by the compatibility adapter, which:

- emits `Deprecation: true` and `Sunset: <RFC 9110 date>` and a `Link` to the
  `/v1` successor where one exists;
- records a per-route usage count in the structured log, so the sunset decision
  is measured rather than guessed;
- leaves status codes and bodies byte-for-byte unchanged.

Legacy routes do not gain problem details, request-id envelopes, or idempotency.
Changing them is the migration E06+ performs per endpoint.

## 14. Schema

Migration `0013_e03_api_kernel`, additive and forward-only, owned by
`forma_migrator`, applied by the repository's existing Drizzle path.

`ops.idempotency_records` — database architecture §14.7:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `uuid pk default gen_random_uuid()` | |
| `actor_profile_id` | `uuid null` | null for anonymous commands |
| `actor_key` | `text not null` | `profileId` or the literal `anon` |
| `route_key` | `text not null` | e.g. `POST /v1/public/beta-signups` |
| `idempotency_key` | `text not null` | ≤ 128 chars, checked |
| `request_method` | `text not null` | |
| `request_digest` | `text not null` | 64 hex, keyed HMAC |
| `state` | `text not null` | `processing`\|`completed`\|`failed` |
| `response_status` | `smallint null` | present iff `completed` |
| `response_body` | `jsonb null` | kernel envelope only |
| `resource_type`, `resource_id` | `text null` | |
| `workflow_id` | `uuid null` | E04 populates it |
| `lease_expires_at` | `timestamptz null` | present iff `processing` |
| `created_at`, `updated_at`, `completed_at`, `expires_at` | `timestamptz` | |

Unique `(actor_key, route_key, idempotency_key)`. Checks: state vocabulary;
`response_status is not null` iff `completed`; key length 1–128; digest is 64 hex.
Indexes: the unique key, and `expires_at` for expiry.

`ops.audit_events` — database architecture §14.8. Append-only: `forma_api` and
`forma_ops` receive `insert` and `select` and **no** `update` or `delete`.
Columns: `id bigint identity pk`, `occurred_at`, `actor_kind`
(`user|anonymous|service|system`), `actor_ref uuid null`, `action`,
`target_type`, `target_ref`, `request_id`, `trace_id`, `result`
(`allowed|denied|error`), `reason_code`, `metadata jsonb not null default '{}'`.
A check constrains `metadata` to an object, and the kernel writes only scalar,
non-sensitive values into it. Retention: 180 days, swept by `forma-ops` when E05
lands; E03 ships the index that sweep needs and nothing more.

`ops.rate_limit_counters` — `(bucket, subject_key, window_start)` primary key,
`count integer not null`, `expires_at timestamptz not null`, index on
`expires_at`. `forma_api` receives `select, insert, update, delete`; delete is
needed for the opportunistic expiry and the table holds no evidence.

All three have RLS enabled and forced, with policies naming runtime roles only.
No `anon`, `authenticated`, `service_role`, or `PUBLIC` grant exists on any of
them.

## 15. Migration, rollout, reconciliation, rollback

Expand only. The migration creates three new `ops` tables and touches nothing
that exists; there is no backfill because there is no prior state to carry, and
nothing is renamed or dropped. It is re-runnable: every statement is guarded
(`create table if not exists`, `drop policy if exists` before `create policy`).

Rollout: apply `0013`, then deploy. `/v1` appears beside the legacy routes; no
frontend route changes; the legacy adapter starts reporting usage.

Reconciliation: none required — no existing data is transformed. The gate
verifies the applied live schema against the contract rather than assuming it.

Rollback: revert the deployment image. The `ops` tables stay; they are additive
and hold idempotency and audit evidence that the epic forbids deleting. A
forward migration is the only way to remove them, and removing them is not part
of any rollback path.

New required configuration: `FORMA_API_SIGNING_KEY` (≥ 32 bytes, Secret Manager
reference). It keys cursors, idempotency digests, and rate-limit subject keys. A
deployed process without it refuses to start, alongside E01's existing
fail-closed configuration findings. Rotating it invalidates outstanding cursors
(callers get `VALIDATION_FAILED` and restart the list) and orphans in-flight
idempotency digests (a retry becomes a new command); both are documented in the
runbook and neither loses data.

## 16. Test contract

- **Unit** — problem table and status mapping; envelope and redaction meta;
  validation error derivation; cursor sign/verify/tamper/version/filter-binding;
  ETag stability and `meta` independence; JWT claim checks and algorithm
  rejection; idempotency state machine; rate-limit window arithmetic; request-id
  acceptance and minting; legacy header shape; observability field allowlist.
- **Integration** (disposable PostgreSQL, real migrations, real Hono app) —
  idempotent replay, digest conflict, in-flight duplicate, crashed-lease
  recovery; distributed rate limit across two independent kernel instances
  sharing one database; keyset pagination across pages; `If-None-Match`;
  actor-context transaction locality; OpenAPI/committed-document agreement;
  frontend consumer fixture.
- **Security** — anonymous denial; forged tokens (`alg: none`, wrong issuer,
  wrong audience, expired, unknown `kid`, HS256 signed with a guessed secret);
  cross-subject access denied; client-supplied `userId`/`subjectId` rejected;
  no internal exception, SQL, or secret in any body; log field allowlist holds
  under an adversarial payload; least-privilege grants on the three new tables;
  `anon`/`authenticated`/`service_role` denied on all three.
- **Migration** — empty database; production-shaped prior state (through `0012`);
  repeat application; partial-failure and forward recovery.
- **Performance** — the §11 budgets against production-shaped counters, with
  before/after numbers recorded and the budget as the blocking threshold.

Three of these classes must not touch the live project and use a disposable
PostgreSQL by construction: the empty/legacy-shaped migration tests, anything
creating roles or logging in with synthetic passwords, and the grant-revocation
recovery tests. The harness refuses a non-disposable target.

## 17. Decisions recorded rather than invented

1. **`IDEMPOTENCY_IN_PROGRESS`, `PRECONDITION_REQUIRED`, `PRECONDITION_FAILED`
   added to the code table.** §1.3's list is explicitly open; these three have no
   honest existing mapping. Additive per §22.
2. **Personal subject = profile until E06.** Recorded as one resolver. The
   alternative — inventing `app.analysis_subjects` here — would pre-empt E06's
   locked ownership model.
3. **Anonymous idempotency keyed by the client key alone**, admissible only for
   content-free responses (§6).
4. **Rate limiting in PostgreSQL, not Redis.** No cache infrastructure exists;
   introducing one is a "new infrastructure family" decision under §22 and
   belongs to E05 if the counter table proves insufficient.
5. **No protected `/v1` route shipped.** Every candidate belongs to a named later
   epic, and the epic forbids product-endpoint migration. The protected kernel is
   production code proven by gates.
