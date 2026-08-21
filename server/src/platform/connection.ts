/**
 * The aggregate database connection budget.
 *
 * Supabase gives the project a fixed number of server-side connections. Cloud
 * Run will happily scale past it, and the failure mode is not a slow API — it is
 * every service failing to connect at once. The budget is therefore derived
 * here, and `max instances` is set from it rather than the other way round.
 *
 * Runtime services reach Postgres through the Supavisor transaction pooler with
 * prepared statements disabled. Migrations use the direct endpoint, never a
 * runtime credential; E01's startup gate already refuses a deployed API that is
 * configured any other way.
 */

/** Supavisor transaction pooling. Prepared statements are unavailable here. */
export const POOLER_PORT = 6543;
/** The direct endpoint. Migrations and administrative work only. */
export const DIRECT_PORT = 5432;

/** Server-side connections the Supabase instance allows. */
export const DATABASE_MAX_CONNECTIONS = 60;
/** Auth, Storage, Realtime, the pooler's own admin connections, and autovacuum. */
export const SUPABASE_RESERVED_CONNECTIONS = 12;
/** Held for the migration job on the direct endpoint while services keep serving. */
export const MIGRATION_RESERVED_CONNECTIONS = 3;
/** Held for an operator with a live incident. Never allocated to a service. */
export const OPERATOR_RESERVED_CONNECTIONS = 2;

export interface ServiceBudget {
  readonly service: string;
  readonly role: string;
  readonly endpoint: "transaction_pooler" | "direct";
  /** Cloud Run `max instances`, set from this budget. */
  readonly maxInstances: number;
  /** Client pool size per instance. Small and explicit, never the driver default. */
  readonly poolPerInstance: number;
}

export const SERVICE_BUDGETS: readonly ServiceBudget[] = [
  { service: "forma-api", role: "forma_api", endpoint: "transaction_pooler", maxInstances: 6, poolPerInstance: 3 },
  { service: "forma-ops", role: "forma_ops", endpoint: "transaction_pooler", maxInstances: 2, poolPerInstance: 2 },
  { service: "forma-ingestion", role: "forma_ingestion", endpoint: "transaction_pooler", maxInstances: 4, poolPerInstance: 2 },
  { service: "forma-stockfish", role: "forma_stockfish", endpoint: "transaction_pooler", maxInstances: 6, poolPerInstance: 1 },
  { service: "forma-analysis", role: "forma_analysis", endpoint: "transaction_pooler", maxInstances: 2, poolPerInstance: 2 },
  { service: "forma-maia", role: "forma_maia", endpoint: "transaction_pooler", maxInstances: 2, poolPerInstance: 1 },
];

/** Connections a service can hold when it is scaled all the way out. */
export function peakConnections(budget: ServiceBudget): number {
  return budget.maxInstances * budget.poolPerInstance;
}

/** What every service together can hold at peak. */
export function allocatedConnections(budgets: readonly ServiceBudget[] = SERVICE_BUDGETS): number {
  return budgets.reduce((total, budget) => total + peakConnections(budget), 0);
}

/** What is left for services after every reservation. */
export function runtimeConnectionBudget(): number {
  return (
    DATABASE_MAX_CONNECTIONS -
    SUPABASE_RESERVED_CONNECTIONS -
    MIGRATION_RESERVED_CONNECTIONS -
    OPERATOR_RESERVED_CONNECTIONS
  );
}

/** Postgres client options for a service. `prepare` is off: the pooler cannot keep statements. */
export function poolOptionsFor(service: string): { max: number; prepare: false } {
  const budget = SERVICE_BUDGETS.find((candidate) => candidate.service === service);
  if (!budget) throw new Error(`no connection budget for service ${service}`);
  return { max: budget.poolPerInstance, prepare: false };
}

export interface BudgetFinding {
  code: string;
  message: string;
}

/** Every reason the budget as written would not hold. An empty array is the only acceptable result. */
export function inspectConnectionBudget(
  budgets: readonly ServiceBudget[] = SERVICE_BUDGETS,
): BudgetFinding[] {
  const findings: BudgetFinding[] = [];
  const allocated = allocatedConnections(budgets);
  const available = runtimeConnectionBudget();
  if (allocated > available) {
    findings.push({
      code: "BUDGET_OVERSUBSCRIBED",
      message: `services can hold ${allocated} connections at peak but only ${available} are available`,
    });
  }
  for (const budget of budgets) {
    if (budget.endpoint !== "transaction_pooler") {
      findings.push({
        code: "SERVICE_NOT_POOLED",
        message: `${budget.service} does not use the transaction pooler`,
      });
    }
    if (budget.poolPerInstance < 1 || budget.poolPerInstance > 5) {
      findings.push({
        code: "POOL_NOT_SMALL",
        message: `${budget.service} pool of ${budget.poolPerInstance} is not an explicit small pool`,
      });
    }
  }
  return findings;
}
