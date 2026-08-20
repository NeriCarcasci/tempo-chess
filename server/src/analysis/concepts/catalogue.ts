/**
 * The named ideas Forma measures, version 1.
 *
 * E13 built the vocabulary (`analysis/observations.ts`), the tables, and the
 * whole consumer side — `estimates/aggregate.ts` reads opportunities, turns
 * them into skill estimates, and the baseline report renders those. What it
 * never had was a producer. `analysis.concepts` was empty in every environment
 * that was not a gate, so the estimator grouped zero rows into zero dimensions
 * and every report came out with nothing measured in it.
 *
 * This is the catalogue that producer works from. Each entry is a claim Forma
 * is prepared to defend to a player, so each carries a human definition written
 * for them rather than for the detector.
 *
 * ## What is in v1, and what is deliberately not
 *
 * Every concept here is detectable from evidence the pipeline already produces:
 * the position graph, the engine's transition assessments, and the board
 * itself. Nothing here needs a model that does not exist.
 *
 * That rules out the concepts a player would most like — "you hang pieces to
 * knight forks", "you miss back-rank mates" — because naming a *motif* requires
 * a motif detector, and inventing one from expected-score deltas would produce
 * confident labels with nothing behind them. Two of the six below are genuinely
 * board-derived (`material_safety`, `free_material`, via static exchange
 * evaluation); the other four are about the quality of a decision under a
 * stated condition. Both kinds are honest. Only the first kind is about chess
 * ideas, and the catalogue says which is which through `evidenceSourceKind`.
 *
 * Motif families are the obvious v2, and they slot in here without touching
 * anything downstream: a new concept is a new row and a new detector, and the
 * estimator picks it up because it groups by whatever it finds.
 *
 * ## Why `recognize` and `execute` are separate rows
 *
 * §17.4, and the reason the epic exists. A player who saw the critical move and
 * calculated it wrong has a different problem from one who never considered it,
 * and a single "accuracy" number describes neither. `critical_moment` is the
 * one concept where both halves are separately observable from what the engine
 * already recorded: whether the played move was among the lines the search
 * retained (they were looking at a real candidate) is a different fact from
 * whether it was good enough (they chose well among them).
 */

import { createHash } from "node:crypto";
import type { ConceptCategory, ConceptRole } from "../observations.js";

/** Where the evidence for an observation comes from. Mirrors the column check. */
export type EvidenceSourceKind = "engine" | "deterministic" | "human_model";

export interface ConceptDefinition {
  readonly slug: string;
  readonly family: string;
  readonly category: ConceptCategory;
  readonly displayName: string;
  /** Written for the player whose game it describes, not for the detector. */
  readonly humanDefinition: string;
  readonly supportedRoles: readonly ConceptRole[];
  readonly evidenceSourceKind: EvidenceSourceKind;
  /**
   * What the detector actually tests, in enough detail to reproduce it. Stored
   * on the version row, so a change in the rule is a change in the hash and
   * therefore a new version rather than a quiet redefinition of history.
   */
  readonly detectorContract: Record<string, unknown>;
}

/** Static exchange evaluation threshold, in centipawns, for "material is winnable". */
export const MATERIAL_THRESHOLD_CP = 100;

/** Expected score, from the subject's side, at which a position is "winning". */
export const WINNING_THRESHOLD = 0.75;

/** Expected score, from the subject's side, at which a position is "worse". */
export const WORSE_THRESHOLD = 0.35;

