# Brief: the admin surface and gated beta access

Hand this to a fresh session. It is self-contained; it assumes no knowledge of the
conversation it came from.

---

## The two things to build

1. **`admin.formachess.com`** — an internal surface for the people running Forma.
2. **Approved signup.** Creating an account no longer grants access. A new person
   registers, is told plainly that Forma is in closed beta and that a human will
   look at their request, and waits. Someone on the admin surface approves or
   declines. Only an approved account can reach the product.

Build them together, because the second is useless without somewhere to action it.

---

## The system you are building into

Repo: `D:\forma-e21`, branch `preprod`. **Never touch `D:\forma`** — a separate
worktree with uncommitted work belonging to the owner.

- **Front end**: React Router 7 in `app/`, deployed to Cloudflare Pages.
- **API**: Hono in `server/`, deployed to Cloud Run as `forma-api`
  (`https://forma-api-384112442354.europe-west1.run.app`). All product endpoints
  live under `/v1`; `server/openapi/v1.json` is generated from the router and
  checked in CI, so it is the truth about what exists.
- **Database**: Supabase Postgres, project `oqsjfmgdovvepncbphvk`. Auth is Supabase
  Auth; `app.profiles` is the application's own row per user.
- **Existing beta artefacts**: there is a `public.beta_signups` table (currently
  empty) and a `POST /v1/public/beta-signups` endpoint used by the marketing site's
  interest form. That is a *marketing* capture, not an access gate. Decide whether
  approved signup reuses it or gets its own table, and say why.

### Non-negotiables in this codebase

These are not style preferences. Each one has cost an outage.

- **Row level security is forced on every tenant table**, with policies of the
  shape `owner_user_id = private.current_actor_id()`. A query on a connection with
  no bound actor returns **zero rows rather than raising**, so an unbound read
  looks exactly like an empty account. Bind with `withActorContext` (API) or
  `withActor` (workers). This is the single most common bug in this repo's history.
- **An admin surface breaks that model on purpose**, and that is the hardest part
  of this brief. An operator legitimately needs to see across subjects. Do not
  solve it by binding an arbitrary actor, and do not solve it by giving the API
  role blanket bypass. Look at how `forma_ops` was granted cross-subject SELECT in
  `server/drizzle/0036_ops_can_survey_what_it_plans.sql` — narrow, named,
  SELECT-only, `to <role>` — and follow that precedent. Write down what an admin
  can see and what it still cannot.
- **Identity comes from the token, never from the request.** `auth.subjects[0]` is
  the *profile id*, not an analysis subject; use `resolveAnalysisSubject`.
  `CLIENT_FORBIDDEN_IDENTITY_FIELDS` in `server/src/v1/auth/context.ts` rejects any
  body carrying an identity.
- **Timestamps**: drizzle replaces the driver's date parsers on the shared
  connection, so a raw query returns a **string** from a `timestamptz` and passing
  a `Date` as a bind **throws**. Use `server/src/db/timestamps.ts` in both
  directions. JSON binds go through `jsonParam(x)` with an explicit `::jsonb` cast.
- **ETags must not be inert**: derive `asOf` from the data, never from a clock.
- **Migrations** are hand-written, idempotent, and registered in
  `server/drizzle/meta/_journal.json`. See
  `server/drizzle/0037_terminal_positions_are_decided.sql` for the register.
  **Do not run one against the live database** without the owner's say-so.
- `DESIGN.md` at the repo root is treated as law for anything user-facing.

---

## Part 1 — approved signup

### There is no other gate any more

The site used to sit behind an early-access code. **That has been removed.** It was
never authentication and said so in its own comment — the code was compiled into
the browser bundle, so anyone who opened devtools could read it. It also drove the
`noindex, nofollow` meta tag, which is now unconditional in `app/root.tsx` and
should stay that way until public launch.

The consequence for you: between that removal and your work landing, **nothing
gates signup at all**. Approval is not one gate among several; it is the only one.
Treat it accordingly — the server-side refusal is the deliverable, and the screen
in front of it is presentation.

### The flow

1. Someone signs up. They are authenticated but **not approved**.
2. They see a screen that explains Forma is in closed beta, that their request has
   been recorded, and what happens next. It should be honest about the wait rather
   than implying minutes. Let them add a sentence about themselves and their chess
   — it is the thing that makes an approval decision possible.
3. Every product route refuses an unapproved account and returns them to that
   screen. This must be enforced **server-side**; a client-side redirect is a
   suggestion, not a gate.
