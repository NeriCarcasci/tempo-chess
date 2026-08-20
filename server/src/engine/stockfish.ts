import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve, sep } from "node:path";

export type AnalysisLimit =
  | { type: "nodes"; value: number }
  | { type: "depth"; value: number };

export interface AnalysisProfile {
  id: string;
  version: number;
  limit: AnalysisLimit;
  multiPv: number;
}

/** Production defaults. Explicit profiles make cached evaluations reproducible. */
export const ANALYSIS_PROFILES = {
  screening: { id: "screening", version: 1, limit: { type: "nodes", value: 50_000 }, multiPv: 1 },
  deep: { id: "deep", version: 1, limit: { type: "nodes", value: 500_000 }, multiPv: 3 },
  diagnosticDepth: { id: "diagnostic-depth", version: 1, limit: { type: "depth", value: 14 }, multiPv: 3 },
} as const satisfies Record<string, AnalysisProfile>;

/**
 * The rule-relevant history a search replays before evaluating.
 *
 * `rootFen` is the position immediately after the last irreversible move and
 * `moves` are the UCI moves from there to the position being evaluated. The two
 * together are what makes a repetition visible to the engine.
 */
export interface SearchHistory {
  rootFen: string;
  moves: readonly string[];
}

export interface EngineScore {
  evalCp?: number;
  mate?: number;
  /** Win/draw/loss permille values, normalized to White's perspective. */
  wdl?: [number, number, number];
}

export interface CandidateLine extends EngineScore {
  rank: number;
  depth: number;
  selDepth?: number;
  nodes?: number;
  nps?: number;
  engineTimeMs?: number;
  pv: string[];
}

export interface EngineProvenance {
  engine: "stockfish";
  engineName: string;
  engineVersion?: string;
  network?: string;
  binarySha256?: string;
  networkHash?: string;
  profileId: string;
  profileVersion: number;
  limit: AnalysisLimit;
  multiPv: number;
  threads: number;
  hashMb: number;
  workerRevision: string;
  cacheProvenance: "tempo" | "lichess" | "tablebase";
}

export interface PositionEval extends EngineScore {
  fen: string;
  cacheKey: string;
  depth: number;
  best?: string;
  candidates: CandidateLine[];
  nodes?: number;
  nps?: number;
  engineTimeMs?: number;
  elapsedMs: number;
  provenance: EngineProvenance;
}

interface ParsedInfo extends EngineScore {
  rank: number;
  depth: number;
  selDepth?: number;
  nodes?: number;
  nps?: number;
  engineTimeMs?: number;
  pv?: string[];
}

const ENGINE_PATH = process.env.STOCKFISH_PATH || "stockfish";
const THREADS = 1;
const HASH_MB = 64;
const INIT_TIMEOUT_MS = 10_000;
const WORKER_REVISION = process.env.K_REVISION ?? process.env.GIT_SHA ?? "local";

const sideToMove = (fen: string): "w" | "b" =>
  (fen.split(" ")[1] as "w" | "b") ?? "w";

function integerAfter(line: string, token: string): number | undefined {
  const match = line.match(new RegExp(`(?:^|\\s)${token} (-?\\d+)(?:\\s|$)`));
  return match ? Number(match[1]) : undefined;
}

/** Parse a UCI info line. Exported for contract tests and diagnostic tooling. */
export function parseUciInfo(line: string): ParsedInfo | undefined {
  if (!line.startsWith("info ")) return undefined;
  const depth = integerAfter(line, "depth");
  if (depth === undefined) return undefined;

  const cp = integerAfter(line, "cp");
  const mate = integerAfter(line, "mate");
  const wdlMatch = line.match(/(?:^|\s)wdl (\d+) (\d+) (\d+)(?:\s|$)/);
  const pvMatch = line.match(/(?:^|\s)pv (.+)$/);

  return {
    rank: integerAfter(line, "multipv") ?? 1,
    depth,
    selDepth: integerAfter(line, "seldepth"),
    nodes: integerAfter(line, "nodes"),
    nps: integerAfter(line, "nps"),
    engineTimeMs: integerAfter(line, "time"),
    evalCp: cp,
    mate,
    wdl: wdlMatch
      ? [Number(wdlMatch[1]), Number(wdlMatch[2]), Number(wdlMatch[3])]
      : undefined,
    pv: pvMatch?.[1].trim().split(/\s+/),
  };
}

function normalizeScore<T extends EngineScore>(score: T, stm: "w" | "b"): T {
  if (stm === "w") return score;
  return {
    ...score,
    evalCp: score.evalCp === undefined ? undefined : -score.evalCp,
    mate: score.mate === undefined ? undefined : -score.mate,
    wdl: score.wdl ? [score.wdl[2], score.wdl[1], score.wdl[0]] : undefined,
  };
}

function versionFromName(name: string): string | undefined {
  return name.match(/\b(\d+(?:\.\d+){0,2})\b/)?.[1];
}

