/**
 * `npm run e05:unit` — the deployed topology.
 *
 * Deterministic and offline. It proves the shipped table contradicts nothing it
 * is derived from, and that each rule can still fail: every check that asserts
 * the table is clean also mutates a copy and asserts the finding appears, so a
 * rule that silently stopped working fails here rather than in production.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RESOURCE_CLASSES } from "../ops/contract.js";
import { SERVICE_BUDGETS } from "./connection.js";
import {
  CapabilityError,
  assertCapability,
  assertDeploymentIdentity,
  assertExecutes,
  dispatchTargets,
  resolveWorkerEndpoint,
  urlEnvFor,
} from "./deployment.js";
import {
  DEPLOYMENTS,
  JOBS,
  QUEUE_ROUTES,
  SCHEDULES,
  UNSCHEDULED_RESOURCE_CLASS,
  deploymentByName,
  executorOf,
  inspectTopology,
  peakConnections,
  queueRoute,
  type DeploymentEntry,
} from "./topology.js";

let passed = 0;
const failures: string[] = [];

function check(name: string, body: () => string): void {
  try {
    const detail = body();
    passed += 1;
    console.log(`ok   ${name} — ${detail}`);
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    console.log(`FAIL ${name}`);
  }
}

/** A copy of the shipped table with one deployment altered. */
function mutate(name: string, patch: Partial<DeploymentEntry>): DeploymentEntry[] {
  return DEPLOYMENTS.map((entry) => (entry.name === name ? { ...entry, ...patch } : { ...entry }));
}

console.log("cd server && npm run e05:unit\n");

check("the topology contradicts nothing it is derived from", () => {
  const findings = inspectTopology();
  assert.deepEqual(findings, []);
  return (
    `${DEPLOYMENTS.length} deployments, ${QUEUE_ROUTES.length} queues, ` +
    `${SCHEDULES.length} schedules, ${JOBS.length} jobs, no finding`
  );
});

check("exactly one deployment is reachable from a browser", () => {
  const publics = DEPLOYMENTS.filter((entry) => entry.ingress === "public");
  assert.equal(publics.length, 1);
  assert.equal(publics[0].name, "forma-api");
  assert.deepEqual(publics[0].executes, []);
  const twoPublic = inspectTopology(mutate("forma-ops", { ingress: "public" }));
  assert.ok(twoPublic.some((finding) => finding.includes("browser-public")));
  return "forma-api is public and executes nothing; a second public deployment is refused";
});

check("no two deployments share an identity, a database role, or a database secret", () => {
  for (const field of ["serviceAccount", "databaseRole", "databaseSecret", "audience"] as const) {
    const values = DEPLOYMENTS.map((entry) => entry[field]);
    assert.equal(new Set(values).size, values.length, `${field} is not unique`);
  }
  const shared = inspectTopology(mutate("forma-ops", { databaseSecret: "forma-api-db-url" }));
  assert.ok(shared.some((finding) => finding.includes("shared by more than one deployment")));
  return `4 identity fields unique across ${DEPLOYMENTS.length} deployments; a shared secret is refused`;
});

check("engine and provider work belong to one deployment each, and not to the API", () => {
  const engine = DEPLOYMENTS.filter((entry) => entry.capabilities.includes("engine_analysis"));
  const provider = DEPLOYMENTS.filter((entry) => entry.capabilities.includes("provider_traffic"));
  assert.equal(engine.length, 1);
  assert.equal(provider.length, 1);
  assert.equal(engine[0].name, "forma-stockfish");
  assert.equal(provider[0].name, "forma-ingestion");
  const api = deploymentByName("forma-api")!;
  assert.equal(api.capabilities.includes("engine_analysis"), false);
  assert.equal(api.capabilities.includes("provider_traffic"), false);
  return "engine=forma-stockfish, provider=forma-ingestion, neither on forma-api";
});

check("no deployed unit can run the prototype in-process pipeline", () => {
  for (const entry of DEPLOYMENTS) {
    assert.equal(entry.capabilities.includes("prototype_pipeline"), false, entry.name);
  }
  const smuggled = inspectTopology(
    mutate("forma-analysis", { capabilities: ["model_inference", "prototype_pipeline"] }),
  );
  assert.ok(smuggled.some((finding) => finding.includes("prototype in-process pipeline")));
  return `0 of ${DEPLOYMENTS.length} deployments hold it; granting it to one is refused`;
});

check("every resource class has exactly one executor, except the one v1 does not schedule", () => {
  for (const resourceClass of RESOURCE_CLASSES) {
    const executor = executorOf(resourceClass);
    if (resourceClass === UNSCHEDULED_RESOURCE_CLASS) {
      assert.equal(executor, undefined);
      continue;
    }
    assert.ok(executor, `${resourceClass} has no executor`);
  }
  const doubled = inspectTopology(mutate("forma-ops", { executes: ["api_light", "ingestion"] }));
  assert.ok(doubled.some((finding) => finding.includes("resource class ingestion")));
  return `${RESOURCE_CLASSES.length - 1} classes have one executor; ${UNSCHEDULED_RESOURCE_CLASS} has none`;
});

