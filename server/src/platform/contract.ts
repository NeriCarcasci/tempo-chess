/**
 * The E02 platform contract.
 *
 * Eight additive namespaces, six named roles, the schema grants each role
 * receives, and the transaction-local actor helpers. This module is the
 * *expectation*; `server/drizzle/0012_e02_platform_foundation.sql` is the
 * reviewed authority that creates the objects, and the gates connect to a real
 * database to check one against the other.
 *
 * Nothing here generates SQL. The migration is hand-written, committed, and
 * applied by the repository's existing Drizzle migration path.
 */

/** How a schema's contents are governed. Recorded in `ops.schema_catalogue`. */
export interface SchemaEntry {
  readonly name: string;
  /** Owning service domain, matching plans/database-architecture.md §4. */
  readonly purpose: string;
  /** Reachable by `anon`/`authenticated` through the Supabase Data API. */
  readonly browserExposed: boolean;
  /** Default data class for rows in the schema. */
  readonly dataClass: "user_owned" | "shared_canonical" | "operational" | "none";
  /** Default retention treatment for rows in the schema. */
  readonly retention: "subject_deletion" | "reference_counted" | "operational_window" | "none";
}

export const SCHEMAS: readonly SchemaEntry[] = [
  {
    name: "app",
    purpose: "Profiles, analysis subjects, linked accounts, entitlements",
    browserExposed: false,
    dataClass: "user_owned",
    retention: "subject_deletion",
  },
  {
    name: "social",
    purpose: "Public player directory projections and future relationships",
    browserExposed: false,
    dataClass: "user_owned",
    retention: "subject_deletion",
  },
  {
    name: "chess",
    purpose: "Provider games, immutable replay revisions, positions, transitions",
    browserExposed: false,
    dataClass: "shared_canonical",
    retention: "reference_counted",
  },
  {
    name: "analysis",
    purpose: "Methods, runs, evaluations, evidence, estimates, findings",
    browserExposed: false,
    dataClass: "user_owned",
    retention: "subject_deletion",
  },
  {
    name: "coaching",
    purpose: "Onboarding, reports, goals, practice, transfer",
    browserExposed: false,
    dataClass: "user_owned",
    retention: "subject_deletion",
  },
  {
    name: "ops",
    purpose: "Syncs, work ledger, outbox, deletion workflows",
    browserExposed: false,
    dataClass: "operational",
    retention: "operational_window",
  },
  {
    name: "api",
    purpose: "Deliberately exposed security-invoker views and functions, if ever needed",
    browserExposed: false,
    dataClass: "none",
    retention: "none",
  },
  {
    name: "private",
    purpose: "Privileged helper functions and authorization helpers",
    browserExposed: false,
    dataClass: "none",
    retention: "none",
  },
];

export const SCHEMA_NAMES: readonly string[] = SCHEMAS.map((schema) => schema.name);

/**
 * `api` is declared not browser-exposed because it is empty. It becomes opt-in
 * exposed only when a reviewed `security_invoker` view is added there and a
 * later migration grants `anon`/`authenticated` usage on that object. Until
 * then no schema in this list is reachable from a browser role.
 */
export const BROWSER_EXPOSED_SCHEMAS: readonly string[] = SCHEMAS.filter(
  (schema) => schema.browserExposed,
).map((schema) => schema.name);

export interface RoleEntry {
  readonly name: string;
  readonly purpose: string;
  /** Schemas the role receives `USAGE` on. Table grants are always named per table. */
  readonly usage: readonly string[];
  /** The role may bind a verified actor to its transaction. */
  readonly actorContext: boolean;
}

/** Roles that serve traffic or run work. `forma_migrator` is deliberately not here. */
export const RUNTIME_ROLES: readonly RoleEntry[] = [
  {
    name: "forma_api",
    purpose:
      "Request-path role for forma-api. Reads bounded projections and writes commands, workflows, and outbox rows. Owns nothing and never holds BYPASSRLS.",
    usage: ["app", "social", "chess", "analysis", "coaching", "ops", "api", "private"],
    actorContext: true,
  },
  {
    name: "forma_ops",
    purpose:
      "Private-ingress operator role for forma-ops: outbox dispatch, due-sync enqueue, lease recovery, retention and deletion sweeps. Never browser-facing, so no api schema.",
    usage: ["app", "social", "chess", "analysis", "coaching", "ops", "private"],
    actorContext: true,
  },
  {
    name: "forma_ingestion",
    purpose:
      "Provider sync worker role. Reads linked accounts, commits canonical chess records with their sync checkpoint, and advances the ops work ledger. No analysis, coaching, or social access.",
    usage: ["app", "chess", "ops", "private"],
    actorContext: true,
  },
  {
    name: "forma_stockfish",
    purpose:
      "Objective engine worker role. Reads positions and writes immutable evaluation outputs. It never reaches user-owned identity, social, or coaching data and holds no actor helper.",
    usage: ["chess", "analysis", "ops"],
    actorContext: false,
  },
  {
    name: "forma_analysis",
    purpose:
      "Deterministic analysis, estimation, finding, coaching, and publication worker role. Writes subject-owned derived outputs and the social projections it publishes.",
    usage: ["app", "social", "chess", "analysis", "coaching", "ops", "private"],
    actorContext: true,
  },
];

export const MIGRATOR_ROLE = "forma_migrator";

export const MIGRATOR_PURPOSE =
  "Deployment-only owner of every E02 object. Used by the migration job over the direct endpoint and never by request-path traffic. Not a superuser and never granted BYPASSRLS.";

export const ROLE_NAMES: readonly string[] = [
  ...RUNTIME_ROLES.map((role) => role.name),
  MIGRATOR_ROLE,
];

/** Roles that must hold no privilege on any E02 object. */
export const DENIED_ROLES = ["anon", "authenticated", "service_role"] as const;

/**
 * The transaction-local setting carrying the verified actor.
 *
 * It is transaction-local by construction, so a pooled connection cannot carry
 * an actor from one request into the next. It is *not* an authentication
 * boundary: PostgreSQL lets any connected role set a custom GUC directly, so an
 * RLS policy must combine it with the connecting role's grants, and the API is
 * responsible for only ever setting an actor it verified. See
 * docs/platform/E02-runbook.md.
 */
export const ACTOR_SETTING = "forma.actor_id";

export const ACTOR_FUNCTIONS = {
  current: "private.current_actor_id()",
  set: "private.set_actor_context(uuid)",
} as const;

/** The catalogue table seeded from `SCHEMAS`. */
export const SCHEMA_CATALOGUE_TABLE = "ops.schema_catalogue";

/** The one migration this epic adds. */
export const MIGRATION_TAG = "0012_e02_platform_foundation";
