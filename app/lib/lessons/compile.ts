import { Chess } from "chess.js";
import type { CompiledLesson, CompiledStep, RawLesson } from "./types";

const sq = (name: string): number => (Number(name[1]) - 1) * 8 + (name.charCodeAt(0) - 97);

/**
 * Replay a raw lesson's SAN moves to derive FEN/UCI for each step and validate
 * legality. Throws with a clear message on the first illegal move so authoring
 * mistakes are caught at load, never rendered as a broken board.
 */
export function compileLesson(raw: RawLesson): CompiledLesson {
  const game = new Chess();
  const steps: CompiledStep[] = [];
  raw.moves.forEach((step, ply) => {
    const fenBefore = game.fen();
    const by: "white" | "black" = game.turn() === "w" ? "white" : "black";
    let move;
    try {
      move = game.move(step.san);
    } catch {
      throw new Error(`Lesson "${raw.slug}": illegal move #${ply + 1} "${step.san}" at ${fenBefore}`);
    }
    const uci = move.from + move.to + (move.promotion ?? "");
    steps.push({
      ply,
      san: move.san,
      uci,
      from: sq(move.from),
      to: sq(move.to),
      by,
      interactive: step.interactive ?? by === raw.color,
      explain: step.explain,
      ask: step.ask,
      fenBefore,
      fenAfter: game.fen(),
    });
  });
  return {
    slug: raw.slug,
    family: raw.family,
    color: raw.color,
    title: raw.title,
    subtitle: raw.subtitle,
    intro: raw.intro,
    ideas: raw.ideas ?? [],
    steps,
    interactiveCount: steps.filter((s) => s.interactive).length,
  };
}

/** Compile a set of raw lessons, dropping (and warning about) any that fail to validate. */
export function compileAll(raws: RawLesson[]): CompiledLesson[] {
  const out: CompiledLesson[] = [];
  for (const raw of raws) {
    try {
      out.push(compileLesson(raw));
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(error instanceof Error ? error.message : error);
    }
  }
  return out;
}
