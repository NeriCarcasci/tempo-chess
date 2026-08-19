/**
 * Which handlers this process is allowed to run.
 *
 * E04 built the registry and called it the allowlist, and every epic since has
 * written its handler and its `registerXHandlers()` — but **nothing ever called
 * one**. The registry was empty in every deployment, so every message the
 * executor received was dead-lettered as `unsupported`. The whole work system
 * was a system with no workers.
 *
 * This is the bootstrap, and it is deliberately a table rather than a scan. A
 * deployment registers the families of work its topology entry says it executes,
 * so a message routed to the wrong service is refused by a process that never
 * knew how to do it, which is a stronger boundary than a check inside the
 * handler.
 *
 * `forma-api` registers nothing. It serves requests; it does not execute work,
 * and a public-ingress process that could run a task is an escalation waiting
 * for a routing mistake.
 */

import { allowedTaskTypes } from "./handlers.js";
import { registerEngineHandlers } from "../engine/worker.js";
import { registerEstimateHandlers } from "../estimates/worker.js";
import { registerGoalHandlers } from "../goals/progress-worker.js";
import { registerModelHandlers } from "../models/worker.js";
import { registerOnboardingHandlers } from "../onboarding/worker.js";
import { registerPositionHandlers } from "../positions/worker.js";
import { registerSyncHandlers } from "../sync/worker.js";

export type DeploymentName =
  | "forma-api"
  | "forma-ops"
  | "forma-ingestion"
  | "forma-stockfish"
  | "forma-analysis";

/**
 * Register the handlers for one deployment and report what it can now run.
 *
 * The returned list is what the readiness endpoint publishes, so "what can this
 * instance execute" is answered by the registry rather than by a constant that
 * can drift from it.
 */
export function registerDeploymentHandlers(deployment: string): string[] {
  switch (deployment) {
    case "forma-stockfish":
      // The engine service and only the engine handlers: screening, deepening
      // and the bounded interactive evaluation.
      registerEngineHandlers("engine");
      break;

    case "forma-analysis":
      // Everything that reads engine output and turns it into claims. The
      // transition assessment lives here rather than on the engine service
      // because it writes analysis rows, and the engine role cannot.
      registerEngineHandlers("analysis");
      registerModelHandlers();
      registerPositionHandlers();
      registerEstimateHandlers();
      registerOnboardingHandlers();
      registerGoalHandlers();
      break;

    case "forma-ingestion":
      // Provider traffic, and nothing else. This is the only deployment with a
      // reason to hold a provider rate limit.
      registerSyncHandlers();
      break;

    case "forma-ops":
      // Dispatch, lease recovery and sweeps. It executes `api_light` work, of
      // which there is none yet — named here so the next one lands in the right
      // place rather than wherever it was convenient.
      break;

    case "forma-api":
    default:
      break;
  }
  return allowedTaskTypes();
}

/**
 * The single-process shape, for a local run and for the gates.
 *
 * A deployment shape, not a permission change: the database roles still decide
 * what each connection may write, and a gate that registers everything is still
 * refused by Postgres if it tries to write outside its grants.
 */
export function registerAllHandlers(): string[] {
  registerEngineHandlers("both");
  registerModelHandlers();
  registerPositionHandlers();
  registerEstimateHandlers();
  registerOnboardingHandlers();
  registerGoalHandlers();
  registerSyncHandlers();
  return allowedTaskTypes();
}
