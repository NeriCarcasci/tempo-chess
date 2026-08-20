# E01 containment recovery scope

Contract version: 5  
Status: proposed design contract; implementation is forbidden until an independent
Codex design review approves this exact version.  
Base: `b9b9a27585dc771b7755a07c9a28a66cce9ae520` (`origin/main`).

## 1. Objective and precedence

Close E01 only as the emergency containment epic defined by the normative inputs
below. The completion branch records and independently verifies the containment
already live in production. It does not import target database, authorization,
workflow, service-topology, or launch-hardening architecture owned by later epics.

The inputs below are canonical even though they are absent from the base commit;
the implementation branch must commit their exact bytes under `plans/`. If two
inputs conflict, the narrower explicit E01 requirements in the delivery plan and
audit govern; locked platform/API/database invariants still may not be weakened.
This recovery scope narrows execution but cannot override a canonical contract.

| Precedence | Canonical repository path | SHA-256 |
|---:|---|---|
| 1 | `plans/v1-delivery-plan.md` | `2db5fdc8b45e04d6bdf71c248d8fd0358a7d086a2b25ef4114d121ecfbe965cc` |
| 2 | `plans/v1-platform-audit.md` | `c6644f075ee4d3fe3aee1284b68652c2e5b88934e5b843af24aa0ac67065799e` |
| 3 | `plans/v1-platform-spec.md` | `283bc92c6892fe89e477d5c02d061bd30be714cfeafe5764d7b6d2fc0d87157c` |
| 4 | `plans/v1-api-contract.md` | `3926872e07adaf89561925cf9b80411eff9a3a8eb59e952cc5ce0fc517ad3e28` |
| 5 | `plans/database-architecture.md` | `9a193d480e297c0cae0daff4fc27bb1a75246f29b566ae3ebb293440cb49951b` |

Any scope edit changes the contract version and SHA-256, invalidates the prior
design verdict, and requires a fresh independent design gate before code changes.

## 2. Immutable provenance and truth classes

The failed attempt is evidence/reference only. It is pinned at commit
`93fe18fa4f016b27d2411ac246ae048547cf90e8`; the mutable branch name
`archive/e01-full-attempt-20260816` is not an authority and may not be merged or
used as a branch base. Prior branch tests, CI, evidence generators, and review
verdicts do not carry forward.

The only archived paths whose ideas or exact artifacts may be reconstructed are:

- `server/drizzle/0011_e01_containment.sql` and its `0011_snapshot.json` and
  `_journal.json` entry;
- `server/src/security/{contract,config,redaction,catalogue}.ts`;
- `server/src/security/probes/{db,http}.ts` and
  `server/src/security/harness/disposable.ts`;
- E01-only contract, migration, runtime, security, and end-to-end tests;
- `docs/security/E01-*` and redacted `evidence/E01/*`, after independent
  regeneration or provenance labelling;
- the branch-new `.github/workflows/e01-containment.yml`, whose only purpose is
  to run the deterministic, no-secret E01 gates defined in section 8.

Everything else from the archive is prohibited unless added to this closed list
by a new reviewed scope version. In particular, do not reconstruct `authz.ts`,
`problem.ts`, telemetry architecture, actor helpers, worker/standby identities,
or any credential/deployment CLI.

Production facts have three distinct truth classes:

| Class | Meaning |
|---|---|
| Observed live | Read-only evidence obtained from the current production control/data planes. |
| Historical | Redacted records of a past mutation; never represented as freshly executed. |
| Branch-only | Code or tests required for regression safety but not deployed by E01 recovery. |

Cloud Run revision `tempo-chess-api-00004-8dk` serves 100% traffic and uses image
digest `sha256:50e141014412d3178117daa0a7cc94497ab12cf3beb6e76b925497f9c930f929`.
Its successful Cloud Build is `ad7210a8-089c-4046-8a84-f7a663cd2d02`; the source
is storage object generation `1786818211613533`. That source bundle has no Git
commit metadata, so its Git source commit is **unknown**. The recovery must not
claim that any later archive or branch-only fix is serving. Production deployment,
traffic changes, and source-to-revision correction are forbidden in this recovery.

