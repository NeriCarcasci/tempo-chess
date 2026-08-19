import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { RETAINED_MOVE_LIMIT } from "./contract.js";
import { normalizePolicy, type PolicyDistribution, type RawPolicyMove } from "./policy.js";

/**
 * The Maia adapter: a rating-conditioned human policy, read out of Lc0.
 *
 * Maia is nine networks, one per rating band, each trained to predict the move a
 * human of that strength played rather than the move that wins. That is the
 * whole reason it is here, and also the reason its output may never be written
 * anywhere Stockfish's is: it answers "what would somebody do", not "what is
 * true".
 *
 * The search is one node deep on purpose. Maia's claim is in its policy head;
 * letting Lc0 search would blend a human prior with a machine's tree and produce
 * a distribution that is neither. `--policy-softmax-temp=1.0` is set for the
 * same reason: Lc0's default of 1.359 is tuned for its own search and would
 * flatten probabilities Forma then reports as calibrated.
 */

export interface MaiaNetwork {
  /** The rating this network was trained on: 1100 through 1900, in hundreds. */
  band: number;
  /** Path to the .pb.gz weights file. */
  weightsPath: string;
}

export interface MaiaOptions {
  /** Path to the lc0 executable. */
  enginePath: string;
  networks: readonly MaiaNetwork[];
  retainedMoveLimit?: number;
  /** Milliseconds before a single position is abandoned. */
  timeoutMs?: number;
}

export interface MaiaInference {
  policy: PolicyDistribution;
  /** The most human move, as the engine reported it. */
  bestMoveUci: string;
  /** Human win/draw/loss from the value head, when the engine reported it. */
  humanWdl: { win: number; draw: number; loss: number } | null;
  latencyMs: number;
  networkBand: number;
}

export class MaiaUnavailableError extends Error {}

/**
 * The network for a rating.
 *
 * Maia exists at 1100-1900. A 1000-rated player is served by the 1100 network
 * and a 2100-rated player by the 1900 one, and both are edges of the model's
 * range rather than of Forma's: the caller still has to check that the slice was
 * calibrated, and the calibration is what decides whether the answer is
 * publishable. Clamping here without that check would be exactly the
 * extrapolation the spec forbids.
 */
export function networkForRating(
  rating: number,
  networks: readonly MaiaNetwork[],
): MaiaNetwork | null {
  if (networks.length === 0) return null;
  const sorted = [...networks].sort((a, b) => a.band - b.band);
  let best = sorted[0]!;
  let bestDistance = Math.abs(rating - best.band);
  for (const network of sorted.slice(1)) {
    const distance = Math.abs(rating - network.band);
    // Strictly less, so a tie goes to the lower band: the lower network is the
    // more conservative claim about a player we are unsure of.
    if (distance < bestDistance) {
      best = network;
      bestDistance = distance;
    }
  }
  return best;
}

const INFO_MOVE = /^info string ([a-h][1-8][a-h][1-8][qrbn]?)\s.*?\(P:\s*([0-9.]+)%\)/;
const WDL = /\bwdl (\d+) (\d+) (\d+)\b/;

