/**
 * The frozen E01 containment contract.
 *
 * Every value here is an immutable input taken from the approved recovery scope
 * (`docs/security/E01-recovery-scope.md`, contract version 5). Nothing in this
 * file may be derived from observed output: the gates compare reality against
 * these constants, never the other way round. Changing a value here changes the
 * contract and invalidates the design verdict.
 */

export const CONTRACT_VERSION = 5;

/** The role the deployed API is allowed to connect as. Nothing else. */
export const RUNTIME_ROLE = "forma_api";

/**
 * Frozen in 0011 but inert in E01: no credential, job, connection, or
 * operational path exists for it on this branch.
 */
export const MIGRATOR_ROLE = "forma_migrator";

/** Roles a browser can reach. None of them may retain effective access. */
export const DENIED_ROLES = ["PUBLIC", "anon", "authenticated"] as const;
export type DeniedRole = (typeof DENIED_ROLES)[number];

/** The access classes proven separately for each denied role. */
export const ACCESS_CLASSES = ["schema", "tables", "sequences", "routines"] as const;
export type AccessClass = (typeof ACCESS_CLASSES)[number];

/** Roles the runtime must never connect as. */
export const OWNER_ROLE = "postgres";

/**
 * Every least-privilege role a Forma deployment may serve as.
 *
 * Added by E04, additive to the frozen E01 values above and changing none of
 * them. E01's finding was that the runtime connected as the *owner*; E02 then
 * created one least-privilege role per deployment precisely so each service
 * could connect as itself. Until this list existed, `inspectRuntimeConfig`
 * accepted only `forma_api`, which meant the ops and worker deployments E04's
 * private endpoints belong to could not have started at all.
 *
 * `postgres` and `forma_migrator` are still refused, as are `anon`,
 * `authenticated` and `service_role` — they are not in this list and every role
 * here is scoped by its own grants in 0012, 0013 and 0014.
 */
export const DEPLOYMENT_ROLES = [
  RUNTIME_ROLE,
  "forma_ops",
  "forma_ingestion",
  "forma_stockfish",
  "forma_analysis",
] as const;
export type DeploymentRole = (typeof DEPLOYMENT_ROLES)[number];

export function isDeploymentRole(role: string | undefined): role is DeploymentRole {
  return (DEPLOYMENT_ROLES as readonly string[]).includes(role ?? "");
}

/**
 * The exact 22-table allowlist. All 22 are internal: the public-projection
 * allowlist is empty, so an anonymous `200` on any of them is a failure.
 */
export const CONTAINED_TABLES = [
  "analysis_imports",
  "analysis_tasks",
  "beta_signups",
  "canonical_moves",
  "game_sources",
  "games",
  "lesson_progress",
  "linked_accounts",
  "mistakes",
  "opening_drills",
  "opening_edges",
  "opening_positions",
  "opening_repertoire_moves",
  "opening_training_results",
  "player_opening_observations",
  "player_opening_stats",
  "player_style",
  "position_eval",
  "profiles",
  "puzzles",
  "repertoire_openings",
  "usage_events",
] as const;
export type ContainedTable = (typeof CONTAINED_TABLES)[number];

/** The public-projection allowlist is empty by contract. */
export const PUBLIC_PROJECTION_ALLOWLIST: readonly string[] = [];

/** Tables that carry no runtime grant at all. */
export const NO_RUNTIME_GRANT_TABLES = [
  "player_opening_stats",
  "player_style",
  "puzzles",
] as const;

/** The 19 tables that carry the containment policy — every table except the three above. */
export const POLICY_TABLES = CONTAINED_TABLES.filter(
  (table) => !(NO_RUNTIME_GRANT_TABLES as readonly string[]).includes(table),
);

/** The one policy name shape frozen by 0011. */
export function policyName(table: string): string {
  return `${table}_${RUNTIME_ROLE}_service_dataplane`;
}

/**
 * The immutable historical containment policy shape. It provides role scoping
 * only — `USING (true)` is not tenant authorization, and application-level
 * authorization stays residual risk until E02/E03.
 */
export const POLICY_SHAPE = {
  roles: [RUNTIME_ROLE],
  command: "ALL",
  permissive: true,
  qual: "true",
  withCheck: "true",
} as const;

export type Privilege = "SELECT" | "INSERT" | "UPDATE" | "DELETE";

/**
 * The exact 54 `forma_api` table grants. The privilege lists are sorted so the
 * grant inventory is order-independent, and the total is asserted below.
 */
export const RUNTIME_GRANTS: Readonly<Record<string, readonly Privilege[]>> = {
  analysis_imports: ["INSERT", "SELECT", "UPDATE"],
  analysis_tasks: ["INSERT", "SELECT", "UPDATE"],
  beta_signups: ["INSERT", "SELECT", "UPDATE"],
  game_sources: ["INSERT", "SELECT", "UPDATE"],
  games: ["INSERT", "SELECT", "UPDATE"],
  lesson_progress: ["INSERT", "SELECT", "UPDATE"],
  linked_accounts: ["INSERT", "SELECT", "UPDATE"],
  opening_drills: ["INSERT", "SELECT", "UPDATE"],
  opening_edges: ["INSERT", "SELECT", "UPDATE"],
  opening_positions: ["INSERT", "SELECT", "UPDATE"],
  player_opening_observations: ["INSERT", "SELECT", "UPDATE"],
  canonical_moves: ["DELETE", "INSERT", "SELECT"],
  repertoire_openings: ["DELETE", "INSERT", "SELECT"],
  opening_repertoire_moves: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  profiles: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  mistakes: ["SELECT"],
  opening_training_results: ["INSERT", "SELECT"],
  position_eval: ["INSERT", "SELECT"],
  usage_events: ["INSERT", "SELECT"],
};