The latest retained complete Cloud Run environment inventory for that revision
does **not** contain `DATABASE_ROLE`. This is observed live configuration drift,
not evidence that the marker is present. `DATABASE_ROLE=forma_api` remains a
mandatory branch and disposable-rehearsal startup invariant. Correcting the live
marker is explicitly deferred to E05's reviewed deployment/configuration work;
the E01 implementer must not deploy or mutate service configuration.

## 3. Frozen production containment manifest

Production project is only `oqsjfmgdovvepncbphvk`. The exact already-applied SQL
is `server/drizzle/0011_e01_containment.sql`, 27,497 bytes, SHA-256
`212a833c84f204460c95f6b1a1eba1ff6d0d22088085a2fdd13a867ac5d9dcb7`.
The snapshot is 94,395 bytes, SHA-256
`3ae5f06bff21114923984933206ec850d3f82097eccd200c3ba793a4dce7ccc1`.
The only journal addition is `idx=11`, `version=7`,
`when=1786840279694`, `tag=0011_e01_containment`, `breakpoints=true`.
These bytes are immutable and no production migration is applied.

The exact 22-table allowlist is:

`analysis_imports`, `analysis_tasks`, `beta_signups`, `canonical_moves`,
`game_sources`, `games`, `lesson_progress`, `linked_accounts`, `mistakes`,
`opening_drills`, `opening_edges`, `opening_positions`,
`opening_repertoire_moves`, `opening_training_results`,
`player_opening_observations`, `player_opening_stats`, `player_style`,
`position_eval`, `profiles`, `puzzles`, `repertoire_openings`, `usage_events`.

The exact 19-policy allowlist is one policy named
`<table>_forma_api_service_dataplane` on every table above except
`player_opening_stats`, `player_style`, and `puzzles`. Each is scoped only to
`forma_api` and is the immutable historical `ALL / USING(true) / WITH CHECK(true)`
containment policy. These policies may not be copied, expanded, renamed, or
represented as tenant authorization. They provide role scoping only; application
authorization remains residual risk until E02/E03.

The exact 54 `forma_api` table-grant allowlist is:

| Tables | Exact privileges |
|---|---|
| `analysis_imports`, `analysis_tasks`, `beta_signups`, `game_sources`, `games`, `lesson_progress`, `linked_accounts`, `opening_drills`, `opening_edges`, `opening_positions`, `player_opening_observations` | `INSERT, SELECT, UPDATE` |
| `canonical_moves`, `repertoire_openings` | `DELETE, INSERT, SELECT` |
| `opening_repertoire_moves`, `profiles` | `DELETE, INSERT, SELECT, UPDATE` |
| `mistakes` | `SELECT` |
| `opening_training_results`, `position_eval`, `usage_events` | `INSERT, SELECT` |

`player_opening_stats`, `player_style`, and `puzzles` have no runtime grant.
`forma_migrator` exists because it is frozen in 0011, but is inert in E01: it has
no credential, job, connection, or operational use.

Current Supabase `supabase_admin` default ACL rows still name `anon` and
`authenticated` for future public objects. This is recorded residual risk, not a
safe-default claim. E01 must prove zero **effective** schema and object access for
`PUBLIC`, `anon`, and `authenticated`, including inherited memberships, existing
grants, RLS/policies, routines, sequences, and default-ACL-created test objects in
the disposable rehearsal. It must fail if a newly created rehearsal object becomes
reachable. E02 replaces this legacy model and owns final default privileges.

## 4. Exact implementation boundary

Required branch changes are limited to the five canonical plans, the frozen 0011
artifacts, E01 documentation/evidence, package scripts/lockfiles required to run
the gates, and the following runtime behavior:

