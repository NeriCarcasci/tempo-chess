/**
 * Lesson model. Authors write lessons as a natural SAN move sequence plus a
 * plain-language explanation for each move; `compileLesson` (see compile.ts)
 * replays the moves with chess.js to derive FENs/UCI and to *validate* that
 * every move is legal, so bad content fails loudly instead of shipping.
 */

export interface RawLessonStep {
  /** The move in Standard Algebraic Notation from the current position, e.g. "Nf3", "exd5", "O-O". */
  san: string;
  /** Force whether the learner must find this move. Defaults to true for the learner's own side. */
  interactive?: boolean;
  /** The "why" — shown after the move is played. Aim for a sentence or two of real teaching. */
  explain: string;
  /** Optional nudge shown before an interactive move (e.g. "Develop toward the centre"). */
  ask?: string;
}

export interface RawLesson {
  slug: string;
  /** Opening family — should match the names used across the app (openingContent.ts). */
  family: string;
  /** The side the learner plays and is being taught. */
  color: "white" | "black";
  title: string;
  subtitle: string;
  /** One short paragraph shown on the lesson's start screen. */
  intro: string;
  /** Key ideas / plan bullets shown alongside the board. */
  ideas?: string[];
  /** The full line, both sides, in order. */
  moves: RawLessonStep[];
}

export interface CompiledStep {
  /** Ply index (0-based) within the lesson. */
  ply: number;
  san: string;
  uci: string;
  from: number;
  to: number;
  by: "white" | "black";
  interactive: boolean;
  explain: string;
  ask?: string;
  /** FEN *before* this move is played (the position the learner sees). */
  fenBefore: string;
  /** FEN *after* this move. */
  fenAfter: string;
}

export interface CompiledLesson {
  slug: string;
  family: string;
  color: "white" | "black";
  title: string;
  subtitle: string;
  intro: string;
  ideas: string[];
  steps: CompiledStep[];
  /** Number of interactive (learner) moves — the score denominator. */
  interactiveCount: number;
}