export const CONCEPT_CATALOGUE: readonly ConceptDefinition[] = Object.freeze([
  {
    slug: "material_safety",
    family: "material",
    category: "tactical",
    displayName: "Keeping your pieces safe",
    humanDefinition:
      "One of your pieces was available to be taken for less than it is worth, and you were to move. "
      + "This measures whether you noticed and dealt with it.",
    supportedRoles: ["respond"],
    evidenceSourceKind: "deterministic",
    detectorContract: {
      method: "static_exchange_evaluation",
      trigger:
        "before the subject's move, some subject piece can be captured by the opponent with SEE >= threshold",
      success:
        "after the subject's move, no subject piece can be captured by the opponent with SEE >= threshold",
      thresholdCp: MATERIAL_THRESHOLD_CP,
      note:
        "Trigger and success are both read from the board, so this does not depend on the engine "
        + "having reached the position.",
    },
  },
  {
    slug: "free_material",
    family: "material",
    category: "tactical",
    displayName: "Taking what is offered",
    humanDefinition:
      "Your opponent left something available to be taken for less than it is worth. "
      + "This measures whether you took it.",
    supportedRoles: ["recognize"],
    evidenceSourceKind: "deterministic",
    detectorContract: {
      method: "static_exchange_evaluation",
      trigger:
        "before the subject's move, some opponent piece can be captured by the subject with SEE >= threshold",
      success: "the move played was a capture with SEE >= threshold",
      thresholdCp: MATERIAL_THRESHOLD_CP,
      note:
        "Success requires taking material, not merely playing a good move. A better move may exist; "
        + "this concept is only about whether the offer was seen and accepted.",
    },
  },
  {
    slug: "critical_moment",
    family: "decision",
    category: "tactical",
    displayName: "Positions that decide the game",
    humanDefinition:
      "A moment where the moves available led to genuinely different games. "
      + "Recognising one is finding a move worth considering; executing is choosing well among them.",
    supportedRoles: ["recognize", "execute"],
    evidenceSourceKind: "engine",
    detectorContract: {
      method: "engine_transition_assessment",
      trigger: "the transition carries a criticality score, which the deep search records",
      recognize: "the move played was among the lines the search retained (played_move_rank is set)",
      execute: "the move played was within the objective tolerance (played_move_acceptable)",
      note:
        "Only positions the deep search reached carry criticality, so this measures decisions at "
        + "moments already judged worth a closer look, not every move of the game.",
    },
  },
  {
    slug: "only_move",
    family: "decision",
    category: "defensive",
    displayName: "Finding the only move",
    humanDefinition:
      "A position where exactly one move held and everything else lost ground. "
      + "This measures whether you found it.",
    supportedRoles: ["recognize"],
    evidenceSourceKind: "engine",
    detectorContract: {
      method: "engine_transition_assessment",
      trigger: "only_move is true on the transition",
      success: "played_move_acceptable",
    },
  },
  {
    slug: "winning_conversion",
    family: "conversion",
    category: "conversion",
    displayName: "Converting a winning position",
    humanDefinition:
      "You reached a position that should win. This measures whether it still should by the time "
      + "you stopped moving.",
    supportedRoles: ["convert"],
    evidenceSourceKind: "engine",
    detectorContract: {
      method: "expected_score_trajectory",
      trigger: `the subject's expected score first reaches ${WINNING_THRESHOLD}`,
      success: `the subject's expected score after their final move is at least ${WINNING_THRESHOLD}`,
      censored:
        "if the subject made no move after reaching the winning position -- the opponent resigned or "
        + "the game ended -- there was nothing to convert and nothing is recorded",
      note: "One observation per game, not per move.",
    },
  },
  {
    slug: "worse_position_defence",
    family: "resilience",
    category: "defensive",
    displayName: "Defending a worse position",
    humanDefinition:
      "You were worse and had to keep the game alive. This measures whether your moves held the "
      + "position rather than accelerating the slide.",
    supportedRoles: ["respond"],
    evidenceSourceKind: "engine",
    detectorContract: {
      method: "engine_transition_assessment",
      trigger: `the subject's expected score before the move is at most ${WORSE_THRESHOLD}`,
      success: "played_move_acceptable",
      note:
        "Being worse is not a failure and is not counted as one. Only the move played from there is "
        + "judged, and only against what was available in that position.",
    },
  },
]);

/** The version this catalogue describes. A change to any rule is a new one. */
export const CATALOGUE_VERSION_NO = 1;

/**
 * The hash a concept version is pinned by.
 *
 * Over the definition rather than the row: the slug, the roles and the detector
 * contract are what determine whether two observations mean the same thing, and
 * the display name is not. Renaming "Taking what is offered" must not orphan a
 * season of evidence.
 */
export function conceptVersionHash(definition: ConceptDefinition): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        slug: definition.slug,
        versionNo: CATALOGUE_VERSION_NO,
        roles: [...definition.supportedRoles].sort(),
        evidenceSourceKind: definition.evidenceSourceKind,
        detector: definition.detectorContract,
      }),
    )
    .digest("hex");
}

export function conceptBySlug(slug: string): ConceptDefinition | undefined {
  return CONCEPT_CATALOGUE.find((concept) => concept.slug === slug);
}
