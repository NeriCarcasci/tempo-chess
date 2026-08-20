# The `/v1` API, for the people building the front end

Everything a client needs to know that a schema cannot tell it. The machine-readable
contract is generated from the router itself and lives at
[`server/openapi/v1.json`](../../server/openapi/v1.json); it is also served at
`GET /v1/openapi.json`. CI fails if the committed document and the mounted routes
disagree, so it is a description of what is running rather than a document
somebody meant to update.

```bash
cd server && npm run v1:openapi        # regenerate after changing a route
cd server && npm run v1:openapi:check  # what CI runs
```

Generate a typed client from it rather than hand-writing types. The document has
request bodies, query parameters, response schemas and the security scheme, so a
generator has everything it needs.

---

## 1. The shape of every response

Two success shapes and no third.

**A resource**

```json
{ "data": { "…": "…" }, "meta": { "requestId": "req_…" } }
```

**A collection**

```json
{
  "data": [ … ],
  "page": { "nextCursor": "…", "hasMore": true },
  "meta": { "requestId": "req_…" }
}
```

**A failure** — RFC 9457 problem details, `application/problem+json`:

```json
{
  "type": "https://docs.formachess.com/problems/not-found",
  "title": "Not found",
  "status": 404,
  "code": "NOT_FOUND",
  "detail": "No such game.",
  "instance": "/v1/games/…",
  "requestId": "req_…",
  "retryable": false,
  "errors": null
}
```

`code` is the stable thing. Switch on it, never on `title` or `detail`. `errors`
is an array of `{ path, code, message }` on a validation failure and `null`
otherwise — it never echoes the value that failed.

`requestId` appears on success and failure. Show it in error UI: it is what
support can find in the logs.

### `meta.redactions`

Present only when something was withheld:

```json
"meta": { "requestId": "req_…", "redactions": [
  { "path": "data.providerHandles", "reason": "projection" }
] }
```

`reason` is `entitlement` (your plan does not include this) or `projection`
(this endpoint does not carry it). **Render these differently from missing
data.** "We do not know this", "you may not see this" and "this screen does not
show it" are three different sentences, and the API distinguishes them so the UI
can.

---

## 2. Authentication

`Authorization: Bearer <supabase access token>`.

The API derives the actor, their profile and their subject from the token. **A
client never selects a subject, a user id, or an owner.** There is no parameter
anywhere that does, and a request that guesses another user's identifier gets
the same `404` as one that guesses a nonexistent identifier — by design, so the
API cannot be used to test whether something exists.

Public routes (`/v1/public/*`, `/v1/case-studies*`, `/v1/directory/*`,
`/v1/players/*`) take no token and behave identically with one.

---

## 3. Commands need an idempotency key

Every `POST`, `PUT`, `PATCH` and `DELETE` on `/v1` requires:

```
Idempotency-Key: <opaque, unique per intent, ≤255 chars>
```

Generate one per user intent — per button press, not per retry. Replaying the
same key with the same body replays the stored response. Replaying it with a
*different* body is `IDEMPOTENCY_CONFLICT` (409). A key whose first request is
still running is `IDEMPOTENCY_IN_PROGRESS` (409, `retryable: true`) — back off
and try again rather than issuing a new key.

A missing key is `VALIDATION_FAILED`, not a silent success.

---

## 4. Pagination

Cursors are opaque and signed. Pass `page.nextCursor` back as `?cursor=`.

A cursor is bound to the route *and the filter set it was issued under*: reusing
one after changing a filter is refused rather than silently returning wrong
rows. Do not construct, parse or store them beyond the session — treat them as
one-use continuations.

`limit` is capped per route (the OpenAPI document has the maximum).

---

## 5. Caching and concurrency

Read routes send `Cache-Control` and, where useful, an `ETag`. Send
`If-None-Match` on re-reads and handle `304`.

- `public, max-age=…` — safe in a shared cache (case studies, plans, stats).
- `private, max-age=0, must-revalidate` — one person's data; revalidate.
- `no-store` — never cache (the player directory: its risk is enumeration).

Some writes require `If-Match` with the current ETag. Without it you get
`PRECONDITION_REQUIRED` (428); with a stale one, `PRECONDITION_FAILED` (412).
Re-read, show the user what changed, and let them decide — do not retry blindly.

---

## 6. Rate limits

`429` with `RATE_LIMITED` and a `Retry-After` header in seconds. Respect it.
The public directory is deliberately tight (30/minute per address) because its
abuse case is enumeration rather than load.

---

## 7. The problem codes worth handling

