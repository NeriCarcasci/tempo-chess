/**
 * The deployed service topology, frozen in one place.
 *
 * E05 split one public autoscaling process into five deployments; interactive
 * Maia serving adds a sixth without coupling player latency to offline work.
 * that could disagree about that split — Cloud Run ingress, service accounts,
 * database roles, secrets, queue routing, OIDC audiences, capacity — is derived
 * from this table, so a change lands in one place or fails a test.
 *
 * The capacity numbers are not chosen here. They are the E02 connection budget
 * (docs/platform/E02-runbook.md), which allocates 42 of the 43 Postgres
 * connections available to services. `inspectTopology()` refuses a table that
 * contradicts it, because a raised `maxInstances` that nobody re-derived is how
 * a deployment exhausts the pooler at peak.
 *
 * Sources: plans/v1-platform-spec.md §§6-7 (services and queues),
 * plans/database-architecture.md §35, docs/platform/E02-runbook.md.
 */

import { QUEUES, RESOURCE_CLASSES, type Queue, type ResourceClass } from "../ops/contract.js";
import { DEPLOYMENT_ROLES, type DeploymentRole } from "../security/contract.js";
import { SERVICE_BUDGETS, runtimeConnectionBudget } from "./connection.js";

/**
 * What a deployment is permitted to do. Capabilities are checked at startup and
 * before work is accepted, so "the API must never call Stockfish" is enforced by
 * the process refusing the work rather than by nobody having written the call.
 */
