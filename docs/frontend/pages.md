# The front end, page by page

What each screen is for, what it shows, where the data comes from, and what it
must say when it has nothing. Read [`api-guide.md`](./api-guide.md) first; this
document assumes the envelope, the problem codes and the truthful states.

## The rule that shapes every screen

Forma's product claim is that it tells you the truth about your chess. That
survives or dies in the UI, not in the API. Three habits keep it alive:

1. **An empty state is a sentence, not a blank.** Every endpoint that can return
   nothing also returns *why*. Use it. "You have practised everything that is
   due — come back tomorrow" and "we have not found anything worth drilling yet"
   are different screens.
2. **Uncertainty is shown, not rounded away.** An estimate has an interval. A
   claim has a coverage state. A goal has evidence behind it or does not. A
   number without its interval is a stronger claim than the one Forma made.
3. **Nothing is implied that the API did not say.** Practice does not complete a
   goal. Adherence is not progress. A withdrawn case study never existed. A
   hidden profile is indistinguishable from an unused handle.

## Status key

- **Ready** — the endpoints exist and the journey gate proves the data flows.
- **Ready, empty** — the endpoints exist and will return truthful emptiness
  until the concept detector lands (see api-guide §11.1).
- **Blocked** — the endpoints do not exist yet.

---

# Public site

## `/` — Home
**Ready.** Anonymous.

The pitch, and the one number Forma is allowed to quote about itself.

- `GET /v1/public/stats` — `players` and `games`.
- `GET /v1/case-studies?limit=3` — worked examples, if any are published.

`players` is a **figure, not a number**: `{ disclosure: "exact", value }` or
`{ disclosure: "suppressed", below: 10 }`. Render the suppressed case as "fewer
than 10", never as "0" or "—". `byPlatform` is the same shape per platform.

The current site lists the handles behind the figure. **That roster is not on
the `/v1` surface** and needs a decision before launch: those accounts were
screened from public arena results and never opted into being listed. Either get
consent or drop the component.

## `/features`, `/pricing`, `/terms`, `/privacy`, `/brand`
**Ready** (pricing partly).

`GET /v1/public/plans` gives the display catalogue and `checkoutAvailable`.
While that is false, the pricing page shows the plans and a waiting-list form
(`POST /v1/public/beta-signups`) rather than a checkout button that cannot work.

The signup response is always `{ accepted: true }` — it never reveals whether
an address was already on the list. Do not write copy that implies otherwise.

## `/case-studies` and `/case-studies/:slug`
**Ready** (nothing published yet).

- `GET /v1/case-studies` — cursor-paged, newest first.
- `GET /v1/case-studies/{slug}`.

Each study must show, because each is a promise the publication made:

- the **source** and its **permission basis** (public domain / licence / consent
  / our own material), with the licence link and attribution when there is one;
- the **version block** — which analysis produced this, and when;
- the **caveats**, verbatim and not behind a "read more";
- the editorial badge: this is a curated example, not a live claim about a user.

A 404 covers withdrawn, unpublished and never-existed. Show one message.

## `/players` and `/players/:handle` — the directory
**Ready** (opt-in, so empty until someone opts in).

- `GET /v1/directory/players?query=…` — minimum **2 characters**, cursor-paged.
- `GET /v1/directory/players/{handle}`.

Debounce, and do not search below two characters — the API refuses it. Provider
handles appear only when the profile *and* the linked account both opted in;
when they did not, `meta.redactions` names it and the UI should say "this
player has not made their chess accounts public" rather than showing nothing.

A profile that is not discoverable 404s exactly like an unused handle. Never
write "that user is private".

---

# Auth

## `/login`, `/signup`, `/reset-password`
**Ready** — Supabase, unchanged from today.

After sign-in, everything else hangs off `GET /v1/me` and
`GET /v1/onboarding`. Route on those two, not on local state.

---

# Onboarding

The whole flow is driven by one field: `nextAction.action` from
`GET /v1/onboarding`. Poll it every 3–5 seconds while the action is `wait`.

## `/welcome` — Connect an account
**Ready.** `nextAction: link_account`.

- `POST /v1/me/accounts` with `{ provider, handle }`.
- Then `POST /v1/onboarding/runs` with the subject id from `GET /v1/me`.

