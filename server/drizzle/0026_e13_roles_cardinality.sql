-- 0026_e13_roles_cardinality
--
-- E13 — fix a check constraint in 0025 that silently accepted an empty role list.
--
-- Hand-written and reviewed. Additive and forward-only: it replaces one check
-- constraint and touches no row, no column and no other object. Re-running it
-- is a no-op because the drop is `if exists` and the add is idempotent in
-- effect.
--
-- The bug: 0025 wrote
--
--   check (supported_roles <@ array[...] and array_length(supported_roles, 1) > 0)
--
-- `array_length` returns NULL for an empty array rather than 0, so for
-- `supported_roles = '{}'` the second term is `NULL > 0` -> NULL, the whole
-- check evaluates to NULL, and PostgreSQL passes a check that is not FALSE.
-- A concept version supporting no roles was therefore accepted, and would have
-- produced no opportunities while looking like a promoted detector.
--
-- `cardinality` returns 0 for an empty array, so the comparison is a real
-- boolean. Found by attempting the violation against the database rather than
-- by reading the SQL, which is the only way this class of bug shows up.

set local role forma_migrator
--> statement-breakpoint
alter table analysis.concept_versions
  drop constraint if exists concept_versions_roles_known
--> statement-breakpoint
alter table analysis.concept_versions
  add constraint concept_versions_roles_known check (
    supported_roles <@ array['create','recognize','execute','avoid','prevent','respond','convert']::text[]
    and cardinality(supported_roles) > 0
  )
--> statement-breakpoint
reset role
