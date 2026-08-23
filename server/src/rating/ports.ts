/**
 * The real engine and the real policy, behind the assembler's two ports.
 *
 * `analyse.ts` deliberately knows nothing about Stockfish or Maia, so this is
 * the only file that does. It is thin on purpose: every judgement about what to
 * search and how to read the answer lives in the assembler, and everything here
 * is translation.
 *
 * Both factories can return null, and that is a state rather than a failure.
 * `resolveHumanPolicyEngine` already works this way for the pipeline: a
 * deployment without the weights produces `inference_failed` on every position
 * and the objective review is unaffected. The rating cannot degrade so
 * gracefully, because without a policy there is no strength estimate and
 * therefore no rating at all, so the caller turns a null into an honest refusal
 * rather than into a number computed some other way.
 */

import { expectedScore } from "../engine/contract.js";
import { analyzeFens } from "../engine/stockfish.js";
import { resolveHumanPolicyEngine } from "../models/worker.js";
import type { EngineLine, EnginePort, PolicyPort } from "./analyse.js";

/**
 * Search depths for the public path.
 *
 * Depth rather than nodes because that is what `analyzeFens` accepts. They are
 * stated here rather than passed in so that two public ratings are comparable:
 * a rating produced at depth 10 and one produced at depth 18 are answers to
 * different questions, and the number does not carry the depth with it.
 */
export const PUBLIC_SEARCH = {
  version: "1",
  screeningDepth: 12,
  deepDepth: 16,
} as const;

/** Stockfish, read as expected score from White's perspective. */
export function stockfishEngine(search: typeof PUBLIC_SEARCH = PUBLIC_SEARCH): EnginePort {
  return {
    async evaluate({ fen, multipv }) {
      const depth = multipv > 1 ? search.deepDepth : search.screeningDepth;
      const [result] = await analyzeFens([fen], depth, multipv);
      if (!result) return [];

      const lines: EngineLine[] = [];
      for (const candidate of result.candidates) {
        const move = candidate.pv[0];
        if (!move) continue;
        lines.push({
          uci: move,
          expectedScoreWhite: expectedScore({
            scoreCp: candidate.evalCp ?? null,
            mateIn: candidate.mate ?? null,
            wdl: candidate.wdl ?? null,
          }).value,
        });
      }

      // A search that reported no lines but did report a position score is a
      // terminal position or a search that ran out of budget. Reporting the
      // position's own value under the engine's best move keeps the screening
      // pass honest without inventing an alternative that was never examined.
      if (lines.length === 0 && result.best) {
        lines.push({
          uci: result.best,
          expectedScoreWhite: expectedScore({
            scoreCp: result.evalCp ?? null,
            mateIn: result.mate ?? null,
            wdl: result.wdl ?? null,
          }).value,
        });
      }
      return lines;
    },
  };
}

/**
 * The promoted human policy, or null when this deployment does not carry it.
 *
 * Null is not an error to log and move past. Without it the strength estimate
 * has nothing to estimate from, and a rating built on the remaining terms would
 * be an accuracy score wearing this one's name.
 */
export function humanPolicy(family: "maia1" | "maia3" = "maia3"): PolicyPort | null {
  const engine = resolveHumanPolicyEngine(family);
  if (engine === null) return null;
  return {
    async policy({ fen, rating }) {
      const inference = await engine.inferPolicy(fen, rating);
      return inference.policy;
    },
  };
}