Two honest details. `verificationStatus` is real: a public lookup is
`unverified`, and the UI should not draw a green tick for it. **Chess.com can be
linked but not yet synced** — say so at the point of linking rather than after a
sync that never happens.

## `/onboarding` — While it works
**Ready.** `nextAction: wait`.

- `GET /v1/onboarding` for the stage and the caption (`nextAction.reason`).
- `GET /v1/workflows/{syncWorkflowId}` for progress.

Stages, in order: `linking → syncing → analysing → (diagnostic) → report_ready
→ goal_setting → activated`. `percent` is null until the total is known — show
an indeterminate indicator, not 0%.

If `status` becomes `failed`, `failureReason` is one of `no_linked_account`,
`provider_unavailable`, `no_eligible_games`, `analysis_failed`,
`abandoned_by_user`. Each deserves its own sentence and its own next step.
`no_eligible_games` in particular is not an error the user caused.

## `/onboarding/diagnostic` — the optional examination
**Blocked** (endpoints exist; nothing creates a session yet).

`GET /v1/diagnostic-sessions/{id}` and `POST /…/attempts` are mounted. Build it
when sessions are created. The rule to preserve: the item explains *what it is
testing* before the answer, and never ships the expected move.

## `/report` — The baseline report
**Ready, empty.**

- `GET /v1/onboarding/runs/{runId}/coverage` — what Forma has and what it lacks.
- `GET /v1/baseline-reports/{reportId}` — the immutable report.

Lead with coverage, not with scores. `coverageState` is `insufficient`,
`limited` or `sufficient`, per dimension as well as overall, and the report is
only as strong as it says it is. Every item carries an entitlement key; items
above the caller's plan come back withheld, named in `meta.redactions` — show
them as locked with what they are, never as absent.

Until the concept detector lands this report will be honestly empty. Design for
that state first: it is also what a brand-new user with three games will see.

## Goal selection and commitment
**Ready.** `nextAction: select_goal`, then `accept_commitment`.

- `GET /v1/goal-templates` — `requiresCalibratedCohort` tells you when a
  template cannot state a numeric target for this player. Say so instead of
  offering a promise Forma cannot keep.
- `POST /v1/goals` — returns resolved targets, `rejected` targets with reasons,
  `cycleId` and `planState`.
- `PUT /v1/goals/{goalId}/commitments/{key}` with `{ target, cadence, unit,
  enabled, acceptedRequirementKeys }`.
- `POST /v1/onboarding/complete`.

When a target was moved out of the noise floor, `adjustedFromRequested` holds
what was asked for. Show both: "you asked for +5%; the smallest change we could
actually measure is +8%".

---

# The product

## `/today` — The hub
**Ready, thin.**

One screen answering "what should I do now". Compose from:

- `GET /v1/onboarding` — if not activated, this page *is* onboarding.
- `GET /v1/goals` + `/goals/{id}/progress` — the active goal, its claim state.
- `GET /v1/practice/queue` — what is due.
- `GET /v1/games?…` — recent games *(list endpoint not yet mounted; use the
  legacy route or defer)*.
- `GET /v1/workflows` — anything still running, so the user knows why a number
  has not moved.

Rank by what is actionable, and be willing to say "nothing today". A hub that
manufactures a task every day teaches people to ignore it.

## `/goals` and `/goals/:id`
**Ready.**

- `GET /v1/goals`, `GET /v1/goals/{id}`.
- `GET /v1/goals/{id}/plan` — ranked requirements, each with its `rationale`.
- `GET /v1/goals/{id}/progress`.
- `POST /v1/goals/{id}/close`.

Three regions, kept visually apart because the API keeps them apart:

1. **Progress** — per metric: current value, interval, readiness, `claimState`.
   Only `target_met` may look like success. `declined` must be shown, not
   hidden; a coaching product that only reports good news is an advertisement.
2. **Adherence** — what they did against what they committed to, with the
   sentence the API supplies. Never merge this into progress.
3. **Evidence** — `realGameEvidence` and `practiceEvidence` as separate counts.

`planState: "unavailable"` means no cycle yet — usually no published analysis.
Say that, and link to what would fix it.

Closing always succeeds; the response says separately whether the target was
demonstrated. If it was not, the UI says so gently and truthfully rather than
congratulating.

