/**
 * Which service this process is, and what it is therefore allowed to do.
 *
 * Before E05 one image served every role, so "the API must never run Stockfish"
 * held only as long as nobody imported it. Here the process is told which
 * deployment it is, refuses to start if it was not told, and refuses work its
 * deployment does not own — so the boundary survives a future import.
 *
 * The refusal messages name the capability and the deployment and nothing else.
 * A denial is read by whoever is holding the pager, and a stack of internal
 * detail in a log line is how a secret or a subject id escapes.
 */

import type { ResourceClass } from "../ops/contract.js";
import { isDeployed } from "../security/config.js";
import {
  DEPLOYMENTS,
  deploymentByName,
  type Capability,
  type DeploymentEntry,
} from "./topology.js";

/** Names the deployment this process claims to be. */
export const DEPLOYMENT_ENV = "FORMA_DEPLOYMENT";

export class DeploymentIdentityError extends Error {}

export class CapabilityError extends Error {
  constructor(
    readonly capability: Capability | ResourceClass,
    readonly deployment: string,
  ) {
    super(`${deployment} does not hold ${capability}`);
    this.name = "CapabilityError";
  }
}

/**
 * The deployment this process is running as.
 *
 * Outside Cloud Run there is no deployment to be, and requiring one would mean
 * every local script and test declared itself; `null` is the honest answer and
 * callers that need a capability check say so explicitly.
 */
export function resolveDeployment(env: NodeJS.ProcessEnv): DeploymentEntry | null {
  const name = env[DEPLOYMENT_ENV]?.trim();
  if (!name) {
    if (isDeployed(env)) {
      throw new DeploymentIdentityError(
        `${DEPLOYMENT_ENV} is not set; a deployed process must name its deployment`,
      );
    }
    return null;
  }
  const deployment = deploymentByName(name);
  if (!deployment) {
    throw new DeploymentIdentityError(`${DEPLOYMENT_ENV} names an unknown deployment`);
  }
  return deployment;
}

/**
 * Startup gate. A deployed process that cannot say which service it is, or
 * whose database role contradicts the topology, must not serve.
 */
export function assertDeploymentIdentity(env: NodeJS.ProcessEnv): DeploymentEntry | null {
  const deployment = resolveDeployment(env);
  if (!deployment) return null;
  const role = env.DATABASE_ROLE?.trim();
  if (role && role !== deployment.databaseRole) {
    throw new DeploymentIdentityError(
      `${deployment.name} must connect as ${deployment.databaseRole}`,
    );
  }
  return deployment;
}

export function hasCapability(deployment: DeploymentEntry, capability: Capability): boolean {
  return deployment.capabilities.includes(capability);
}

/** Refuse work this deployment does not own. */
export function assertCapability(deployment: DeploymentEntry, capability: Capability): void {
  if (!hasCapability(deployment, capability)) {
    throw new CapabilityError(capability, deployment.name);
  }
}

export function assertExecutes(deployment: DeploymentEntry, resourceClass: ResourceClass): void {
  if (!deployment.executes.includes(resourceClass)) {
    throw new CapabilityError(resourceClass, deployment.name);
  }
}

/**
 * The environment variable naming a deployment's base URL.
 * `forma-ingestion` becomes `FORMA_INGESTION_URL`.
 */
export function urlEnvFor(deploymentName: string): string {
  return `${deploymentName.replace(/-/g, "_").toUpperCase()}_URL`;
}

export interface WorkerEndpoint {
  readonly deployment: DeploymentEntry;
  readonly baseUrl: string;
  /**
   * The OIDC audience the caller must request. Per service (D4): a token minted
   * for one worker must not be accepted by another, so the audience defaults to
   * that worker's own URL rather than a single shared string.
   */
  readonly audience: string;
}

/**
 * Where a worker lives, and who a token for it must be addressed to.
 *
 * Nothing dispatches to a deployment whose URL was never configured. A missing
 * URL used to mean "fall back to the one worker base URL", which quietly sent
 * every queue to the same service.
 */
export function resolveWorkerEndpoint(
  env: NodeJS.ProcessEnv,
  deploymentName: string,
): WorkerEndpoint {
  const deployment = deploymentByName(deploymentName);
  if (!deployment) {
    throw new DeploymentIdentityError(`unknown deployment ${deploymentName}`);
  }
  const variable = urlEnvFor(deployment.name);
  const configured = env[variable]?.trim();
  if (!configured) {
    throw new DeploymentIdentityError(`${variable} is not set; ${deployment.name} has no address`);
  }
  const baseUrl = configured.replace(/\/+$/, "");
  const audience = env[`${variable.slice(0, -4)}_AUDIENCE`]?.trim() || baseUrl;
  return { deployment, baseUrl, audience };
}

/** Every private deployment that must be addressable before dispatch runs. */
export function dispatchTargets(): readonly DeploymentEntry[] {
  return DEPLOYMENTS.filter((entry) => entry.ingress === "internal" && entry.executes.length > 0);
}