check("a queue may not dispatch more work than its target can run", () => {
  for (const target of DEPLOYMENTS) {
    const sharing = QUEUE_ROUTES.filter((entry) => entry.target === target.name);
    if (sharing.length === 0) continue;
    const demanded = sharing.reduce((total, entry) => total + entry.maxConcurrentDispatches, 0);
    assert.ok(
      demanded <= target.maxInstances * target.containerConcurrency,
      `${target.name} is oversubscribed`,
    );
  }
  const tight = inspectTopology(DEPLOYMENTS, [
    ...QUEUE_ROUTES.filter((entry) => entry.name !== "analysis"),
    { ...QUEUE_ROUTES.find((entry) => entry.name === "analysis")!, maxConcurrentDispatches: 99 },
  ]);
  assert.ok(tight.some((finding) => finding.includes("but it can run")));
  return "every target absorbs its queues at peak; an oversubscribed queue is refused";
});

check("migrations set exactly the current connection budget's peaks", () => {
  const sql = [
    "0015_e05_service_topology.sql",
    "0038_maia3_position_continuations.sql",
    // Where forma_maia's limit moved to three, for the rating worker.
    "0043_game_ratings.sql",
  ]
    .map((file) => readFileSync(join(process.cwd(), "drizzle", file), "utf8"))
    .join("\n");
  const peaks: string[] = [];
  for (const budget of SERVICE_BUDGETS) {
    const deployment = deploymentByName(budget.service)!;
    const peak = peakConnections(deployment);
    const statement = new RegExp(
      `alter\\s+role\\s+${budget.role}\\s+connection\\s+limit\\s+${peak}\\b`,
      "i",
    );
    assert.match(sql, statement, `${budget.role} is not limited to ${peak}`);
    peaks.push(`${budget.role}=${peak}`);
  }
  return peaks.join(" ");
});

check("a deployed process that was not told which service it is refuses to start", () => {
  assert.throws(
    () => assertDeploymentIdentity({ K_SERVICE: "forma-api" } as NodeJS.ProcessEnv),
    /must name its deployment/,
  );
  assert.throws(
    () =>
      assertDeploymentIdentity({
        K_SERVICE: "forma-api",
        FORMA_DEPLOYMENT: "forma-whatever",
      } as NodeJS.ProcessEnv),
    /unknown deployment/,
  );
  assert.throws(
    () =>
      assertDeploymentIdentity({
        K_SERVICE: "forma-api",
        FORMA_DEPLOYMENT: "forma-api",
        DATABASE_ROLE: "forma_ops",
      } as NodeJS.ProcessEnv),
    /must connect as forma_api/,
  );
  assert.equal(assertDeploymentIdentity({} as NodeJS.ProcessEnv), null);
  return "unset, unknown, and role-mismatched all refuse; undeployed returns null";
});

check("the API deployment refuses engine, provider, and pipeline work by capability", () => {
  const api = deploymentByName("forma-api")!;
  for (const capability of ["engine_analysis", "provider_traffic", "prototype_pipeline"] as const) {
    assert.throws(() => assertCapability(api, capability), CapabilityError);
  }
  assertCapability(api, "serve_public_requests");
  return "3 capabilities refused, serve_public_requests allowed";
});

check("a worker only executes the resource classes it owns", () => {
  const stockfish = deploymentByName("forma-stockfish")!;
  assertExecutes(stockfish, "cpu_engine");
  assert.throws(() => assertExecutes(stockfish, "ingestion"), CapabilityError);
  assert.throws(() => assertExecutes(stockfish, UNSCHEDULED_RESOURCE_CLASS), CapabilityError);
  return "forma-stockfish runs cpu_engine and refuses ingestion and gpu_model";
});

check("an error message names the capability and the deployment, and nothing else", () => {
  const api = deploymentByName("forma-api")!;
  let message = "";
  try {
    assertCapability(api, "engine_analysis");
  } catch (error) {
    message = (error as Error).message;
  }
  assert.equal(message, "forma-api does not hold engine_analysis");
  return message;
});

check("each worker deployment needs its own URL before anything dispatches", () => {
  const targets = dispatchTargets();
  assert.ok(targets.length >= 3);
  for (const target of targets) {
    assert.throws(
      () => resolveWorkerEndpoint({} as NodeJS.ProcessEnv, target.name),
      new RegExp(`${urlEnvFor(target.name)} is not set`),
    );
  }
  return `${targets.map((entry) => urlEnvFor(entry.name)).join(", ")} are each required`;
});

check("a token minted for one worker is not addressed to another", () => {
  const env = {
    FORMA_INGESTION_URL: "https://forma-ingestion-abc.a.run.app/",
    FORMA_STOCKFISH_URL: "https://forma-stockfish-xyz.a.run.app",
  } as NodeJS.ProcessEnv;
  const ingestion = resolveWorkerEndpoint(env, "forma-ingestion");
  const stockfish = resolveWorkerEndpoint(env, "forma-stockfish");
  assert.notEqual(ingestion.audience, stockfish.audience);
  assert.equal(ingestion.baseUrl, "https://forma-ingestion-abc.a.run.app");
  assert.equal(ingestion.audience, ingestion.baseUrl);
  return "audiences differ per worker and default to that worker's own URL";
});

check("a queue's messages go to the deployment that owns its capability", () => {
  const owners: string[] = [];
  for (const entry of QUEUE_ROUTES) {
    const target = deploymentByName(entry.target)!;
    assert.equal(target.ingress, "internal");
    assert.ok(target.executes.length > 0, `${entry.target} executes nothing`);
    owners.push(`${entry.name}->${entry.target}`);
  }
  assert.equal(queueRoute("stockfish-deep")!.target, "forma-stockfish");
  assert.equal(queueRoute("provider-lichess")!.target, "forma-ingestion");
  // D1: the spec names "ops/analysis" for maintenance; ops has no execution role.
  assert.equal(queueRoute("maintenance")!.target, "forma-analysis");
  return owners.join(" ");
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
}
