/**
 * `npm run platform:unit` — the connection budget.
 *
 * Deterministic and offline. It proves the numbers in `connection.ts` add up,
 * that every runtime service is pooled with an explicit small pool, and that the
 * API's real client is built from the budget rather than from a driver default.
 */

import { strict as assert } from "node:assert";
import {
  DATABASE_MAX_CONNECTIONS,
  MIGRATION_RESERVED_CONNECTIONS,
  OPERATOR_RESERVED_CONNECTIONS,
  POOLER_PORT,
  SERVICE_BUDGETS,
  SUPABASE_RESERVED_CONNECTIONS,
  allocatedConnections,
  inspectConnectionBudget,
  poolOptionsFor,
  runtimeConnectionBudget,
} from "./connection.js";
import { RUNTIME_ROLES } from "./contract.js";

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

console.log("cd server && npm run platform:unit\n");

check("the aggregate budget fits inside the instance", () => {
  const allocated = allocatedConnections();
  const available = runtimeConnectionBudget();
  assert.ok(allocated <= available, `${allocated} allocated exceeds ${available} available`);
  assert.equal(
    available,
    DATABASE_MAX_CONNECTIONS -
      SUPABASE_RESERVED_CONNECTIONS -
      MIGRATION_RESERVED_CONNECTIONS -
      OPERATOR_RESERVED_CONNECTIONS,
  );
  return `${allocated} of ${available} allocated (${DATABASE_MAX_CONNECTIONS} total less ${SUPABASE_RESERVED_CONNECTIONS} Supabase, ${MIGRATION_RESERVED_CONNECTIONS} migration, ${OPERATOR_RESERVED_CONNECTIONS} operator)`;
});

check("the reservations are never zero", () => {
  assert.ok(SUPABASE_RESERVED_CONNECTIONS > 0, "Supabase internals are unreserved");
  assert.ok(MIGRATION_RESERVED_CONNECTIONS > 0, "a migration could not connect at peak load");
  assert.ok(OPERATOR_RESERVED_CONNECTIONS > 0, "an operator could not connect during an incident");
  return "Supabase, migration, and operator headroom are all reserved before services are allocated";
});

check("every runtime role has exactly one service budget", () => {
  const budgeted = SERVICE_BUDGETS.map((budget) => budget.role).sort();
  const contract = RUNTIME_ROLES.map((role) => role.name).sort();
  assert.deepEqual(budgeted, contract, "budgeted roles disagree with the contract roles");
  return `${budgeted.length} roles, one service each: ${budgeted.join(", ")}`;
});

check("every service is pooled with an explicit small pool", () => {
  const findings = inspectConnectionBudget();
  assert.deepEqual(findings, [], findings.map((finding) => finding.code).join(", "));
  const shape = SERVICE_BUDGETS.map(
    (budget) => `${budget.service}=${budget.maxInstances}x${budget.poolPerInstance}`,
  ).join(" ");
  return `port ${POOLER_PORT}, prepared statements off, ${shape}`;
});

check("an oversubscribed or unpooled budget is reported, not rounded away", () => {
  const overflow = SERVICE_BUDGETS.map((budget) =>
    budget.service === "forma-api" ? { ...budget, maxInstances: budget.maxInstances * 4 } : budget,
  );
  const oversubscribed = inspectConnectionBudget(overflow);
  assert.deepEqual(
    oversubscribed.map((finding) => finding.code),
    ["BUDGET_OVERSUBSCRIBED"],
    "quadrupling forma-api's max instances did not trip the budget",
  );
  const direct = SERVICE_BUDGETS.map((budget) =>
    budget.service === "forma-ops" ? { ...budget, endpoint: "direct" as const } : budget,
  );
  assert.deepEqual(
    inspectConnectionBudget(direct).map((finding) => finding.code),
    ["SERVICE_NOT_POOLED"],
    "a service on the direct endpoint was accepted",
  );
  return `${oversubscribed[0].message}; a service moved off the pooler is refused`;
});

check("the API client is built from the budget", () => {
  const options = poolOptionsFor("forma-api");
  const budget = SERVICE_BUDGETS.find((candidate) => candidate.service === "forma-api")!;
  assert.equal(options.max, budget.poolPerInstance);
  assert.equal(options.prepare, false);
  assert.throws(() => poolOptionsFor("forma-unknown"), /no connection budget/);
  return `forma-api: max=${options.max}, prepare=false; an unbudgeted service throws`;
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
}
