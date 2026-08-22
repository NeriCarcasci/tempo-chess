import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

import { RETAINED_MOVE_LIMIT } from "./contract.js";
import { normalizePolicy, type PolicyDistribution, type RawPolicyMove } from "./policy.js";

export interface Maia3Options {
  pythonPath: string;
  bridgePath: string;
  checkpointPath: string;
  retainedMoveLimit?: number;
  timeoutMs?: number;
}

export interface Maia3Inference {
  policy: PolicyDistribution;
  latencyMs: number;
  modelRating: number;
}

export class Maia3UnavailableError extends Error {}

interface BridgeResponse {
  ready?: boolean;
  error?: string;
  moves?: RawPolicyMove[];
}

/**
 * One long-lived CPU Maia-3 process.
 *
 * Requests are serialized because a single model process has mutable board
 * state. Cloud Run may deliver concurrent work to the Node container, but the
 * queue here ensures those requests cannot overwrite one another's position.
 */
export class Maia3Engine {
  private child: ChildProcessWithoutNullStreams | null = null;
  private lines: Interface | null = null;
  private iterator: AsyncIterator<string> | null = null;
  private startPromise: Promise<void> | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly retainedMoveLimit: number;
  private readonly timeoutMs: number;

  constructor(private readonly options: Maia3Options) {
    this.retainedMoveLimit = options.retainedMoveLimit ?? RETAINED_MOVE_LIMIT;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private async start(): Promise<void> {
    if (this.child) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      const child = spawn(
        this.options.pythonPath,
        [this.options.bridgePath, "--checkpoint-path", this.options.checkpointPath],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      this.child = child;
      child.stderr.resume();
      this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      this.iterator = this.lines[Symbol.asyncIterator]();
      const ready = await this.nextResponse("startup");
      if (ready.ready !== true) throw new Maia3UnavailableError("Maia-3 bridge did not become ready");
    })();
    try {
      await this.startPromise;
    } catch (error) {
      this.stop();
      throw error;
    } finally {
      this.startPromise = null;
    }
  }

  private async nextResponse(operation: string): Promise<BridgeResponse> {
    const iterator = this.iterator;
    if (!iterator) throw new Maia3UnavailableError("Maia-3 bridge is not running");
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const result = await Promise.race([
        iterator.next(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Maia3UnavailableError(`Maia-3 timed out during ${operation}`)),
            this.timeoutMs,
          );
        }),
      ]);
      if (result.done || !result.value) throw new Maia3UnavailableError("Maia-3 bridge exited");
      const parsed = JSON.parse(result.value) as BridgeResponse;
      if (parsed.error) throw new Maia3UnavailableError(`Maia-3 inference failed: ${parsed.error}`);
      return parsed;
    } catch (error) {
      if (error instanceof Maia3UnavailableError) throw error;
      throw new Maia3UnavailableError(`Maia-3 returned an unreadable ${operation} response`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async inferPolicy(fen: string, rating: number): Promise<Maia3Inference> {
    const run = async (): Promise<Maia3Inference> => {
      await this.start();
      const child = this.child;
      if (!child) throw new Maia3UnavailableError("Maia-3 bridge is not running");
      const startedAt = Date.now();
      child.stdin.write(`${JSON.stringify({ fen, rating })}\n`);
      const response = await this.nextResponse("inference");
      if (!response.moves || response.moves.length === 0) {
        throw new Maia3UnavailableError("Maia-3 returned no legal moves");
      }
      return {
        policy: normalizePolicy(response.moves, this.retainedMoveLimit),
        latencyMs: Date.now() - startedAt,
        modelRating: rating,
      };
    };
    const queued = this.tail.then(run, run);
    this.tail = queued.then(() => undefined, () => undefined);
    return queued;
  }

  stop(): void {
    this.lines?.close();
    this.lines = null;
    this.iterator = null;
    if (this.child) {
      this.child.stdin.end();
      this.child.kill();
      this.child = null;
    }
  }
}
