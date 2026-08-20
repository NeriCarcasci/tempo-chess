import { QUEUES, type Queue } from "./contract.js";
import { queueRoute } from "../platform/topology.js";
import { resolveWorkerEndpoint } from "../platform/deployment.js";
import { assertMinimalTaskPayload, type TaskPayload } from "./tokens.js";

/**
 * Cloud Tasks as a transport, and only as a transport.
 *
 * Database architecture §30.3: "Postgres remains the authoritative task
 * ledger." Everything this file can do is send a wake-up message naming a work
 * item; it cannot mark work done, it cannot carry the work, and a message it
 * fails to send costs nothing, because the outbox row is still there.
 *
 * The endpoint is configurable so the Cloud Tasks emulator is the same code
 * path as the real API rather than a mock of it. Authentication is not
 * configurable: a non-loopback endpoint gets an access token or the dispatcher
 * refuses to send.
 */

export type CreateTaskResult = "created" | "duplicate";

export interface TaskRequest {
  queue: Queue;
  /**
   * Deterministic and derived from the outbox dedup key. Cloud Tasks refuses a
   * name it has seen, which makes a redelivered dispatch a no-op at the queue
   * as well as in the ledger.
   */
  name: string;
  payload: TaskPayload;
  scheduleAt: Date | null;
}

export interface TaskTransport {
  createTask(request: TaskRequest): Promise<CreateTaskResult>;
}

export interface TasksConfig {
  project: string;
  location: string;
  /** Cloud Tasks API root, or an emulator's. */
  endpoint: string;
  /** Base URL of the private worker service the task will call. */
  workerBaseUrl: string;
  /** The service account the task presents as, and the audience it asks for. */
  invokerServiceAccount: string | null;
  audience: string;
}

export interface TasksConfigFinding {
  code: string;
  message: string;
}

const REQUIRED = {
  FORMA_TASKS_PROJECT: "project",
  FORMA_TASKS_LOCATION: "location",
  FORMA_WORKER_BASE_URL: "workerBaseUrl",
  FORMA_INTERNAL_AUDIENCE: "audience",
} as const;

export function inspectTasksConfig(env: NodeJS.ProcessEnv): TasksConfigFinding[] {
  const findings: TasksConfigFinding[] = [];
  for (const [name] of Object.entries(REQUIRED)) {
    if (!env[name]) findings.push({ code: `${name}_MISSING`, message: `${name} is required to dispatch work` });
  }
  const endpoint = env.FORMA_TASKS_ENDPOINT ?? "https://cloudtasks.googleapis.com";
  if (!isLoopback(endpoint) && !env.FORMA_TASKS_INVOKER_SERVICE_ACCOUNT) {
    findings.push({
      code: "FORMA_TASKS_INVOKER_SERVICE_ACCOUNT_MISSING",
      message: "a real Cloud Tasks endpoint needs the service account the task presents as",
    });
  }
  return findings;
}