/** One long-lived Lc0 process, holding one network. */
class MaiaProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private waiter: ((lines: string[]) => void) | null = null;
  private lines: string[] = [];

  constructor(
    private readonly enginePath: string,
    private readonly network: MaiaNetwork,
    private readonly timeoutMs: number,
  ) {}

  async start(): Promise<void> {
    const child = spawn(
      this.enginePath,
      [
        `--weights=${this.network.weightsPath}`,
        "--policy-softmax-temp=1.0",
        "--minibatch-size=1",
        "--max-collision-events=1",
        "--verbose-move-stats",
        "--threads=1",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk));
    // Lc0 writes its banner and its weight-loading progress to stderr. Reading
    // and discarding it keeps the pipe from filling and stalling the process.
    child.stderr.resume();
    await this.command("uci", (line) => line.trim() === "uciok");
    await this.command("setoption name UCI_ShowWDL value true", null);
    await this.command("isready", (line) => line.trim() === "readyok");
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    const parts = this.buffer.split(/\r?\n/);
    this.buffer = parts.pop() ?? "";
    for (const line of parts) {
      this.lines.push(line);
      if (this.waiter && this.terminator && this.terminator(line)) {
        const waiter = this.waiter;
        const lines = this.lines;
        this.waiter = null;
        this.terminator = null;
        this.lines = [];
        waiter(lines);
      }
    }
  }

  private terminator: ((line: string) => boolean) | null = null;

  private command(
    text: string,
    until: ((line: string) => boolean) | null,
  ): Promise<string[]> {
    const child = this.child;
    if (!child) throw new MaiaUnavailableError("engine is not running");
    if (until === null) {
      child.stdin.write(`${text}\n`);
      return Promise.resolve([]);
    }
    return new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        this.terminator = null;
        this.lines = [];
        reject(new MaiaUnavailableError(`engine did not answer ${text} in ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.waiter = (lines) => {
        clearTimeout(timer);
        resolve(lines);
      };
      this.terminator = until;
      child.stdin.write(`${text}\n`);
    });
  }

  async evaluate(fen: string, retainedMoveLimit: number): Promise<MaiaInference> {
    const startedAt = Date.now();
    await this.command(`position fen ${fen}`, null);
    const lines = await this.command("go nodes 1", (line) => line.startsWith("bestmove"));
    const latencyMs = Date.now() - startedAt;

    const raw: RawPolicyMove[] = [];
    let humanWdl: MaiaInference["humanWdl"] = null;
    let bestMoveUci = "";
    for (const line of lines) {
      const move = INFO_MOVE.exec(line);
      if (move) {
        raw.push({ uci: move[1]!, probability: Number(move[2]) / 100 });
        continue;
      }
      const wdl = WDL.exec(line);
      if (wdl) {
        humanWdl = {
          win: Number(wdl[1]) / 1000,
          draw: Number(wdl[2]) / 1000,
          loss: Number(wdl[3]) / 1000,
        };
        continue;
      }
      if (line.startsWith("bestmove")) bestMoveUci = line.split(/\s+/)[1] ?? "";
    }
    if (raw.length === 0) {
      throw new MaiaUnavailableError("engine reported no policy for the position");
    }
    return {
      policy: normalizePolicy(raw, retainedMoveLimit),
      bestMoveUci,
      humanWdl,
      latencyMs,
      networkBand: this.network.band,
    };
  }

  stop(): void {
    if (!this.child) return;
    this.child.stdin.write("quit\n");
    this.child.kill();
    this.child = null;
  }
}

/**
 * A pool of one process per network.
 *
 * Networks are loaded once and kept: Lc0 spends about a second reading weights,
 * which would otherwise be paid on every position and would put the per-position
 * latency budget out of reach for reasons that have nothing to do with the model.
 */
export class MaiaEngine {
  private readonly processes = new Map<number, MaiaProcess>();
  private readonly retainedMoveLimit: number;
  private readonly timeoutMs: number;

  constructor(private readonly options: MaiaOptions) {
    this.retainedMoveLimit = options.retainedMoveLimit ?? RETAINED_MOVE_LIMIT;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async inferPolicy(fen: string, rating: number): Promise<MaiaInference> {
    const network = networkForRating(rating, this.options.networks);
    if (network === null) throw new MaiaUnavailableError("no Maia network is configured");
    let process = this.processes.get(network.band);
    if (!process) {
      process = new MaiaProcess(this.options.enginePath, network, this.timeoutMs);
      await process.start();
      this.processes.set(network.band, process);
    }
    return process.evaluate(fen, this.retainedMoveLimit);
  }

  close(): void {
    for (const process of this.processes.values()) process.stop();
    this.processes.clear();
  }
}

/** The content hash of a weights file, for the asset record and the cache key. */
export async function fileSha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