| Code | Status | What the UI should do |
| --- | --- | --- |
| `AUTH_REQUIRED` | 401 | Send them to sign in. |
| `FORBIDDEN` | 403 | This is not theirs. Do not offer a retry. |
| `NOT_FOUND` | 404 | Also means "hidden" and "withdrawn". Never say "this used to exist". |
| `VALIDATION_FAILED` | 400 | Field-level errors are in `errors[]`, keyed by `path`. |
| `CONFLICT` | 409 | The resource moved under them. Re-read. |
| `IDEMPOTENCY_CONFLICT` | 409 | A bug in the client: same key, different body. |
| `IDEMPOTENCY_IN_PROGRESS` | 409 | Back off and retry the *same* key. |
| `PRECONDITION_REQUIRED` / `PRECONDITION_FAILED` | 428 / 412 | Send `If-Match`; on 412 re-read first. |
| `RATE_LIMITED` | 429 | Wait `Retry-After`. |
| `ENTITLEMENT_REQUIRED` | 402 | Their plan does not include this. Offer the upgrade, do not pretend it failed. |
| `PROVIDER_UNAVAILABLE` / `PROVIDER_RATE_LIMITED` | 503 / 429 | Lichess or Chess.com, not us. Say so plainly. |
| `INSUFFICIENT_COVERAGE` | 422 | Not enough evidence for the claim. Say what is missing, not "try again". |
| `UNSUPPORTED_GAME` | 422 | Variant or incomplete game. |
| `WORKFLOW_NOT_CANCELLABLE` | 409 | It already finished or is past the point of stopping. |
| `INTERNAL_ERROR` | 500 | Show the `requestId`. Never show `detail`. |

---

## 8. Asynchronous work

Anything that takes time is a **workflow**. A command that starts work returns
`202` with the resource, and the work is observable at:

- `GET /v1/workflows` — the caller's operations, newest first, cursor-paged.
- `GET /v1/workflows/{workflowId}` — state and weighted progress.
- `POST /v1/workflows/{workflowId}/cancel` — asks it to stop; cancellation is
  cooperative, so the state goes `cancelling` before `cancelled`.

States: `queued`, `running`, `succeeded`, `failed`, `cancelling`, `cancelled`.
`percent` is **null while the total is unknown** — render an indeterminate bar
rather than inventing 0%.

Poll while a workflow is live. Every 3–5 seconds is plenty; there is no
websocket and the endpoints are cheap.

---

## 9. Truthful states, and why they are not errors

The API distinguishes "we do not know" from "there is nothing" from "you may
not see it". A screen that renders all three as an empty div throws away the
most valuable thing this product does.

| Field | Values | Means |
| --- | --- | --- |
| `analysis.state` (game) | `published`, `stale`, `running`, `failed`, `unavailable` | `stale` = the provider corrected the replay after we analysed it. |
| `state` (goal plan, progress) | `published`, `unavailable` | `unavailable` = no cycle or no reading yet, not an error. |
| `coverageState` | `insufficient`, `limited`, `sufficient` | How much evidence stands behind a claim. |
| `claimState` (progress) | `no_evidence`, `early_signal`, `improving`, `target_met`, `declined`, `unavailable` | Only `target_met` may be shown as achieved. |
| `emptyReason` (practice queue) | `nothing_due`, `no_material`, `queue_full` | "Come back tomorrow" and "we have nothing to teach you yet" are different. |
| `disclosure` (public stats) | `exact`, `suppressed` | `suppressed` = we know and are not saying, because the cell is small enough to be a person. |
| `nextAction.action` (onboarding) | see §10 | The one thing to do next. |

**Rules for the UI.** Never render a null estimate as `0`. Never render
`suppressed` as "0" or "—" without the reason. Never show a target as achieved
unless `targetAchieved` is true — adherence is not progress, and practice cannot
complete a goal.

---

## 10. The journeys, endpoint by endpoint

### Sign-up to first report

```
GET  /v1/me                                  → is there a linked account?
POST /v1/me/accounts                         → claim a provider account (202)
POST /v1/onboarding/runs                     → start; plans the real work (201)
GET  /v1/onboarding                          → poll: stage + nextAction
GET  /v1/workflows/{syncWorkflowId}          → progress for the "wait" stages
GET  /v1/onboarding/runs/{runId}/coverage    → what we have and what is missing
GET  /v1/baseline-reports/{reportId}         → the immutable report
POST /v1/onboarding/complete                 → activate (needs all three)
```

`GET /v1/onboarding` returns `nextAction`, and the whole onboarding UI can be
driven from it:

| `action` | Screen |
| --- | --- |
| `link_account` | Connect a provider account. |
| `wait` | Progress, with `reason` as the caption ("importing your games"). |
| `start_diagnostic` / `skip_diagnostic` | Offer the optional diagnostic. |
| `view_report` | The baseline report (`reportId` is on the action). |
| `select_goal` | Goal picker. |
| `accept_commitment` | Commitment step. |
| `complete_onboarding` | The activate button. |
| `none` | Done, failed or abandoned — check `status` and `failureReason`. |

Activation requires all three of: the report was actually viewed, a goal was
selected, a commitment was accepted. The database refuses anything else, so
`POST /v1/onboarding/complete` will fail rather than lie.

### Goals