/** Every `table:PRIVILEGE` pair the runtime role is allowed to hold. */
export const RUNTIME_GRANT_PAIRS: readonly string[] = Object.entries(RUNTIME_GRANTS)
  .flatMap(([table, privileges]) => privileges.map((privilege) => `${table}:${privilege}`));

/** Role attributes frozen by 0011 for both named roles. */
export const ROLE_ATTRIBUTES = {
  rolcanlogin: true,
  rolinherit: false,
  rolsuper: false,
  rolcreatedb: false,
  rolcreaterole: false,
  rolbypassrls: false,
} as const;

/** The exact already-applied migration artifacts. No migration is applied by E01. */
export const MIGRATION_ARTIFACTS = {
  sql: {
    path: "server/drizzle/0011_e01_containment.sql",
    bytes: 27497,
    sha256: "212a833c84f204460c95f6b1a1eba1ff6d0d22088085a2fdd13a867ac5d9dcb7",
  },
  snapshot: {
    path: "server/drizzle/meta/0011_snapshot.json",
    bytes: 94395,
    sha256: "3ae5f06bff21114923984933206ec850d3f82097eccd200c3ba793a4dce7ccc1",
  },
} as const;

/** The only journal addition E01 makes. */
export const JOURNAL_ENTRY = {
  idx: 11,
  version: "7",
  when: 1786840279694,
  tag: "0011_e01_containment",
  breakpoints: true,
} as const;

/** The exact deployed CORS allowlist. A wildcard fallback is forbidden. */
export const ALLOWED_ORIGINS = [
  "https://forma-chess.pages.dev",
  "https://formachess.com",
  "https://www.formachess.com",
] as const;

/**
 * Observed-live production facts. These are compared, never repaired: E01 makes
 * no deployment, traffic, secret, or configuration change.
 */
export const PRODUCTION = {
  projectRef: "oqsjfmgdovvepncbphvk",
  poolerPort: 6543,
  gcpProject: "tempo-chess-neri",
  region: "europe-west1",
  service: "tempo-chess-api",
  revision: "tempo-chess-api-00004-8dk",
  imageDigest: "sha256:50e141014412d3178117daa0a7cc94497ab12cf3beb6e76b925497f9c930f929",
  buildId: "ad7210a8-089c-4046-8a84-f7a663cd2d02",
  sourceGeneration: "1786818211613533",
  /** The deployed source bundle carries no Git metadata. This stays unknown. */
  gitSourceCommit: "unknown",
  serviceAccount: "forma-api@tempo-chess-neri.iam.gserviceaccount.com",
  defaultComputeServiceAccountSuffix: "-compute@developer.gserviceaccount.com",
  healthUrl: "https://tempo-chess-api-384112442354.europe-west1.run.app/health",
  restUrl: "https://oqsjfmgdovvepncbphvk.supabase.co/rest/v1",
} as const;

/** The exact Secret Manager binding the serving revision must use. */
export const SECRET_BINDING = {
  envName: "DATABASE_URL",
  secretName: "forma-api-db-url",
  secretKey: "1",
  versionMarkerEnv: "DATABASE_URL_SECRET_VERSION",
  versionMarker: "projects/tempo-chess-neri/secrets/forma-api-db-url/versions/1",
} as const;

/**
 * A branch and disposable-rehearsal startup invariant. The latest retained
 * complete environment inventory for the serving revision does not contain it:
 * that is observed live configuration drift owned by E05, not evidence that the
 * marker is deployed. E01 records the absence and changes nothing.
 */
export const ROLE_MARKER_ENV = "DATABASE_ROLE";

/** Projects the rehearsal must never touch. */
export const FORBIDDEN_TARGET_REFS = [
  PRODUCTION.projectRef,
  /** Unrelated Eireplan project. */
  "ydygbectaakvxtqesvya",
] as const;

/** The two frozen legacy error bodies. They are not stable error codes; E03 owns replacements. */
export const UNAUTHENTICATED_BODY = { error: "Sign in to continue" } as const;
export const IMPORT_NOT_FOUND_BODY = { error: "Import not found" } as const;

/** The only Postgres error code that counts as a direct SQL denial. */
export const INSUFFICIENT_PRIVILEGE = "42501";

/** No probe may exceed this, and a timeout is a failure, never a denial. */
export const MAX_PROBE_TIMEOUT_SECONDS = 10;

// --- self-consistency with the contract's frozen counts --------------------

function freeze(label: string, actual: number, expected: number): void {
  if (actual !== expected) {
    throw new Error(`E01 contract drift: ${label} is ${actual}, contract froze ${expected}`);
  }
}

freeze("contained tables", CONTAINED_TABLES.length, 22);
freeze("policy tables", POLICY_TABLES.length, 19);
freeze("runtime grant pairs", RUNTIME_GRANT_PAIRS.length, 54);
freeze("no-runtime-grant tables", NO_RUNTIME_GRANT_TABLES.length, 3);
freeze("allowed origins", ALLOWED_ORIGINS.length, 3);
freeze("denied roles", DENIED_ROLES.length, 3);
