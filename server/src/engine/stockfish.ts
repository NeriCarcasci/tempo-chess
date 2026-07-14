import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface PositionEval {
  fen: string;
  depth: number;
  evalCp?: number; // centipawns, White's perspective
  mate?: number; // mate-in-N, White's perspective (signed)
  best?: string; // best move (UCI)
}

const ENGINE_PATH = process.env.STOCKFISH_PATH || "stockfish";

const sideToMove = (fen: string): "w" | "b" =>
  (fen.split(" ")[1] as "w" | "b") ?? "w";

/**
 * A single long-lived Stockfish process spoken to over UCI. Analyses are
 * serialized: await each analyze() before the next. Scores are normalized to
 * White's perspective (UCI reports from the side to move).
 */
export class Engine {
  private sf: ChildProcessWithoutNullStreams;
  private buf = "";
  private pending: ((e: Omit<PositionEval, "fen">) => void) | null = null;
  private cur: { depth: number; evalCp?: number; mate?: number } = { depth: 0 };
  private stm: "w" | "b" = "w";

  constructor(path = ENGINE_PATH) {
    this.sf = spawn(path);
    this.sf.stdout.on("data", (d: Buffer) => this.onData(d.toString()));
    this.write("uci");
    this.write("setoption name Threads value 1");
    this.write("setoption name Hash value 64");
  }

  private write(cmd: string) {
    this.sf.stdin.write(cmd + "\n");
  }

  private onData(chunk: string) {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line.startsWith("info") && line.includes(" pv ")) {
        const dm = line.match(/ depth (\d+)/);
        if (dm) this.cur.depth = Number(dm[1]);
        const cp = line.match(/score cp (-?\d+)/);
        const mate = line.match(/score mate (-?\d+)/);
        if (cp) {
          this.cur.evalCp = Number(cp[1]);
          this.cur.mate = undefined;
        } else if (mate) {
          this.cur.mate = Number(mate[1]);
          this.cur.evalCp = undefined;
        }
      } else if (line.startsWith("bestmove")) {
        const best = line.split(/\s+/)[1];
        const sign = this.stm === "b" ? -1 : 1;
        const resolve = this.pending;
        this.pending = null;
        resolve?.({
          depth: this.cur.depth,
          evalCp: this.cur.evalCp !== undefined ? sign * this.cur.evalCp : undefined,
          mate: this.cur.mate !== undefined ? sign * this.cur.mate : undefined,
          best: best && best !== "(none)" ? best : undefined,
        });
      }
    }
  }

  analyze(fen: string, depth = 14): Promise<PositionEval> {
    return new Promise((resolve) => {
      this.stm = sideToMove(fen);
      this.cur = { depth: 0 };
      this.pending = (e) => resolve({ fen, ...e });
      this.write("isready");
      this.write(`position fen ${fen}`);
      this.write(`go depth ${depth}`);
    });
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

/** Analyze a list of positions sequentially on one engine process. */
export async function analyzeFens(fens: string[], depth = 12): Promise<PositionEval[]> {
  const engine = new Engine();
  try {
    const out: PositionEval[] = [];
    for (const fen of fens) out.push(await engine.analyze(fen, depth));
    return out;
  } finally {
    engine.quit();
  }
}