```
GET  /v1/goal-templates                      → what can be aimed at, and what each needs
POST /v1/goals                               → draft + resolve targets + open the cycle
GET  /v1/goals                               → the list
GET  /v1/goals/{goalId}                      → one goal
GET  /v1/goals/{goalId}/plan                 → the ranked requirements for the active cycle
PUT  /v1/goals/{goalId}/commitments/{key}    → what the user commits to
GET  /v1/goals/{goalId}/progress             → metrics, adherence and evidence, kept apart
POST /v1/goals/{goalId}/close                → close, and hear whether it was demonstrated
```

`POST /v1/goals` returns `targets` (resolved), `rejected` (with a code and a
reason — show them, do not drop them), `cycleId` and `planState`. A requested
target inside the noise floor is *moved* and `adjustedFromRequested` says what
was asked for; tell the user.

`GET /…/progress` returns three separate things on purpose: `metrics`
(readiness against target), `adherence` (what they did versus what they
committed to) and `realGameEvidence` / `practiceEvidence`. **Do not combine
them into one number.** Practice cannot complete a goal, and the API's shape is
what stops a client implying otherwise.

`POST /…/close` always closes — it is their goal — and tells you separately
whether the evidence supported the outcome they chose.

### Practice

```
GET  /v1/practice/queue                      → what is due, and why each item is there
POST /v1/practice/refill                     → mint drills from recent mistakes
POST /v1/practice/attempts                   → submit one attempt (idempotent)
```

The queue **never contains the solution**. `expected` comes back from
`POST /v1/practice/attempts`, after the person has committed. `reason` on each
item is the sentence explaining which of their games it came from — show it.

`refill` refuses to add to a backlog and says `queue_full` when it does. That is
a feature: a queue that only grows is a source of guilt.

### Games and review

```
GET  /v1/games/recent?limit=                 → newest games with their move lists
GET  /v1/games/{gameId}                      → metadata, perspective, publication state
POST /v1/games/{gameId}/analysis             → request analysis (202, or the existing one)
GET  /v1/games/{gameId}/review               → the published objective review
POST /v1/positions/evaluations               → one bounded evaluation of a position
```

`recent` is the one read here that does not wait for analysis. It returns up to
12 games (6 by default), each with `moves` in UCI and SAN and an `initialFen`
that is null for the standard start, so a screen can animate real boards while
a sync or an analysis is still running. It carries no publication state on
purpose — there is nothing to claim yet, and a field saying so would invite the
page to render the absence of a verdict as one. `asOf` is the newest sync behind
the answer, so `If-None-Match` keeps polling cheap.

Every claim-bearing read carries a **version block**: `publicationId`,
`generatedAt`, `recipeVersionId`, `policyVersions`. Show the date at least. When
`analysis.state` is `stale`, say the game was corrected after it was analysed
rather than silently showing an old verdict.

### Public

```
GET  /v1/public/stats                        → reach, with small cells suppressed
GET  /v1/public/plans                        → display catalogue + checkoutAvailable
POST /v1/public/beta-signups                 → the waiting list (202, never confirms existence)
GET  /v1/case-studies, /v1/case-studies/{slug}
GET  /v1/directory/players?query=…           → prefix search, minimum 2 characters
GET  /v1/directory/players/{handle}
```

Case studies carry their source, the basis on which it may be republished, the
analysis publication behind them and their caveats. Render the caveats — they
are the difference between an example and a claim.

### Account

```
GET    /v1/me                                → profile, personal subject, linked accounts
POST   /v1/me/accounts                       → claim another provider account
DELETE /v1/me/accounts/{accountId}           → disconnect (202, reference-aware cleanup)
GET    /v1/artifacts/{artifactId}/download   → short-lived signed URL for an owned artifact
```

Never construct a storage URL. The download endpoint mints a short-lived signed
one, and a client that holds a bucket key is a client that has been given
something it should not have.

---

## 11. What is not there yet

Build around these rather than against them.

1. **The baseline report will be empty.** E15's estimators read
   `analysis.concept_opportunities`, and nothing in the product writes that
   table — the concept detector was specified and never implemented. The whole
   chain up to the report works and is proven by the journey gate; the report
   itself has nothing to say until a detector lands. Design the report screen for
   the shape, and expect `coverageState: "insufficient"` in the meantime.
2. **Billing endpoints are not mounted.** `GET /v1/public/plans` exists;
   subscription, checkout, portal and the webhook do not. The entitlement,
   quota and webhook logic is written and tested behind them.
3. **Export and account deletion are not built** (that is E21). `DELETE /v1/me`
   and `/v1/me/exports` do not exist yet.
4. **Chess.com has no canonical sync.** Linking one works; syncing it fails with
   a named, visible reason. Lichess is complete.
5. **The diagnostic session is never created.** The endpoints exist; nothing
   selects items yet, so onboarding goes straight from `analysing` to
   `report_ready`.
6. **The legacy unversioned API is still what the current site uses.** It is
   unchanged and still works. Nothing in `/v1` has to be adopted all at once.
