# E01 runbook — frozen containment

Contract: `docs/security/E01-recovery-scope.md` (version 5, SHA-256
`99df48003e135c53347dc5711c05c9dabc4d309379751943dcf87d110445f462`).
Assertion inventory: `docs/security/E01-assertion-manifest.json` (SHA-256
`f03c782f6e9c1be5bcf9e3975b6c25ce0e1df8cc865b67e2b8f7e1ddf6ed07f7`).

## What is already true in production

`0011_e01_containment` is applied. This branch does not apply it, does not
re-apply it, and applies no migration at all. The live migration history records
checksum `212a833c84f204460c95f6b1a1eba1ff6d0d22088085a2fdd13a867ac5d9dcb7` at
`created_at = 1786840279694`, which reconciles with the committed artifact and
the single journal entry `idx=11`.

## Running the gates

From a clean checkout:

```
npm ci && npm run build && npm run typecheck                 # 3 gates
cd server && npm ci && npm run build && npm run typecheck    # 3 gates
cd server && npm run pipeline:test                           # 9 assertions
cd server && npm run security:unit                           # 32 assertions
cd server && npm run security:migration                      # 105 assertions
cd server && npm run security:rehearsal                      # 179 assertions
cd server && npm run security:production-readonly            # 147 assertions
cd server && npm run security:forbidden-scope                # 12 rules
npm audit --omit=dev && cd server && npm audit --omit=dev     # 2 reports
```

`security:rehearsal` needs a local container runtime. Start the Podman API
socket first:

```
systemctl --user start podman.socket
export DOCKER_HOST=unix:///run/user/$(id -u)/podman/podman.sock
```

The rehearsal creates its own disposable stack in a scratch directory under
`$TMPDIR`, on ports shifted clear of the Supabase CLI defaults, and destroys it
before the command exits. `REH-END-001` fails if a container, the working
directory, or a usable database connection survives.

`security:production-readonly` is a Fedora final-evidence gate. It is
categorically excluded from CI, needs `gcloud` and a Supabase access token, and
reads production only: `select`-only catalogue queries through the read-only
administrative path, `gcloud run services describe`, anonymous `GET`s, and one
unauthenticated `GET /health`.

## Forward recovery

There is no down-migration and there is no 0012 or 0013. Recovery from a
containment problem is a *new, reviewed forward migration*, authored and gated
the same way 0011 was. Do not hand-apply DDL, and do not re-run 0011 expecting a
rollback: it is forward-only and repeatable, so re-running it re-asserts
containment rather than undoing it.

If the runtime loses database access after a containment change:

1. Confirm the serving revision is still `tempo-chess-api-00004-8dk` with 100%
   traffic (`gcloud run services describe`, read-only). E01 changes no traffic.
2. Run `security:production-readonly`. It compares rather than repairs, and
   names the first mismatch.
3. If a grant or policy is genuinely missing, write a forward migration that
   restores exactly the 54 grants and 19 policies in
   `docs/security/E01-grant-rls-matrix.md`. Get it reviewed. Apply it through the
   normal migration path.
4. Do not widen a policy to `anon`, `authenticated`, or `PUBLIC`, and do not use
   the owner or `service_role` as an application fix. Both re-open A-01.

## Deliberately not here

Credential rotation, Secret Manager mutation, deployment, traffic changes, and
service configuration are all out of scope for E01 recovery and have no runbook
entry, because there is no supported procedure on this branch. They belong to
E05.