| Area | Permitted files/route | Exact E01 behavior |
|---|---|---|
| DB client | `server/src/db/client.ts`, E01 config helpers | Parse a Supavisor username such as `forma_api.<project-ref>` to base role `forma_api`; deployed startup requires port `6543` and `DATABASE_ROLE=forma_api`, and rejects owner, migrator, unknown role, wrong port, or a missing/mismatched marker. |
| Private identity check | E01 security module plus an internal non-public test hook | Execute `select current_user` over the runtime pool, require exactly `forma_api`, and fail closed. It is separate from liveness and is not exposed as a public diagnostic route. |
| Secret binding | evidence/probe code only | Read Cloud Run metadata and require `DATABASE_URL` to be a `secretKeyRef` to `forma-api-db-url` key `1`, with marker `projects/tempo-chess-neri/secrets/forma-api-db-url/versions/1`; never inspect or log the value. |
| CORS | `server/src/cors.ts`, `server/src/cors.test.ts`, minimal wiring in `server/src/index.ts` | Allow exactly `https://forma-chess.pages.dev`, `https://formachess.com`, and `https://www.formachess.com`. Echo an allowed Origin and set `Vary: Origin`; reject disallowed preflight; requests without Origin remain usable for non-browser/server clients but receive no ACAO; wildcard fallback is forbidden in deployed environments. |
| Health | existing `GET /health` | Liveness only. It proves process availability, not database identity or readiness. Tests include success plus simulated dependency/config negative cases outside the public liveness handler. |
| Safe errors | existing paths only | Remove raw exception messages, SQL, URLs, credentials, tokens, and row/provider payloads from existing responses/logs. Do not introduce problem-details, request IDs, actor propagation, compatibility middleware, or new telemetry architecture. |
| Authorization rehearsal | existing `GET /imports/:id`, `POST /imports/:id/cancel`, and authenticated self routes | Two-user fixtures prove a second actor cannot read or cancel the first actor's import. Absent, malformed, and revoked-before-first-use sessions return HTTP `401` with exact JSON `{"error":"Sign in to continue"}`. Foreign import read and cancel each return HTTP `404` with exact JSON `{"error":"Import not found"}`. These are legacy bodies, not stable error codes. No new authorization kernel. |

No other route or production behavior may be changed without another design gate.

## 5. Categorical prohibitions and downstream ownership

E01 recovery must not add, import, retain, or execute:

- `ALTER ROLE ... PASSWORD`, credential provision/rotation/retirement, Secret
  Manager create/version mutation, traffic mutation, deploy commands, or any
  general-purpose credential/deployment CLI;
- migrations `0012` or `0013`, actor-scoped legacy RLS, `set local` actor
  propagation, worker/standby identities or clients;
- Cloud Tasks, workflow/outbox/lease/background-loop redesign;
- permanent staging topology, private workers, multi-service connection budgets,
  or immutable digest promotion machinery;
- target V1 schemas/tables, legacy rename/drop, data deletion, provider, analysis,
  coaching, billing, or frontend feature work;
- production writes, production test users/rows, credential rotation, deployment,
  or traffic changes.

The only permitted CI addition is `.github/workflows/e01-containment.yml`. It may
run checkout, supported Node setup, root/server install/build/typecheck,
`pipeline:test`, `security:unit`, `security:migration`,
`security:rehearsal`, `security:forbidden-scope`, and both production-dependency
audits. It must use synthetic disposable fixtures, contain no secrets, and may
not authenticate to or access production, deployment, traffic, Cloud Run, Secret
Manager, Supabase management, or provider control planes. The production-readonly
gate is a Fedora final-evidence gate and is categorically excluded from CI. Both
CI and the local gate scan for the forbidden paths and mutation commands/APIs
above. Read-only control-plane metadata verification and independently reconciled
redacted historical records are the only credential/deployment evidence allowed.

Ownership remains: E02 target schemas/roles/default privileges/RLS harness and
connection budget; E03 JWT/actor/request/error/API kernel; E04 durable workflows;
E05 staging/service topology and reusable deployment/credential recovery tooling;
E22 alerting, rotation cadence/drills, load, recovery, cost, and launch sign-off.

## 6. Disposable production-shaped rehearsal

To satisfy staging evidence without depending on E05, E01 owns a self-contained,
disposable rehearsal using local containers or an ephemeral isolated Supabase
branch/project plus a local API process. It must use synthetic fixtures only, no
production credentials or data, must never target `oqsjfmgdovvepncbphvk` or the
unrelated Eireplan project `ydygbectaakvxtqesvya`,
and must emit creation identifier, start/end timestamps, and teardown proof.

From a measured production-shaped 0010 fixture it must apply the exact 0011 once
and verify: the 22 tables; exact roles/grants/policies; RLS and inherited access;
current and default ACL behavior including a newly created object; startup/current
user failures; secret-metadata fixtures; the full CORS contract; safe errors;
liveness and negative config/dependency cases; anonymous denial; two-user and
revoked-session authorization; and real database read/write. The revoked-session
fixture creates a session, revokes/signs it out before any application request or
cache lookup, then presents that token for its first application use; the exact
`401` body must arrive within 10 seconds. Existing cached-token revocation latency
(up to 15 seconds) is an E03 residual risk and is neither changed nor hidden by
E01. All rehearsal writes are destroyed with the environment.