/** Stable key for engine results that are safe to reuse interchangeably. */
export function analysisCacheKey(provenance: EngineProvenance): string {
  const compatibleConfiguration = {
    engine: provenance.engine,
    engineName: provenance.engineName,
    engineVersion: provenance.engineVersion,
    binarySha256: provenance.binarySha256,
    network: provenance.network,
    networkHash: provenance.networkHash,
    profileId: provenance.profileId,
    profileVersion: provenance.profileVersion,
    limit: provenance.limit,
    multiPv: provenance.multiPv,
    threads: provenance.threads,
    hashMb: provenance.hashMb,
  };
  return createHash("sha256").update(JSON.stringify(compatibleConfiguration)).digest("hex");
}

function networkHashFromName(name: string | undefined): string | undefined {
  return name?.match(/(?:^|[/\\])nn-([a-f\d]+)\.nnue$/i)?.[1]?.toLowerCase();
}

async function executablePath(command: string): Promise<string | undefined> {
  const candidates: string[] = [];
  if (isAbsolute(command) || command.includes(sep) || command.includes("/")) {
    candidates.push(resolve(command));
  } else {
    const extensions = process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
      : [""];
    for (const directory of (process.env.PATH ?? "").split(delimiter)) {
      for (const extension of extensions) {
        candidates.push(join(directory, command + extension.toLowerCase()));
        if (process.platform === "win32") candidates.push(join(directory, command + extension.toUpperCase()));
      }
    }
  }
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue searching PATH.
    }
  }
  return undefined;
}

async function binarySha256(command: string): Promise<string | undefined> {
  if (process.env.STOCKFISH_BINARY_SHA256) return process.env.STOCKFISH_BINARY_SHA256;
  const path = await executablePath(command);
  if (!path) return undefined;
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/**
 * A single long-lived Stockfish process spoken to over UCI. Calls are queued,
 * and scores are normalized to White's perspective.
 */
export class Engine {
  private readonly sf: ChildProcessWithoutNullStreams;
  private buf = "";
  private engineName = "Stockfish";
  private network?: string;
  private readonly binaryDigest: Promise<string | undefined>;
  private binaryDigestValue?: string;
  private initialized = false;
  private initResolve!: () => void;
  private initReject!: (error: Error) => void;
  private readonly initialization: Promise<void>;
  private readyResolve: (() => void) | null = null;
  private pending: ((e: Omit<PositionEval, "fen">) => void) | null = null;
  private pendingReject: ((error: Error) => void) | null = null;
  private candidates = new Map<number, ParsedInfo>();
  private stm: "w" | "b" = "w";
  private profile: AnalysisProfile = ANALYSIS_PROFILES.diagnosticDepth;
  private startedAt = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(path = ENGINE_PATH, args: string[] = []) {
    this.binaryDigest = binarySha256(path);
    this.initialization = new Promise<void>((resolve, reject) => {
      this.initResolve = resolve;
      this.initReject = reject;
    });
    this.sf = spawn(path, args);
    this.sf.stdout.on("data", (d: Buffer) => this.onData(d.toString()));
    this.sf.on("error", (error) => this.fail(error));
    this.sf.on("exit", (code, signal) => {
      if (!this.initialized || this.pending) {
        const reason = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
        this.fail(new Error(`Stockfish exited with ${reason}`));
      }
    });
    this.write("uci");

    const timer = setTimeout(() => this.fail(new Error("Timed out waiting for Stockfish UCI initialization")), INIT_TIMEOUT_MS);
    timer.unref();
    void this.initialization.finally(() => clearTimeout(timer)).catch(() => undefined);
  }

  private write(cmd: string) {
    this.sf.stdin.write(cmd + "\n");
  }

  private fail(error: Error) {
    if (!this.initialized) this.initReject(error);
    this.readyResolve = null;
    const reject = this.pendingReject;
    this.pending = null;
    this.pendingReject = null;
    reject?.(error);
  }

  private waitUntilReady(): Promise<void> {
    return new Promise((resolve) => {
      this.readyResolve = resolve;
      this.write("isready");
    });
  }

  private onData(chunk: string) {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);

      if (line.startsWith("id name ")) this.engineName = line.slice(8).trim();
      if (line.startsWith("option name EvalFile ")) {
        this.network = line.match(/\bdefault (\S+)/)?.[1];
      }
      if (line === "uciok") {
        this.write(`setoption name Threads value ${THREADS}`);
        this.write(`setoption name Hash value ${HASH_MB}`);
        this.write("setoption name UCI_ShowWDL value true");
        void this.waitUntilReady();
        continue;
      }
      if (line === "readyok") {
        if (!this.initialized) {
          this.initialized = true;
          this.initResolve();
        }
        const resolve = this.readyResolve;
        this.readyResolve = null;
        resolve?.();
        continue;
      }

      const info = parseUciInfo(line);
      if (info?.pv?.length) this.candidates.set(info.rank, info);

      if (line.startsWith("bestmove")) this.finish(line.split(/\s+/)[1]);
    }
  }

  private finish(best: string | undefined) {
    const resolve = this.pending;
    if (!resolve) return;
    const normalized = [...this.candidates.values()]
      .sort((a, b) => a.rank - b.rank)
      .map((candidate): CandidateLine => normalizeScore({ ...candidate, pv: candidate.pv ?? [] }, this.stm));
    const primary = normalized.find((candidate) => candidate.rank === 1) ?? normalized[0];

    this.pending = null;
    this.pendingReject = null;
    const provenance: EngineProvenance = {
      engine: "stockfish",
      engineName: this.engineName,
      engineVersion: versionFromName(this.engineName),
      network: this.network,
      binarySha256: this.binaryDigestValue,
      networkHash: networkHashFromName(this.network),
      profileId: this.profile.id,
      profileVersion: this.profile.version,
      limit: this.profile.limit,
      multiPv: this.profile.multiPv,
      threads: THREADS,
      hashMb: HASH_MB,
      workerRevision: WORKER_REVISION,
      cacheProvenance: "tempo",
    };
    resolve({
      cacheKey: analysisCacheKey(provenance),
      depth: primary?.depth ?? 0,
      evalCp: primary?.evalCp,
      mate: primary?.mate,
      wdl: primary?.wdl,
      best: best && best !== "(none)" ? best : undefined,
      candidates: normalized,
      nodes: primary?.nodes,
      nps: primary?.nps,
      engineTimeMs: primary?.engineTimeMs,
      elapsedMs: Date.now() - this.startedAt,
      provenance,
    });
  }

  /** Backwards-compatible depth overload plus the reproducible profile API. */
  analyze(fen: string, depth?: number): Promise<PositionEval>;
  analyze(fen: string, profile: AnalysisProfile, history?: SearchHistory): Promise<PositionEval>;
  analyze(
    fen: string,
    depthOrProfile: number | AnalysisProfile = 14,
    history?: SearchHistory,
  ): Promise<PositionEval> {
    const profile: AnalysisProfile = typeof depthOrProfile === "number"
      ? { id: "legacy-depth", version: 1, limit: { type: "depth", value: depthOrProfile }, multiPv: 1 }
      : depthOrProfile;

    const work = async () => {
      await this.initialization;
      this.binaryDigestValue = await this.binaryDigest;
      this.write(`setoption name MultiPV value ${profile.multiPv}`);
      await this.waitUntilReady();
      return new Promise<PositionEval>((resolve, reject) => {
        this.stm = sideToMove(fen);
        this.profile = profile;
        this.candidates = new Map();
        this.startedAt = Date.now();
        this.pending = (evaluation) => resolve({ fen, ...evaluation });
        this.pendingReject = reject;
        // A history-exact search hands the engine the position at the last
        // irreversible move plus the moves since, so repetition and the
        // fifty-move rule are facts it can see rather than context it lost. A
        // bare `position fen` erases both.
        this.write(
          history && history.moves.length > 0
            ? `position fen ${history.rootFen} moves ${history.moves.join(" ")}`
            : `position fen ${fen}`,
        );
        this.write(`go ${profile.limit.type} ${profile.limit.value}`);
      });
    };

    const result = this.queue.then(work, work);
    this.queue = result.catch(() => undefined);
    return result;
  }

  quit() {
    try {
      this.write("quit");
    } catch {
      /* ignore */
    }
    this.sf.kill();
  }
}

