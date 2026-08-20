# E05 — service topology contract

One public autoscaling process currently mixes request, provider, engine and
database load. E05 splits it into five deployments so that termination, cost,
tenancy and capacity are properties of a named service rather than of whichever
code path happened to run.

`server/src/platform/topology.ts` is the authority. This document records the
decisions that table encodes and the ones it deliberately does not make.

## The five deployments

| Deployment | Ingress | Role | Executes | Peak connections |
| --- | --- | --- | --- | --- |
| `forma-api` | public | `forma_api` | nothing | 6 × 3 = 18 |
| `forma-ops` | internal | `forma_ops` | `api_light` | 2 × 2 = 4 |
| `forma-ingestion` | internal | `forma_ingestion` | `ingestion` | 4 × 2 = 8 |
| `forma-stockfish` | internal | `forma_stockfish` | `cpu_engine` | 6 × 1 = 6 |
| `forma-analysis` | internal | `forma_analysis` | `cpu_model`, `aggregation`, `publication` | 3 × 2 = 6 |

42 of the 43 connections E02 leaves to services. The numbers are not chosen
here: they are `SERVICE_BUDGETS` in `server/src/platform/connection.ts`, and
`inspectTopology()` fails if a deployment's `--max-instances` disagrees with the
pool that budget sized it for.

`gpu_model` is the one resource class v1 defines and never schedules, so it has
no executor. Every other class has exactly one.

## Decisions

**D1 — `maintenance` work executes on `forma-analysis`.** Spec §7 names the
queue target "ops/analysis", which is the only ambiguous cell in the table.
§6.2 gives `forma-ops` dispatch, lease recovery and sweeps but no analysis
execution role, so maintenance work items route to `forma-analysis`. `forma-ops`
still executes `api_light`, which is its own sweep work.

**D2 — staging is a tagged revision, not a second project.** The acceptance
criterion asks for one digest promoted through staging. That is satisfied with
`--no-traffic --tag=next`, which gives a reachable URL serving nobody, followed
by `update-traffic`. Separate staging and production GCP and Supabase projects
remain **an open human decision**, not something this epic invents: it would
double the infrastructure and split the connection budget, and the platform
currently runs one environment by explicit instruction. Recorded here so the
choice stays visible rather than implied.

**D3 — no deployment holds the prototype in-process pipeline.** `prototype_pipeline`
is a declared capability that nothing has, and `inspectTopology()` refuses a
table that grants it. `server/src/index.ts` therefore recovers the prototype
pipeline only when the process is not a deployment. Running it inside a deployed
service is precisely the mixing this epic removes.

**D4 — per-service OIDC audiences.** E04 dispatched with one
`FORMA_INTERNAL_AUDIENCE` and one `FORMA_WORKER_BASE_URL`, so a token minted for
any worker was accepted by every worker and a missing URL silently sent every
queue to the same service. Each deployment now has its own URL environment
variable and its own audience, defaulting to that service's own URL.

## What fails the build

`npm run e05:unit` — 15 checks. Each one that asserts the shipped table is clean
also mutates a copy and asserts the finding appears, so a rule that stopped
working fails here rather than in production.

| Rule | Failure it prevents |
| --- | --- |
| exactly one browser-public deployment | a worker exposed to the internet |
| unique identity, role, secret, audience | one service reading another's data |
| engine and provider on exactly one deployment, never the API | the API blocking on Stockfish or a provider |
| no deployment holds `prototype_pipeline` | D3 quietly reversed |
| one executor per resource class | work with no owner, or two |
| queue dispatch ≤ target capacity | a queue outrunning the service it feeds |
| deployment flags match `SERVICE_BUDGETS` | scaling past the connection budget |
| 0015 limits match the budgeted peaks | the database ceiling drifting from the plan |
| identity, capability and URL refusals | an image that could be any service |

`npm run deploy:check` re-renders `deploy/generated/` and fails on drift, so a
topology change that was never rendered cannot leave a stale promotion plan
committed.

## Open risks

- **One environment.** D2's staging is a revision tag. A bad migration is not
  isolated from production by a separate database, because there is one
  database. Migration safety is carried by the migration being additive, not by
  an environment boundary.
- **Connection limits are a ceiling, not a scheduler.** 0015 caps each role at
  its budgeted peak. A service that exhausts its own limit fails to connect
  rather than starving its neighbours — the intended trade, but it means a
  misconfigured pool surfaces as connection errors in that one service.
- **`forma-analysis` carries three resource classes.** Spec §6.5 keeps the
  handlers as separate packages against a later split. Until then, one queue's
  backlog can delay another's on the same service.