Production reconciliation is strictly read-only: catalogue/role/metadata queries,
Cloud Run metadata, `GET /health`, and anonymous Data API HTTP probes only.

## 7. Probe classification

The public-projection allowlist is empty: all 22 current tables are internal.
Each target is first proven to exist through catalogue metadata, then receives an
individual verdict. Missing targets, missing credentials, skips, timeouts, network
or transport errors, 404s, constraint errors, and unexpected `2xx` empty results
are failures, never denials.

- Direct SQL denial accepts only `42501` (`insufficient_privilege`) or the exact
  RLS denial applicable to the attempted operation after existence is proven.
- Anonymous Data API table probes accept `401`, `403`, or a PostgREST permission
  response whose code is exactly `42501`; `200` is always failure for this empty
  projection allowlist.
- Absent, malformed, and revoked-before-first-use token probes accept only HTTP
  `401` and byte-equivalent JSON `{"error":"Sign in to continue"}`.
- Foreign import read and foreign import cancel probes accept only HTTP `404` and
  byte-equivalent JSON `{"error":"Import not found"}`.
- The two JSON bodies above are frozen legacy bodies, not error codes. E01 must
  not introduce `AUTH_REQUIRED`, problem-details, or replacement error shapes;
  that belongs to E03.

Every probe has an explicit timeout no greater than 10 seconds. Schema privileges,
role inheritance/memberships, object grants, RLS enablement/policy role arrays,
and default ACLs are distinct assertions. Live production probes never write.

## 8. Binary command and evidence gates

The branch must expose and run these exact commands from a clean checkout:

The complete assertion inventory is the scope-owned
`e01-assertion-manifest.json`, SHA-256
`f03c782f6e9c1be5bcf9e3975b6c25ce0e1df8cc865b67e2b8f7e1ddf6ed07f7`.
That manifest enumerates all 492 globally unique assertion IDs with command,
category, target, setup, exact predicate, per-assertion timeout, and evidence
class. Its totals are mechanically derived and must equal the table below. Any
manifest byte change invalidates this design verdict and requires a new scope
version and independent design review before implementation continues.

| Command | Required result |
|---|---|
| `npm ci && npm run build && npm run typecheck` | 3/3 gates pass; zero skipped gates |
| `cd server && npm ci && npm run build && npm run typecheck` | 3/3 gates pass |
| `cd server && npm run pipeline:test` | 9/9 contract assertions pass: the existing pipeline suite exit gate plus exactly 8 CORS assertions |
| `cd server && npm run security:unit` | 32/32 assertions pass: 12 runtime-config, 10 redaction/safe-error, 4 liveness, and 6 evidence-schema/classification assertions |
| `cd server && npm run security:migration` | 105/105 assertions pass: 2 artifact-integrity, 1 journal, 22 table/RLS, 19 policy, 54 runtime-grant, 3 runtime-denial, and 4 role-posture assertions |
| `cd server && npm run security:rehearsal` | 179/179 assertions pass: the 105 migration assertions, 12 effective/default/inherited-access, 22 anonymous Data API, 8 CORS, 8 startup/private-identity, 4 secret-metadata fixture, 8 safe-error, 4 liveness/config-negative, 3 auth-token, 2 foreign-import, 2 real read/write, and 1 teardown assertion |
| `cd server && npm run security:production-readonly` | 147/147 assertions pass: 22 table/RLS, 19 policy, 54 grant, 4 role-posture, 12 effective-browser-access, 22 anonymous HTTP, 3 migration/artifact, 9 deployment/secret-metadata, 1 database-current-user, and 1 liveness assertion; no writes |
| `cd server && npm run security:forbidden-scope` | 12/12 rules pass: no 0012, 0013, actor helpers, worker, standby, Cloud Tasks, permanent staging topology, role/password mutation, secret mutation, deploy/traffic mutation, credential CLIs, or secret/placeholder leakage outside named documentation/evidence fixtures |
| `npm audit --omit=dev && cd server && npm audit --omit=dev` | 2/2 reports exit 0 with zero known production vulnerabilities |