/**
 * Ask Stockfish for a move at a capped strength — for "play it out vs the bot".
 * Uses UCI_LimitStrength + UCI_Elo (clamped to Stockfish's 1320–3190 range) and
 * a short thinking time. Spawns a throwaway process per move.
 */
export async function botMove(
  fen: string,
  elo: number,
  movetimeMs = 350,
): Promise<string | undefined> {
  const sf = spawn(ENGINE_PATH, []);
  const clampedElo = Math.max(1320, Math.min(3190, Math.round(elo)));
  return new Promise<string | undefined>((resolve, reject) => {
    let buf = "";
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      try {
        sf.stdin.write("quit\n");
      } catch {
        /* ignore */
      }
      sf.kill();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Bot move timed out"));
    }, movetimeMs + 9000);
    timer.unref();
    sf.on("error", (error) => {
      clearTimeout(timer);
      cleanup();
      reject(error);
    });
    sf.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line === "uciok") {
          sf.stdin.write("setoption name UCI_LimitStrength value true\n");
          sf.stdin.write(`setoption name UCI_Elo value ${clampedElo}\n`);
          sf.stdin.write(`position fen ${fen}\n`);
          sf.stdin.write(`go movetime ${movetimeMs}\n`);
        }
        if (line.startsWith("bestmove")) {
          clearTimeout(timer);
          const move = line.split(/\s+/)[1];
          cleanup();
          resolve(move && move !== "(none)" ? move : undefined);
          return;
        }
      }
    });
    sf.stdin.write("uci\n");
  });
}

/** Analyze a list of positions sequentially on one engine process. */
export async function analyzeFens(fens: string[], depth = 12, multiPv = 1): Promise<PositionEval[]> {
  const engine = new Engine();
  try {
    const out: PositionEval[] = [];
    const profile: AnalysisProfile = {
      id: "legacy-depth",
      version: 1,
      limit: { type: "depth", value: depth },
      multiPv,
    };
    for (const fen of fens) out.push(await engine.analyze(fen, profile));
    return out;
  } finally {
    engine.quit();
  }
}
