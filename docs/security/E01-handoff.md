# E01 handoff

## What this branch is

The E01 containment epic, closed as a *recorded and independently verified*
containment. Production was already contained by `0011_e01_containment`; this
branch commits the exact frozen artifacts, proves the containment three
independent ways, and hands the residual risks to their owning epics.

Contract: `docs/security/E01-recovery-scope.md` (v5,
`99df48003e135c53347dc5711c05c9dabc4d309379751943dcf87d110445f462`).
Inventory: `docs/security/E01-assertion-manifest.json`
(`f03c782f6e9c1be5bcf9e3975b6c25ce0e1df8cc865b67e2b8f7e1ddf6ed07f7`),
492 assertions. Both are committed byte-for-byte so the gate is reproducible.

## The three proofs

| Gate | Source of truth | Assertions |
|---|---|---|
| `security:migration` | deterministic replay of the exact 0011 over a production-shaped pre-0011 fixture | 105 |
| `security:rehearsal` | a disposable Postgres that is first *re-exposed* the way the audit found production, then closed by the exact 0011 | 179 |
| `security:production-readonly` | the live catalogue and control plane, read-only | 147 |

The same predicates (`server/src/security/catalogue.ts`) are evaluated in all
three, so the three results are comparable rather than three different questions.

## Commands and exact counts

| Command | Result |
|---|---|
| `npm ci && npm run build && npm run typecheck` | 3/3 |
| `cd server && npm ci && npm run build && npm run typecheck` | 3/3 |
| `cd server && npm run pipeline:test` | 9/9 |
| `cd server && npm run security:unit` | 32/32 |
| `cd server && npm run security:migration` | 105/105 |
| `cd server && npm run security:rehearsal` | 179/179 |
| `cd server && npm run security:production-readonly` | 147/147 |
| `cd server && npm run security:forbidden-scope` | 12/12 |
| `npm audit --omit=dev && cd server && npm audit --omit=dev` | 2/2, zero vulnerabilities |

Every assertion reports exactly once. There is no skip, TODO, duplicate, missing,
or unexpected result; `security:unit` proves the validator rejects each of those
conditions.

## Runtime changes on this branch

All branch-only. None is deployed by E01.

- `server/src/cors.ts` — exact three-origin allowlist, echoed `Origin`,
  `Vary: Origin` exactly once, disallowed preflight refused with 403, no
  wildcard fallback (a deployed process with an empty or `*` allowlist refuses to
  start). Replaces `hono/cors`, which fell back to `*` whenever the origin
  variable was unset — which is what production is doing now, because the
  revision sets `WEB_ORIGINS` and the deployed code read `WEB_ORIGIN`.
- `server/src/db/client.ts` — startup gate: base role must be `forma_api`, port
  must be 6543 when deployed, `DATABASE_ROLE` must be present and match. Findings
  name fields, never values.
- `server/src/security/identity.ts` — the private `select current_user` check.
  Not a route; E01 adds no public readiness or identity endpoint.
- `server/src/security/redaction.ts` plus call sites in `index.ts` — raw
  exception messages, SQL, driver detail, URLs, credentials, tokens, and
  row/provider payloads no longer reach a client body or a log line. The legacy
  body shape `{"error":"..."}` is unchanged; no problem-details, no error codes,
  no request IDs.

The two frozen legacy bodies are byte-exact and stay that way:
`{"error":"Sign in to continue"}` and `{"error":"Import not found"}`.

## Dependency changes

Required to make `AUDIT-001`/`AUDIT-002` green; both were red at the base commit.

- root: the `react-router` family pinned `8.0.0` to `8.3.0` (RSC-mode CSRF
  bypass, 4 high). Lockfile regenerated because the old pins blocked resolution.
- server: `npm audit fix` for `hono`, `@hono/node-server`, `fast-xml-parser`,
  `gaxios`; a `uuid: ^11.1.0` override for the remaining transitive advisories,
  because npm's only other suggestion was a semver-major *downgrade* of
  `@google-cloud/storage`.

## Ownership handed on

| Risk | Owner |
|---|---|
| Tenant authorization; target schemas, roles, default privileges, RLS harness | E02 |
| JWT/actor/request/error/API kernel; cached-token revocation latency | E03 |
| Durable workflows | E04 |
| Staging and service topology; deployment and credential recovery; live `DATABASE_ROLE`; source-to-revision correction | E05 |
| Alerting, rotation cadence, load, recovery, cost, launch sign-off | E22 |

Full detail in `docs/security/E01-incident-note.md`.

## What a reviewer should check first

1. The two committed contract artifacts hash to the values above.
2. `server/drizzle/0011_e01_containment.sql` is 27,497 bytes,
   `212a833c84f204460c95f6b1a1eba1ff6d0d22088085a2fdd13a867ac5d9dcb7`; the
   snapshot is 94,395 bytes, `3ae5f06bff21114923984933206ec850d3f82097eccd200c3ba793a4dce7ccc1`;
   the journal gains only `idx=11`.
3. `security:forbidden-scope` names its exclusions in its own output. They are
   individually listed paths — the contract documents, the synthetic fixture
   file, and the scanner itself — never patterns.
4. `evidence/E01/command-manifest.json` records the source commit `S`, its tree,
   every command, counts, exit status, log hashes, and the rehearsal identifier.