The counts and category inventory in the table above are immutable contract
inputs, not values selected after seeing test output. Every assertion has a
stable ID in the committed test manifest and is reported exactly once. A failed,
skipped, TODO, duplicate, missing, or unexpected assertion fails its command.

Evidence uses a two-commit lifecycle. First freeze a clean tested source commit
`S` containing all code, configuration, dependencies, migrations, documentation,
tests, manifests, and gate definitions. Record `S`, `S^{tree}`, every command,
start/end timestamps, exit status, exact expected/actual/pass/fail/skip/TODO
counts, normalized stdout/stderr paths and SHA-256 hashes, environment class, and
rehearsal identifiers in `evidence/E01/command-manifest.json`. Commit only
`evidence/E01/**` in a subsequent evidence commit `E`. The complete diff `S..E`
must contain only those named evidence paths. Handoff documentation is finalized
in `S`; independent design/final review JSON may remain in the Fedora automation
log store with recorded hashes and need not change the Git branch.

At final HEAD `E`, rerun every deterministic gate and the Fedora
production-readonly gate, recording `E`, its tree, command logs, and hashes in the
external final-review bundle. The source/config/dependency/migration/gate tree
must be identical to `S`; any change to those paths after a result was produced
invalidates every result and requires a new source commit plus a complete rerun.
There may be no commit after the approving final review and before push/PR/merge.
Placeholders and empty suites fail.

Any baseline exception must be individually named, reproduced unchanged at base
`b9b9a27585dc771b7755a07c9a28a66cce9ae520`, proven unrelated with both logs and
hashes, and separately approved in the final review. Otherwise any red command
blocks merge.

Deterministic generated evidence is regenerated in a clean checkout and must be
byte-stable after normalization. Timestamped live evidence is immutable and must
record schema version, source/control plane, project/service identifiers, source
commit, observation timestamp, redaction version, and SHA-256. Historical archive
evidence must be labelled historical with original commit/hash and independently
reconciled; it may not masquerade as a fresh result.

## 9. Acceptance and handoff

E01 is mergeable only when all of the following are true:

1. The diff is limited to this contract and contains no partial E02-E05/E22 work.
2. Exact 0011 bytes, snapshot, journal entry, 22 tables, 19 policies, and 54 grants
   reconcile with the live migration history through an authorized read-only
   administrative path.
3. Live evidence proves the serving revision/digest/build, 100% traffic, exact
   service account `forma-api@tempo-chess-neri.iam.gserviceaccount.com`, Secret
   Manager reference, and truthfully records the live absence of `DATABASE_ROLE`.
   A Fedora-only probe loads pinned secret version 1 into process memory, emits
   or persists none of its payload, requires base role `forma_api`, project ref
   `oqsjfmgdovvepncbphvk`, and Supavisor port `6543`, then proves `current_user`
   is exactly `forma_api` through that same URL. It also proves 22/22 RLS, zero
   effective browser access, successful liveness, and all anonymous denials.
4. The disposable rehearsal passes every migration, runtime, authorization,
   CORS, safe-error, read/write, negative, and teardown assertion.
5. Every command gate above is green with its frozen exact counts, zero skips,
   zero TODO/placeholders, and no unapproved baseline exception.
6. Runbook gives forward recovery from frozen 0011 without down-migrations or an
   imaginary 0012/0013 rollout; docs name residual ACL/tenant/provenance risks and
   exact downstream Linear ownership.
7. Final evidence contains base/head commits, changed-file inventory, clean
   worktree proof, commands/counts, artifact hashes, migration reconciliation,
   production and rehearsal identifiers, teardown, residual risks, and rollback.
8. A fresh independent Codex final review of the complete clean branch returns
   zero blocking findings before the implementation branch is pushed, opened as
   a PR, or merged. All checks rerun after current `main` is integrated.

The final review JSON and design review JSON are retained with their model,
prompt/contract SHA-256, commit, timestamp, verdict, findings, and evidence. Only
after the final approval may the authorized push/PR/check/merge sequence occur.

The production-readonly check compares, rather than repairs, the exact values
above. It rejects the default Compute service account and every service account,
port, role, project ref, or secret reference not named by this contract. It must
report `DATABASE_ROLE` as absent for the pinned serving revision and must neither
claim that this branch-only invariant is deployed nor treat the known absence as
an unexpected probe failure. Every other mismatch is a hard failure and the probe
must stop without deployment, traffic, secret, or configuration mutation.