export const CAPABILITIES = [
  "serve_public_requests",
  "dispatch_outbox",
  "provider_traffic",
  "engine_analysis",
  "model_inference",
  "prototype_pipeline",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** The one resource class v1 defines but never schedules. Spec §6.5. */
export const UNSCHEDULED_RESOURCE_CLASS: ResourceClass = "gpu_model";

export interface DeploymentEntry {
  /** Cloud Run service name, and the value of `FORMA_DEPLOYMENT`. */
  readonly name: string;
  /** Only one deployment may be reachable from a browser. Spec §6.1. */
  readonly ingress: "public" | "internal";
  /** Service account id, unique per deployment. */
  readonly serviceAccount: string;
  /** Least-privilege Postgres role created by E02's 0012. */
  readonly databaseRole: DeploymentRole;
  /** Secret Manager secret holding this deployment's own connection string. */
  readonly databaseSecret: string;
  readonly capabilities: readonly Capability[];
  /** Resource classes this deployment executes. Exactly one owner per class. */
  readonly executes: readonly ResourceClass[];
  /** OIDC audience callers must address. Per-service, never shared (D4). */
  readonly audience: string;
  readonly maxInstances: number;
  readonly containerConcurrency: number;
  /** Postgres connections per instance. maxInstances × poolSize is the peak. */
  readonly poolSize: number;
  readonly cpu: string;
  readonly memory: string;
  readonly timeoutSeconds: number;
}

/**
 * `forma-api` is public and executes nothing: it validates, authorizes, serves
 * bounded reads and commits work for someone else to run. The four private
 * deployments each own the capability their name implies.
 */
export const DEPLOYMENTS: readonly DeploymentEntry[] = [
  {
    name: "forma-api",
    ingress: "public",
    serviceAccount: "forma-api",
    databaseRole: "forma_api",
    databaseSecret: "forma-api-db-url",
    capabilities: ["serve_public_requests"],
    executes: [],
    audience: "forma-api",
    maxInstances: 6,
    containerConcurrency: 40,
    poolSize: 3,
    cpu: "1",
    memory: "1Gi",
    timeoutSeconds: 30,
  },
  {
    name: "forma-ops",
    ingress: "internal",
    serviceAccount: "forma-ops",
    databaseRole: "forma_ops",
    databaseSecret: "forma-ops-db-url",
    capabilities: ["dispatch_outbox"],
    executes: ["api_light"],
    audience: "forma-ops",
    maxInstances: 2,
    containerConcurrency: 2,
    poolSize: 2,
    cpu: "1",
    memory: "512Mi",
    timeoutSeconds: 300,
  },
  {
    name: "forma-ingestion",
    ingress: "internal",
    serviceAccount: "forma-ingestion",
    databaseRole: "forma_ingestion",
    databaseSecret: "forma-ingestion-db-url",
    capabilities: ["provider_traffic"],
    executes: ["ingestion"],
    audience: "forma-ingestion",
    maxInstances: 4,
    containerConcurrency: 1,
    poolSize: 2,
    cpu: "1",
    memory: "1Gi",
    timeoutSeconds: 900,
  },
  {
    name: "forma-stockfish",
    ingress: "internal",
    serviceAccount: "forma-stockfish",
    databaseRole: "forma_stockfish",
    databaseSecret: "forma-stockfish-db-url",
    capabilities: ["engine_analysis"],
    executes: ["cpu_engine"],
    audience: "forma-stockfish",
    maxInstances: 6,
    containerConcurrency: 1,
    poolSize: 1,
    cpu: "2",
    memory: "2Gi",
    timeoutSeconds: 900,
  },
  {
    name: "forma-maia",
    ingress: "internal",
    serviceAccount: "forma-maia",
    databaseRole: "forma_maia",
    databaseSecret: "forma-maia-db-url",
    capabilities: ["model_inference"],
    executes: ["cpu_interactive_model"],
    audience: "forma-maia",
    maxInstances: 2,
    containerConcurrency: 1,
    poolSize: 1,
    cpu: "2",
    memory: "2Gi",
    timeoutSeconds: 90,
  },
  {
    name: "forma-analysis",
    ingress: "internal",
    serviceAccount: "forma-analysis",
    databaseRole: "forma_analysis",
    databaseSecret: "forma-analysis-db-url",
    capabilities: ["model_inference"],
    executes: ["cpu_model", "aggregation", "publication"],
    audience: "forma-analysis",
    maxInstances: 2,
    containerConcurrency: 2,
    poolSize: 2,
    cpu: "2",
    memory: "2Gi",
    timeoutSeconds: 900,
  },
] as const;

export type DeploymentName = (typeof DEPLOYMENTS)[number]["name"];

export interface QueueEntry {
  readonly name: Queue;
  readonly target: DeploymentName;
  /** Cloud Tasks max concurrent dispatches. Never more than the target can run. */
  readonly maxConcurrentDispatches: number;
  readonly maxDispatchesPerSecond: number;
  readonly maxAttempts: number;
}

/**
 * Spec §7's queues, routed to the deployment that owns the capability.
 *
 * `maintenance` is the one the spec leaves ambiguous — it names the target
 * "ops/analysis". Decision D1 routes it to `forma-analysis`, recorded in
 * docs/platform/E05-service-topology-contract.md.
 */
export const QUEUE_ROUTES: readonly QueueEntry[] = [
  // Spec §7: one active Lichess request globally.
  {
    name: "provider-lichess",
    target: "forma-ingestion",
    maxConcurrentDispatches: 1,
    maxDispatchesPerSecond: 1,
    maxAttempts: 5,
  },
  {
    name: "provider-chesscom",
    target: "forma-ingestion",
    maxConcurrentDispatches: 2,
    maxDispatchesPerSecond: 2,
    maxAttempts: 5,
  },
  {
    name: "stockfish-screen",
    target: "forma-stockfish",
    maxConcurrentDispatches: 4,
    maxDispatchesPerSecond: 4,
    maxAttempts: 5,
  },
  {
    name: "stockfish-deep",
    target: "forma-stockfish",
    maxConcurrentDispatches: 2,
    maxDispatchesPerSecond: 2,
    maxAttempts: 3,
  },
  {
    name: "maia-play",
    target: "forma-maia",
    maxConcurrentDispatches: 2,
    maxDispatchesPerSecond: 2,
    maxAttempts: 3,
  },
  {
    name: "analysis",
    target: "forma-analysis",
    maxConcurrentDispatches: 3,
    maxDispatchesPerSecond: 3,
    maxAttempts: 5,
  },
  {
    name: "maintenance",
    target: "forma-analysis",
    maxConcurrentDispatches: 1,
    maxDispatchesPerSecond: 1,
    maxAttempts: 3,
  },
] as const;

export interface ScheduleEntry {
  readonly name: string;
  readonly target: DeploymentName;
  readonly path: string;
  readonly schedule: string;
  readonly purpose: string;
}

/** Scheduler triggers. Both drive `forma-ops`; neither carries a payload. */
export const SCHEDULES: readonly ScheduleEntry[] = [
  {
    name: "forma-dispatch-outbox",
    target: "forma-ops",
    path: "/internal/ops/dispatch",
    schedule: "* * * * *",
    purpose: "Publish committed outbox events to Cloud Tasks and enqueue due account syncs.",
  },
  {
    name: "forma-recover-leases",
    target: "forma-ops",
    path: "/internal/ops/recover",
    schedule: "*/5 * * * *",
    purpose: "Recover expired leases and reconcile the queue against the work ledger.",
  },
] as const;

export interface JobEntry {
  readonly name: string;
  readonly serviceAccount: string;
  readonly databaseRole: string;
  readonly command: string;
  readonly purpose: string;
  readonly maxRetries: number;
  readonly timeoutSeconds: number;
}

/** Cloud Run Jobs. Spec §6.6; v1 ships the two the platform cannot run without. */
export const JOBS: readonly JobEntry[] = [
  {
    name: "forma-migrate",
    serviceAccount: "forma-migrator",
    databaseRole: "forma_migrator",
    // Not `npm run db:migrate`: drizzle-kit is a devDependency and the image
    // ships only `dist`. dist/ops/migrate.js uses drizzle-orm's migrator, which
    // is a runtime dependency, against the same folder and the same ledger.
    command: "node dist/ops/migrate.js",
    purpose: "Apply and verify additive migrations from an immutable image.",
    maxRetries: 0,
    timeoutSeconds: 1_800,
  },
  {
    name: "forma-promote",
    serviceAccount: "forma-migrator",
    databaseRole: "forma_migrator",
    // Same reason as the two below: the image ships only `dist`, and tsx is a
    // devDependency.
    //
    // `forma_migrator`, and the grants say why. `forma_analysis` may register
    // components, recipes and validation runs but may not promote: a worker
    // records evidence, it does not choose the method. `forma_ops` may promote
    // but may not record a validation run: an operator cites evidence, it does
    // not manufacture it. That separation is correct and deliberate, and it
    // means no single steady-state role can do both halves of a promotion.
    //
    // A *first* promotion has to do both, because there is no incumbent method
    // and no prior evidence, and establishing initial state is what the
    // migration role is for. Steady-state promotion should be two steps across
    // the two roles rather than this one job run again.
    command: "node dist/analysis/promote.js",
    purpose: "Register the analysis method, validate it against the committed corpus, and promote it.",
    maxRetries: 0,
    timeoutSeconds: 1_800,
  },
  {
    name: "forma-reconcile",
    serviceAccount: "forma-ops",
    databaseRole: "forma_ops",
    // Same reason: `npm run ops:reconcile` runs the TypeScript through tsx.
    command: "node dist/ops/reconcile-report.js",
    purpose: "Additive backfill and queue/ledger reconciliation, resumable by checkpoint.",
    maxRetries: 2,
    timeoutSeconds: 3_600,
  },
] as const;

/**
 * The capacity numbers live in E02's `connection.ts`, which is the authority
 * the runbook's table was derived from. They are restated here because this is
 * what renders the Cloud Run `--max-instances` flag, and a deployment flag that
 * silently disagreed with the pool it was sized for is the failure this epic
 * exists to prevent. `inspectTopology()` fails when the two diverge.
 */
export const CONNECTION_BUDGET_AVAILABLE = runtimeConnectionBudget();

/** Peak connections a deployment may hold: instances × pool. */
export function peakConnections(deployment: DeploymentEntry): number {
  return deployment.maxInstances * deployment.poolSize;
}

export function deploymentByName(name: string): DeploymentEntry | undefined {
  return DEPLOYMENTS.find((entry) => entry.name === name);
}

export function executorOf(resourceClass: ResourceClass): DeploymentEntry | undefined {
  return DEPLOYMENTS.find((entry) => entry.executes.includes(resourceClass));
}

export function queueRoute(queue: Queue): QueueEntry | undefined {
  return QUEUE_ROUTES.find((entry) => entry.name === queue);
}

/**
 * Every way this table can contradict itself or the documents it derives from.
 *
 * Findings are returned rather than thrown, so the unit gate can assert the
 * shipped table is clean while still exercising each rule against a mutated
 * copy — a rule that cannot fail is not a rule.
 */
export function inspectTopology(
  deployments: readonly DeploymentEntry[] = DEPLOYMENTS,
  queues: readonly QueueEntry[] = QUEUE_ROUTES,
): string[] {
  const findings: string[] = [];

  const publics = deployments.filter((entry) => entry.ingress === "public");
  if (publics.length !== 1) {
    findings.push(`exactly one deployment may be browser-public; found ${publics.length}`);
  }
  if (publics[0] && publics[0].executes.length > 0) {
    findings.push(`the public deployment ${publics[0].name} must execute no work items`);
  }

  for (const field of ["name", "serviceAccount", "databaseRole", "databaseSecret", "audience"] as const) {
    const seen = new Set<string>();
    for (const entry of deployments) {
      if (seen.has(entry[field])) {
        findings.push(`${field} ${entry[field]} is shared by more than one deployment`);
      }
      seen.add(entry[field]);
    }
  }

  for (const entry of deployments) {
    if (!(DEPLOYMENT_ROLES as readonly string[]).includes(entry.databaseRole)) {
      findings.push(`${entry.name} uses ${entry.databaseRole}, which is not a deployment role`);
    }
    if (entry.capabilities.includes("prototype_pipeline")) {
      findings.push(`${entry.name} may not hold the prototype in-process pipeline`);
    }
    if (entry.maxInstances < 1 || entry.poolSize < 1 || entry.containerConcurrency < 1) {
      findings.push(`${entry.name} has a non-positive capacity value`);
    }
  }

  for (const capability of ["engine_analysis", "provider_traffic"] as const) {
    const owners = deployments.filter((entry) => entry.capabilities.includes(capability));
    if (owners.length !== 1) {
      findings.push(`${capability} must belong to exactly one deployment; found ${owners.length}`);
    }
    if (owners.some((entry) => entry.ingress === "public")) {
      findings.push(`${capability} must not belong to a browser-public deployment`);
    }
  }

  for (const resourceClass of RESOURCE_CLASSES) {
    const owners = deployments.filter((entry) => entry.executes.includes(resourceClass));
    const expected = resourceClass === UNSCHEDULED_RESOURCE_CLASS ? 0 : 1;
    if (owners.length !== expected) {
      findings.push(
        `resource class ${resourceClass} must have exactly ${expected} executor; found ${owners.length}`,
      );
    }
  }

  for (const queue of QUEUES) {
    if (!queues.some((entry) => entry.name === queue)) {
      findings.push(`queue ${queue} has no route`);
    }
  }
  for (const entry of queues) {
    const target = deployments.find((deployment) => deployment.name === entry.target);
    if (!target) {
      findings.push(`queue ${entry.name} targets unknown deployment ${entry.target}`);
      continue;
    }
    if (target.ingress === "public") {
      findings.push(`queue ${entry.name} must not target the browser-public deployment`);
    }
  }

  // A queue may not dispatch more work than its target can run at once, counting
  // every queue that shares the target.
  for (const target of deployments) {
    const sharing = queues.filter((entry) => entry.target === target.name);
    if (sharing.length === 0) continue;
    const demanded = sharing.reduce((total, entry) => total + entry.maxConcurrentDispatches, 0);
    const capacity = target.maxInstances * target.containerConcurrency;
    if (demanded > capacity) {
      findings.push(
        `queues targeting ${target.name} dispatch up to ${demanded} at once but it can run ${capacity}`,
      );
    }
  }

  // The deployment flags must match the pool E02 sized for this service.
  for (const entry of deployments) {
    const budget = SERVICE_BUDGETS.find((candidate) => candidate.service === entry.name);
    if (!budget) {
      findings.push(`${entry.name} has no connection budget in connection.ts`);
      continue;
    }
    if (budget.maxInstances !== entry.maxInstances || budget.poolPerInstance !== entry.poolSize) {
      findings.push(
        `${entry.name} deploys ${entry.maxInstances}x${entry.poolSize} but is budgeted ` +
          `${budget.maxInstances}x${budget.poolPerInstance}`,
      );
    }
    if (budget.role !== entry.databaseRole) {
      findings.push(`${entry.name} is budgeted for ${budget.role} but deploys as ${entry.databaseRole}`);
    }
  }

  const allocated = deployments.reduce((total, entry) => total + peakConnections(entry), 0);
  if (allocated > CONNECTION_BUDGET_AVAILABLE) {
    findings.push(
      `peak connections ${allocated} exceed the ${CONNECTION_BUDGET_AVAILABLE} available to services`,
    );
  }

  return findings;
}