function isLoopback(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

export function tasksConfig(env: NodeJS.ProcessEnv = process.env): TasksConfig | null {
  if (inspectTasksConfig(env).length > 0) return null;
  return {
    project: env.FORMA_TASKS_PROJECT!,
    location: env.FORMA_TASKS_LOCATION!,
    endpoint: env.FORMA_TASKS_ENDPOINT ?? "https://cloudtasks.googleapis.com",
    workerBaseUrl: env.FORMA_WORKER_BASE_URL!.replace(/\/+$/, ""),
    invokerServiceAccount: env.FORMA_TASKS_INVOKER_SERVICE_ACCOUNT ?? null,
    audience: env.FORMA_INTERNAL_AUDIENCE!,
  };
}

/** The `/internal/v1` path a work item's wake-up message targets. */
export function workerPath(workItemId: string): string {
  return `/internal/v1/work-items/${encodeURIComponent(workItemId)}/execute`;
}

/**
 * An access token for the Cloud Tasks API itself.
 *
 * Application Default Credentials, resolved lazily: importing the Google auth
 * library in a process that never dispatches (every API instance) would be a
 * cold-start cost paid for nothing. A loopback endpoint is an emulator and gets
 * no token, because it has no identity to check one against.
 */
async function authorization(config: TasksConfig): Promise<Record<string, string>> {
  if (isLoopback(config.endpoint)) return {};
  const { GoogleAuth } = await import("google-auth-library");
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  const token = await auth.getAccessToken();
  if (!token) throw new Error("no application default credentials for Cloud Tasks");
  return { authorization: `Bearer ${token}` };
}

export class CloudTasksTransport implements TaskTransport {
  constructor(
    private readonly config: TasksConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /**
   * Where a queue's work actually goes.
   *
   * `QUEUE_ROUTES` has always named a target deployment per queue, and
   * `resolveWorkerEndpoint` has always been able to turn that into a URL and an
   * audience -- but nothing called it outside a test, so every task was posted
   * to the single `FORMA_WORKER_BASE_URL` regardless of its queue. A sync bound
   * for `forma-ingestion` and an analysis bound for `forma-analysis` went to
   * the same place, and whichever service received one it does not execute
   * dead-lettered it as unsupported.
   *
   * The audience is per service on purpose: a token minted for one worker must
   * not be accepted by another.
   *
   * A loopback endpoint is the emulator the gates run against, and it pins one
   * base URL deliberately, so that case keeps the configured value.
   */
  private endpointFor(queue: Queue): { baseUrl: string; audience: string } {
    if (isLoopback(this.config.endpoint)) {
      return { baseUrl: this.config.workerBaseUrl, audience: this.config.audience };
    }
    const route = queueRoute(queue);
    if (!route) throw new Error(`queue ${queue} has no declared target deployment`);
    const endpoint = resolveWorkerEndpoint(this.env, route.target);
    return { baseUrl: endpoint.baseUrl, audience: endpoint.audience };
  }

  async createTask(request: TaskRequest): Promise<CreateTaskResult> {
    if (!(QUEUES as readonly string[]).includes(request.queue)) {
      throw new Error(`unknown queue ${request.queue}`);
    }
    // Belt and braces: the builder already refuses an extra field, and so does
    // this, because the dispatcher is the last place a payload can be inspected
    // before it leaves the trust boundary.
    assertMinimalTaskPayload(request.payload as unknown as Record<string, unknown>);

    const parent = `projects/${this.config.project}/locations/${this.config.location}/queues/${request.queue}`;
    const target = this.endpointFor(request.queue);
    const body: Record<string, unknown> = {
      task: {
        name: `${parent}/tasks/${request.name}`,
        httpRequest: {
          url: `${target.baseUrl}${workerPath(request.payload.workItemId)}`,
          httpMethod: "POST",
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify(request.payload), "utf8").toString("base64"),
          ...(this.config.invokerServiceAccount
            ? {
                oidcToken: {
                  serviceAccountEmail: this.config.invokerServiceAccount,
                  audience: target.audience,
                },
              }
            : {}),
        },
        ...(request.scheduleAt ? { scheduleTime: request.scheduleAt.toISOString() } : {}),
      },
    };

    const response = await this.fetchImpl(`${this.config.endpoint}/v2/${parent}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await authorization(this.config)) },
      body: JSON.stringify(body),
    });
    if (response.ok) return "created";
    // The queue already holds this exact task name. That is the deduplication
    // working, not a failure: the wake-up message exists.
    if (response.status === 409) return "duplicate";
    throw new Error(`cloud tasks rejected the task with status ${response.status}`);
  }
}

/** Build the transport from the environment, or say why it cannot be built. */
export function taskTransport(
  env: NodeJS.ProcessEnv = process.env,
): { transport: TaskTransport } | { findings: TasksConfigFinding[] } {
  const findings = inspectTasksConfig(env);
  if (findings.length > 0) return { findings };
  return { transport: new CloudTasksTransport(tasksConfig(env)!) };
}
