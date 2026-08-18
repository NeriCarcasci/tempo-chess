-- 0015_e05_service_topology
--
-- E05 — the deployed service topology's database half: each service role is
-- capped at the connections its deployment can actually hold.
--
-- Hand-written and reviewed, like 0011 through 0014. Applied by
-- `npm run db:migrate`.
--
-- Additive and forward-only. It creates nothing, drops nothing, and touches no
-- row. It sets a per-role `CONNECTION LIMIT` equal to that service's peak in the
-- E02 connection budget (docs/platform/E02-runbook.md): `max instances` times
-- `pool per instance`. Re-running it is a no-op, because setting a role's limit
-- to the value it already has is idempotent by definition.
--
-- Why this is worth a migration rather than a runbook note. The pool size is
-- configured inside each service, so a service that is misconfigured, restarted
-- in a loop, or scaled past its budget can open more connections than the table
-- allocates and starve every other service. `ALTER ROLE ... CONNECTION LIMIT`
-- is the only place that ceiling holds regardless of what the client believes.
-- `server/src/platform/topology.test.ts` fails if these numbers and the budget
-- ever disagree.
--
-- Rollback is a paired forward migration setting the limits back to -1
-- (unlimited). No data is at risk either way.

-- Applied by the deploying role, not by `forma_migrator`. Altering or
-- commenting on a role is role administration and requires CREATEROLE, which
-- 0012 deliberately withholds from `forma_migrator` (NOCREATEROLE). This is the
-- same posture 0012 itself used when it created and commented on these roles;
-- see docs/platform/E02-runbook.md, "Applying it". There is no `set local role`
-- here for that reason.
--
-- forma-api: 6 instances x 3 connections.
alter role forma_api connection limit 18
--> statement-breakpoint
-- forma-ops: 2 instances x 2 connections.
alter role forma_ops connection limit 4
--> statement-breakpoint
-- forma-ingestion: 4 instances x 2 connections.
alter role forma_ingestion connection limit 8
--> statement-breakpoint
-- forma-stockfish: 6 instances x 1 connection.
alter role forma_stockfish connection limit 6
--> statement-breakpoint
-- forma-analysis: 3 instances x 2 connections.
alter role forma_analysis connection limit 6
--> statement-breakpoint
-- The migrator keeps the 3 connections the budget reserves for migration jobs,
-- so a stuck migration cannot consume the operator headroom as well.
alter role forma_migrator connection limit 3
--> statement-breakpoint
comment on role forma_api is 'E02 runtime API role. E05 caps it at its 6x3 connection budget peak.'
--> statement-breakpoint
comment on role forma_ops is 'E02 ops role. E05 caps it at its 2x2 connection budget peak.'
--> statement-breakpoint
comment on role forma_ingestion is 'E02 ingestion role. E05 caps it at its 4x2 connection budget peak.'
--> statement-breakpoint
comment on role forma_stockfish is 'E02 engine role. E05 caps it at its 6x1 connection budget peak.'
--> statement-breakpoint
comment on role forma_analysis is 'E02 analysis role. E05 caps it at its 3x2 connection budget peak.'