4. An admin approves or declines. On approval the person can use Forma. On
   decline they are told, once, without a lecture.

### Decisions to make and defend in comments

- **Where approval lives.** A column on `app.profiles`, or its own table with a
  history of who decided what and when? The second is more auditable and this is
  access control, so lean that way unless you find a reason not to.
- **What "refuse" means at the API.** A 403 with a problem document naming the
  state is probably right. Whatever you choose, it must be one place, not a check
  repeated in forty handlers — look at how `auth: "required"` is enforced in
  `server/src/v1/registry.ts` and add the gate at that level.
- **What an unapproved account may still do.** Read its own approval state, and
  sign out. Probably nothing else. Be deliberate: an unapproved account that can
  start an examination burns real engine money.
- **Existing accounts.** There is at least one real account in the database
  already, mid-onboarding. Your migration must not lock the owner out of their own
  product. Decide the backfill and state it.
- **Notification.** The owner asked for signups to "notify us". Decide what that
  means concretely — a row the admin surface shows, and optionally an email. Do
  **not** wire an email provider without asking; that is an outbound-sending
  decision and it needs their explicit go-ahead.

---

## Part 2 — the admin surface

### Hosting

It is to be reachable at `admin.formachess.com`. Decide and justify one of:

- a separate route tree in the same Cloudflare Pages app, gated by hostname;
- a separate deployment sharing the same API;
- a separate app entirely.

The relevant fact is that **`VITE_`-prefixed values are compiled into the browser
bundle**, so nothing secret can live in the client no matter which you choose.
Authorisation must be enforced by the API.

### What it must do on day one

- **Pending signups**: who asked, when, what they said, and approve / decline.
- **Accounts**: the list, their approval state, when they joined, whether they have
  linked a chess account, and whether they have a published report.

### What it should probably do next, in rough priority order

- **Onboarding runs in flight**, with their stage — `linking`, `syncing`,
  `analysing`, `report_ready`, `goal_setting`. This is the thing you will actually
  want at 2am when someone says nothing is happening.
- **The work ledger**: `ops.work_items` by task type and status, and specifically
  anything `dead` or in `retry_wait` with its `error_code`. `GET /v1/workflows`
  already exposes per-workflow progress with real weights.
- **Sync health**: `ops.sync_runs` — accepted, duplicate, rejected, and the
  rejection tally. A stuck cursor is invisible from every other surface, and has
  already caused one silent failure where an archive stopped importing at 196 of
  337 games and reported success.

### Two warnings

- **This surface shows other people's data.** Decide what an operator may see of a
  player's actual games and analysis, and prefer counts and states over content
  wherever a count answers the question. Write the decision down.
- **Do not rebuild the analysis pipeline's own reporting here.** If a number is
  hard to get, the honest fix is usually a missing `/v1` read, not a raw query
  wired into an admin page. This codebase already contains several complete,
  tested read models that were never given a route — check before you write SQL.

---

## Explicitly out of scope

- **Maia.** A rating-conditioned human-policy opponent is being built in parallel
  elsewhere. `server/src/models/maia.ts` already holds the adapter and
  `server/src/engine/opponent.ts` holds the interface a new engine family plugs
  into. Do not touch either.
- **Plan limits and pricing copy.** `server/src/billing/plans.ts` advertises
  features that do not exist, and no plan limit is enforced anywhere in `/v1`.
  That is being handled separately. In particular the owner has said **do not
  impose the 50-game analysis limit** — analysis stays unlimited for now.
- **Taking the legacy backend offline.** In progress in another session.

---

## Definition of done

- `npm run typecheck` passes at the repo root and in `server/`.
- `npx vitest run` stays green (190 tests pass today) and the server's own unit
  gates still pass.
- If you added a `/v1` route: `npm run v1:openapi` in `server/`, then
  `npm run api:types` at the root, and `npm run v1:openapi:check` passes.
- An unapproved account cannot reach a product endpoint, and there is a test that
  proves it against the API rather than the client.

## House style

Comments explain **why**, and name the concrete consequence of getting it wrong.
Plain full sentences, no hype, no marketing register. Match the surrounding naming
and idiom. `server/src/db/timestamps.ts` and
`server/drizzle/0036_ops_can_survey_what_it_plans.sql` are good examples of the
register expected.

**Commits must contain zero AI attribution** — no "Generated with", no
`Co-Authored-By: Claude`. Short imperative subject line, blank line, prose body
explaining cause and fix.
