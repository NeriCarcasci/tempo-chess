/**
 * Placeholder configuration for the offline unit gate.
 *
 * The unit gate imports the route registry, which reaches the modules that read
 * `DATABASE_URL` and the Supabase keys at load time — deliberately, because E01
 * makes that a startup gate rather than a lazy getter. None of it connects to
 * anything: `postgres()` opens no socket until a query runs, and the unit gate
 * runs none.
 *
 * These values are shaped to satisfy the gate and are not credentials. They are
 * set only when the variable is absent, so a caller with a real environment
 * keeps it.
 *
 * Imported first, before any module that reads them. Node evaluates imports in
 * source order, so the position of this line in `kernel.test.ts` matters.
 */

process.env.DATABASE_URL ??= "postgresql://forma_api@127.0.0.1:6543/postgres";
process.env.DATABASE_ROLE ??= "forma_api";
process.env.SUPABASE_URL ??= "https://unit.supabase.invalid";
process.env.SUPABASE_ANON_KEY ??= "unit-gate-anon-key";
