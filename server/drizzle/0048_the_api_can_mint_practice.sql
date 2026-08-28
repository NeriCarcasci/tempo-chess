-- 0048_the_api_can_mint_practice
--
-- Give `forma_api` the writes the practice surface has needed since E18
-- mounted it. Hand-written and reviewed. Grants only: no schema change, no
-- policy change, no row touched, and GRANT is idempotent so re-running this
-- really is a no-op.
--
-- ## What broke
--
-- `POST /v1/practice/refill` mints a drill by inserting a training item, its
-- version, an intervention and a learning assignment, and both practice
-- writes register the selector in the component catalogue first so every
-- assignment can cite the version that chose it. The route runs as
-- `forma_api`, and `forma_api` held INSERT on none of those tables -- the
-- practice epic granted it `practice_attempts` and `review_schedules` (the
-- attempt path's own rows) and stopped there, so the mint path was written,
-- tested against fixtures, and never executable over HTTP.
--
-- It never surfaced as an error because the selector's mistakes query ran
-- before any insert and, off the actor context, saw zero rows (see the route
-- fix that lands with this migration): every refill answered `no_material`
-- and no insert was ever attempted. Two bugs standing in front of each other.
--
-- ## Why this is not a hole
--
-- The tables carry no row level security; the API is the boundary, exactly as
-- it already is for `practice_attempts`, which `forma_api` could always
-- insert. Every routed write resolves the subject from the verified actor and
-- never from the request, so these grants let the API do for the mint path
-- what it already does for the attempt path. `forma_analysis` keeps every
-- grant it had; nothing is revoked and no browser-facing role gains anything.
--
-- The catalogue inserts are the narrow ones worth a second look. The
-- component registry is append-only and content-hashed: re-registering the
-- same bytes finds the existing row, and registering different bytes under an
-- existing version is refused by constraint. INSERT there lets the API record
-- "this selector, this configuration" and nothing else.

set local role forma_migrator
--> statement-breakpoint
grant insert on coaching.training_items to forma_api
--> statement-breakpoint
grant insert on coaching.training_item_versions to forma_api
--> statement-breakpoint
grant insert on coaching.interventions to forma_api
--> statement-breakpoint
grant insert on coaching.learning_assignments to forma_api
--> statement-breakpoint
-- The attempt path closes an assignment it completes and reopens one it
-- fails; both are UPDATEs the first version of the route could never make.
grant update on coaching.learning_assignments to forma_api
--> statement-breakpoint
grant insert on analysis.components to forma_api
--> statement-breakpoint
grant insert on analysis.component_versions to forma_api
--> statement-breakpoint
grant insert on analysis.component_version_dependencies to forma_api
--> statement-breakpoint
reset role