## `/practice`
**Ready** (subject to material existing).

- `GET /v1/practice/queue` — items with `fen`, `prompt`, `reason`, `dueAt`,
  `reviewNumber`, plus `remaining`, `overdue` and `emptyReason`.
- `POST /v1/practice/refill`.
- `POST /v1/practice/attempts` — `{ assignmentId, clientAttemptId, moves,
  hintsUsed?, revealed?, responseTimeMs? }`.

The board shows the position; `reason` says which of *their* games it came from.
That sentence is the product — a drill without it is a puzzle app.

The solution arrives only in the attempt response. Generate `clientAttemptId`
once per attempt and reuse it on retry: the endpoint is idempotent on it and
double submission must not double-advance the schedule. `revealed: true` is
never a success, whatever move follows.

Empty states: `nothing_due` ("you are up to date"), `no_material` ("we have not
found anything worth drilling yet"), `queue_full` (offered by refill: "clear
some of what you have first").

## `/games` and `/games/:id`
**Ready** for the detail; the list endpoint is not mounted on `/v1`.

- `GET /v1/games/{gameId}` — metadata, subject perspective, replay revision,
  `analysis.state`, version block.
- `POST /v1/games/{gameId}/analysis` — request analysis; `202` with a workflow,
  or the publication that already covers it.
- `GET /v1/games/{gameId}/review` — the published review.
- `POST /v1/positions/evaluations` — one bounded evaluation while exploring.

`analysis.state` drives the page: `published` (show it), `stale` (show it and
say the provider corrected the game afterwards), `running` (progress via the
workflow), `failed`, `unavailable` (offer to analyse). Always show the version
block's date — "analysed on" is part of the claim.

## `/account`
**Ready** for profile, accounts and privacy; **blocked** for billing, export and
deletion.

- `GET /v1/me` — profile, personal subject, linked accounts with
  `verificationStatus`, `status`, `providerHandleDiscoverable`.
- `POST /v1/me/accounts`, `DELETE /v1/me/accounts/{id}` (202, then a workflow).
- Privacy toggles: discoverability and per-account handle visibility. Both
  default to off, and the UI should explain that they are *two* decisions.
- Plan and usage: `GET /v1/public/plans` for the catalogue; the subscription and
  usage endpoints are not mounted yet.
- Export and delete: **not built** (E21).

Disconnecting an account is reference-aware and asynchronous: show the workflow
and explain that games another source still justifies are kept.

---

# Cross-cutting components

**Version block.** Wherever a claim appears: "Analysed 14 August from 138 games"
with the publication id available on hover or in a detail panel. Everything with
a `version` field gets one.

**Coverage badge.** `insufficient` / `limited` / `sufficient`, with the
dimension it applies to. This is the single most important honesty affordance in
the product.

**Interval.** Any estimate with `intervalLow`/`intervalHigh` renders as a range,
not a point. A wide interval means "we do not know yet" and should read that way.

**Redaction notice.** For every entry in `meta.redactions`: `entitlement` →
locked, with what it is and the upgrade; `projection` → "this screen does not
carry that", with where it does.

**Workflow strip.** A small, dismissible indicator wherever background work is
running, linked to `GET /v1/workflows`. Users tolerate waiting; they do not
tolerate not knowing.

**Problem surface.** One component mapping `code` to copy and to the right
action, with `requestId` shown on `INTERNAL_ERROR`. Never render `detail` from a
500.

---

# Build order

1. **Auth + `/v1` client.** Generate types from the OpenAPI document; wire the
   bearer token, `Idempotency-Key`, problem handling and the redaction notice
   once, centrally.
2. **`/welcome` → `/onboarding` → `/report`.** The whole flow is
   `nextAction`-driven; this is the shortest path to a real user going end to
   end, and it exercises the sync, analysis and report chain the journey gate
   proves.
3. **`/games/:id`.** The most complete backend surface, and the screen that
   makes the analysis visible.
4. **`/goals` + `/practice`.** The loop.
5. **`/today`.** Compose it last, once you know what the parts actually look
   like.
6. **Public pages** (`/case-studies`, `/players`) alongside, whenever a case
   study is published.

Everything above `/v1` can be built while the legacy API keeps serving the
current site. There is no cutover moment until E23.
