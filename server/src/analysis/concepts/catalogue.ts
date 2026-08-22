/**
 * The named ideas Forma measures.
 *
 * Each entry carries its own version. `plans/tactical-concepts-contracts.md` is
 * the authoritative statement of what every one of them may claim; this file is
 * that matrix in executable form, and if the two disagree the matrix is what
 * gets corrected first.
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
 * §17.4, and the reason the epic exists. A player who found the critical move
 * and calculated it wrong has a different problem from one who never played
 * anything like it, and a single "accuracy" number describes neither.
 * `critical_moment` is the one concept where both halves are separately
 * observable from what the engine already recorded: whether the played move was
 * among the candidates the search retained is a different fact from whether it
 * was within tolerance.
 *
 * Both are facts about the search and the move, not about the player's mind.
 * v1 described the first as "finding a move worth considering", which reads as
 * a claim about what they were thinking; the engine cannot see that and neither
 * can this. What it can see is whether the move they chose was one the search
 * took seriously, which is worth knowing and is all that is claimed.
 */

import { createHash } from "node:crypto";
import type { ConceptCategory, ConceptRole } from "../observations.js";

/** Where the evidence for an observation comes from. Mirrors the column check. */
export type EvidenceSourceKind = "engine" | "deterministic" | "human_model";

/**
 * How one role of one concept reads in a sentence written for the player.
 *
 * `estimates/render.ts` builds a finding's prose from templates and had nothing
 * to name the subject with except the dimension key, so a report told a paying
 * customer that `critical_moment_recognize_objective` was costing them 22% of
 * their chances — an internal column name and a bare number.
 *
 * Three clauses rather than one, because a finding says three different things
 * about the same role and each needs a different grammatical shape: what a
 * chance at it was, what doing it right looked like, and what going wrong
 * looked like. Deriving the last two from the first by negation produces "you
 * did not deal with it", which is limp where the concrete verb is not.
 *
 * These are display text, and deliberately outside `conceptVersionHash` for the
 * same reason `displayName` is: rewording a sentence for a reader must not
 * orphan a season of evidence recorded under the old wording.
 */
export interface RoleNarrative {
  /** Completes "chances to …". */
  readonly opportunity: string;
  /** Completes "you … 12 times". Past tense, no subject. */
  readonly succeeded: string;
  /** Completes "9 times you …". Past tense, no subject. */
  readonly missed: string;
}

export interface ConceptDefinition {
  readonly slug: string;
  readonly family: string;
  readonly category: ConceptCategory;
  readonly displayName: string;
  /**
   * The version of *this* concept, not of the catalogue.
   *
   * It used to be one number for all of them, which meant correcting one rule
   * minted a new version of every other concept as a side effect -- six new
   * rows, five of them describing a rule that had not changed, and evidence
   * split across versions for no reason anyone could later reconstruct.
   * Bumping this bumps one concept. See FOR-122.
   */
  readonly versionNo: number;
  /** Written for the player whose game it describes, not for the detector. */
  readonly humanDefinition: string;
  readonly supportedRoles: readonly ConceptRole[];
  /**
   * Reader-facing wording for each supported role.
   *
   * A role with no entry renders as the concept's display name alone, which is
   * a poorer sentence but never a slug. `estimates:unit` asserts that every
   * supported role of every concept has one, so the fallback stays theoretical.
   */
  readonly roleNarratives: Readonly<Partial<Record<ConceptRole, RoleNarrative>>>;
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

/**
 * The spread between the best and worst retained candidate at which a decision
 * is critical.
 *
 * v1 had no threshold, and `criticality` is non-null whenever the search
 * retained two lines. So every position the deep search reached became "a
 * moment where the moves available led to genuinely different games" --
 * including positions where both retained lines were equal and nothing was at
 * stake. The concept measured "did the deep search run here", which is a fact
 * about the pipeline rather than about the game.
 *
 * 0.10 against `TOLERANCE_RULE.expectedScoreTolerance` of 0.02: two moves
 * within 0.02 are already defined as indistinguishable, and a choice that moves
 * the expected result by five times that much is one a player can be said to
 * have faced.
 */
export const CRITICALITY_THRESHOLD = 0.10;

export const CONCEPT_CATALOGUE: readonly ConceptDefinition[] = Object.freeze([
  {
    slug: "material_safety",
    family: "material",
    category: "tactical",
    versionNo: 2,
    displayName: "Keeping your pieces safe",
    humanDefinition:
      "One of your pieces was available to be taken for less than it is worth, and you were to move. "
      + "This measures whether you dealt with that piece.",
    supportedRoles: ["respond"],
    roleNarratives: {
      respond: {
        opportunity: "save a piece your opponent could have taken",
        succeeded: "saved it",
        missed: "left it there",
      },
    },
    evidenceSourceKind: "deterministic",
    detectorContract: {
      method: "static_exchange_evaluation",
      trigger:
        "before the subject's move, a specific subject piece on square S can be captured by the "
        + "opponent with SEE >= threshold",
      focus:
        "the exposure of that one piece, tracked across the move -- if the subject moved it, the "
        + "square follows the piece",
      success: "after the move, that same piece cannot be captured with SEE >= threshold",
      failure: "the exposure persists and the engine judged the move outside tolerance",
      abstain:
        "the exposure persists but the engine judged the move acceptable. A sound sacrifice is not "
        + "a hung piece, and static exchange alone cannot tell them apart",
      thresholdCp: MATERIAL_THRESHOLD_CP,
      note:
        "v1 asked whether *any* subject piece was exposed after the move, so saving the hanging "
        + "knight while a pawn became loose scored as a failure, and every deliberate sacrifice "
        + "scored as one too.",
    },
  },
  {
    slug: "free_material",
    family: "material",
    category: "tactical",
    versionNo: 2,
    displayName: "Taking what is offered",
    humanDefinition:
      "Your opponent left something available to be taken for less than it is worth. "
      + "This measures whether you took it, or played something at least as good.",
    supportedRoles: ["recognize"],
    roleNarratives: {
      recognize: {
        opportunity: "take material your opponent had left hanging",
        succeeded: "took it",
        missed: "played something else",
      },
    },
    evidenceSourceKind: "deterministic",
    detectorContract: {
      method: "static_exchange_evaluation",
      trigger:
        "before the subject's move, some opponent piece can be captured by the subject with SEE >= threshold",
      success:
        "the move played was a capture with SEE >= threshold, or the engine judged the move played "
        + "within tolerance -- a stronger move is not a missed offer",
      failure:
        "the move was not a material-winning capture, was outside tolerance, and the engine's best "
        + "move was itself a material-winning capture",
      abstain:
        "the move was outside tolerance but the engine's best move was not a material-winning "
        + "capture. That proves the played move was suboptimal, not that this offer was why",
      thresholdCp: MATERIAL_THRESHOLD_CP,
      note:
        "v1 scored any non-capture as a failure, so a mate in one, a winning zwischenzug and a "
        + "stronger recapture all counted as missing free material. v2 only records a miss when "
        + "the engine evidence specifically verifies a material-winning capture as best.",
    },
  },
  {
    slug: "critical_moment",
    family: "decision",
    category: "tactical",
    versionNo: 2,
    displayName: "Positions that decide the game",
    humanDefinition:
      "A moment where the moves available led to genuinely different games. "
      + "One half of this is whether the move you played was one the engine was seriously "
      + "considering; the other is whether it was good enough.",
    supportedRoles: ["recognize", "execute"],
    roleNarratives: {
      recognize: {
        opportunity: "notice that a position was worth real thought",
        succeeded: "spotted it",
        missed: "played on without seeing the moment",
      },
      execute: {
        opportunity: "choose well in a position that decided something",
        succeeded: "chose well",
        missed: "picked the wrong one of the moves in front of you",
      },
    },
    evidenceSourceKind: "engine",
    detectorContract: {
      method: "engine_transition_assessment",
      trigger:
        "criticality >= criticalityThreshold, where criticality is the spread between the best and "
        + "worst candidate the deep search retained",
      criticalityThreshold: CRITICALITY_THRESHOLD,
      recognize:
        "the move played was among the candidates the search retained (played_move_rank is set). "
        + "This is a fact about the search, not about what the player thought",
      execute: "the move played was within the objective tolerance (played_move_acceptable)",
      abstain:
        "criticality is null -- fewer than two lines were retained, so the position has no spread "
        + "to measure -- or the spread is below the threshold",
      note:
        "v1 emitted whenever criticality was non-null, which is whenever the search returned two "
        + "lines. A position where every retained line was equal counted as a moment that decided "
        + "the game, so the concept partly measured where the deep search happened to run.",
    },
  },
  {
    slug: "only_move",
    family: "decision",
    category: "defensive",
    versionNo: 2,
    displayName: "Finding the move that held",
    humanDefinition:
      "A position where, of the moves the engine examined, exactly one held and the rest lost "
      + "ground. This measures whether you found it.",
    supportedRoles: ["recognize"],
    roleNarratives: {
      recognize: {
        opportunity: "find the single move that held",
        succeeded: "found it",
        missed: "played one of the moves that did not hold",
      },
    },
    evidenceSourceKind: "engine",
    detectorContract: {
      method: "engine_transition_assessment",
      trigger: "only_move is true: exactly one retained candidate was within tolerance",
      success: "played_move_acceptable",
      coverage:
        "absolute when the search retained as many lines as the position has legal moves, searched "
        + "otherwise. The claim is about the moves examined, never about every legal move",
      abstain: "only_move is null -- a search that retained fewer than two lines has no answer",
      note:
        "v1 said exactly one move held and everything else lost ground, which asserts a proof over "
        + "all legal moves that a MultiPV search does not perform.",
    },
  },
  {
    slug: "winning_conversion",
    family: "conversion",
    category: "conversion",
    versionNo: 2,
    displayName: "Converting a winning position",
    humanDefinition:
      "You reached a position that should win. This measures whether it still should by the time "
      + "you stopped moving.",
    supportedRoles: ["convert"],
    roleNarratives: {
      convert: {
        opportunity: "finish a game you had already won",
        succeeded: "finished it",
        missed: "let it slip back",
      },
    },
    evidenceSourceKind: "engine",
    detectorContract: {
      method: "expected_score_trajectory",
      trigger:
        `the subject's expected score first reaches ${WINNING_THRESHOLD} after some transition. `
        + "The opportunity begins in that position, not in the one they moved from",
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
    versionNo: 1,
    displayName: "Defending a worse position",
    humanDefinition:
      "You were worse and had to keep the game alive. This measures whether your moves held the "
      + "position rather than accelerating the slide.",
    supportedRoles: ["respond"],
    roleNarratives: {
      respond: {
        opportunity: "hold a position you were already worse in",
        succeeded: "held it",
        missed: "made it heavier",
      },
    },
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
  {
    slug: "double_attack",
    family: "tactics",
    category: "tactical",
    versionNo: 1,
    displayName: "Attacking two things at once",
    humanDefinition:
      "One of your pieces attacked two things your opponent could not both save. "
      + "This measures whether you collected what it won -- or, when your opponent "
      + "did it to you, whether you gave up less than it threatened.",
    supportedRoles: ["execute", "respond"],
    roleNarratives: {
      execute: {
        opportunity: "attack two things at once and take one of them",
        succeeded: "took what the double attack won",
        missed: "attacked two things and did not collect either",
      },
      respond: {
        opportunity: "answer a double attack against you",
        succeeded: "saved more than the double attack threatened",
        missed: "lost what the double attack threatened",
      },
    },
    evidenceSourceKind: "deterministic",
    detectorContract: {
      method: "attack_map_and_static_exchange",
      geometry:
        "after the focal move, the piece that moved attacks two or more relevant enemy targets. "
        + "A target is relevant when it is the king or when taking it wins material by SEE",
      verification:
        "against every legal reply, after following the named targets and subtracting any material "
        + "the reply captures, static exchange still wins at least the threshold",
      storedLine:
        "where the deep search stored a line for the resulting position, it is replayed and must "
        + "agree; a stored line that contradicts the static answer abstains rather than being "
        + "overruled",
      subtypes: ["fork", "royal_fork"],
      execute: "success is a follow-up capture of a named target, or immediate mate; an acceptable non-target follow-up abstains",
      respond: "success is reaching the verified best-defence bound or better, including counter-captures",
      censored: "the subject never moved again, so the game never asked the question",
      abstain:
        "fewer than two relevant targets, any reply that saves everything, an unreadable position, "
        + "or evidence that disagrees with itself",
      thresholdCp: MATERIAL_THRESHOLD_CP,
      horizon: "one ply of defence, plus a stored line where one exists",
    },
  },
  {
    slug: "pin",
    family: "tactics",
    category: "tactical",
    versionNo: 1,
    displayName: "Pinning a piece",
    humanDefinition:
      "A piece could not move without giving up something worth more behind it, "
      + "and that was worth material. This measures whether you won it -- or, when "
      + "it was done to you, whether you got out of it.",
    supportedRoles: ["execute", "respond"],
    roleNarratives: {
      execute: {
        opportunity: "pin a piece and win it",
        succeeded: "won the pinned piece",
        missed: "pinned a piece and let it go",
      },
      respond: {
        opportunity: "get out of a pin",
        succeeded: "got out of the pin for less than it threatened",
        missed: "lost the pinned piece",
      },
    },
    evidenceSourceKind: "deterministic",
    detectorContract: {
      method: "ray_geometry_and_static_exchange",
      geometry:
        "a pinner, a pinned piece and a more valuable target behind it on one ray, with nothing "
        + "else between. Absolute when the target is the king; relative otherwise",
      created:
        "the pin must not have existed before the focal move. A pin that has been on the board for "
        + "three moves is not something the player just did",
      verification:
        "against every legal reply, the named pinned piece remains winnable after counter-captures. Alignment with no way to "
        + "increase the pressure has cost the opponent nothing and is not recorded",
      execute: "success is a follow-up capture of the named pinned piece; an acceptable non-target follow-up abstains",
      respond: "success is reaching the verified best-defence bound or better",
      censored: "the subject never moved again",
      abstain:
        "a pin that already existed, alignment with no verified consequence, equal or beneficial "
        + "exchanges, or an unreadable position",
      thresholdCp: MATERIAL_THRESHOLD_CP,
      note:
        "Which side of the ray is more valuable is what separates this from a skewer, and the two "
        + "detectors take opposite cases of the same geometry.",
    },
  },
  {
    slug: "skewer",
    family: "tactics",
    category: "tactical",
    versionNo: 1,
    displayName: "Attacking through a piece",
    humanDefinition:
      "You attacked something valuable, and when it moved, what was sheltering "
      + "behind it was taken. This measures whether you collected it -- or, when it "
      + "was done to you, whether you saved more than it threatened.",
    supportedRoles: ["execute", "respond"],
    roleNarratives: {
      execute: {
        opportunity: "attack through a piece and take what is behind it",
        succeeded: "took what was behind",
        missed: "attacked through a piece and did not take what was behind",
      },
      respond: {
        opportunity: "answer an attack that goes through one of your pieces",
        succeeded: "saved more than the attack threatened",
        missed: "lost the piece behind",
      },
    },
    evidenceSourceKind: "deterministic",
    detectorContract: {
      method: "ray_geometry_and_static_exchange",
      geometry:
        "after the focal move, the piece that moved attacks an enemy piece with a second enemy "
        + "piece directly behind it on the same ray, and the front one is worth strictly more",
      distinguishedFromPin:
        "a pin has the valuable piece behind; a skewer has it in front. Equal values are neither, "
        + "so the two detectors cannot both label one shape",
      attribution:
        "with the front piece removed from the board, static exchange on the rear one must still "
        + "win material -- otherwise the skewer is credited with material won elsewhere",
      verification:
        "against every legal reply, the named rear target remains winnable after counter-captures",
      execute: "success is a follow-up capture of the named rear target; an acceptable non-target follow-up abstains",
      respond: "success is reaching the verified best-defence bound or better",
      censored: "the subject never moved again",
      abstain:
        "equal or inverted values, a rear piece that survives once the front one moves, any reply "
        + "that saves everything, or an unreadable position",
      thresholdCp: MATERIAL_THRESHOLD_CP,
    },
  },
  {
    slug: "discovered_attack",
    family: "tactics",
    category: "tactical",
    versionNo: 1,
    displayName: "Uncovering an attack",
    humanDefinition:
      "Moving one piece uncovered an attack from the piece behind it. This "
      + "measures whether you collected what that won -- or, when it was done to "
      + "you, whether you gave up less than it threatened.",
    supportedRoles: ["execute", "respond"],
    roleNarratives: {
      execute: {
        opportunity: "move one piece to uncover an attack from another",
        succeeded: "took what the uncovered attack won",
        missed: "uncovered an attack and did not collect it",
      },
      respond: {
        opportunity: "answer an attack uncovered against you",
        succeeded: "conceded less than the uncovered attack threatened",
        missed: "lost what the uncovered attack threatened",
      },
    },
    evidenceSourceKind: "deterministic",
    detectorContract: {
      method: "attack_map_difference_and_static_exchange",
      geometry:
        "a slider of the moving side attacks a target after the move that it did not attack "
        + "before, and the square the mover left lies between them",
      subtypes: ["discovered_attack", "discovered_check", "double_check"],
      doubleCheck: "the moving piece also gives check, which no interposition or capture answers",
      verification:
        "a discovered attack on a piece must win that piece by static exchange. A discovered "
        + "check wins nothing by itself, so a named payoff target must remain winnable once "
        + "the check has been answered -- against every legal reply and after counter-captures",
      execute: "success is a follow-up capture of a named payoff target, or immediate mate; an acceptable non-target follow-up abstains",
      respond: "success is reaching the verified best-defence bound or better",
      censored: "the subject never moved again",
      abstain:
        "a line that opens onto nothing, a target that survives the exchange, or any reply that "
        + "saves everything. Almost every piece move uncovers some ray and almost none of them "
        + "matter",
      thresholdCp: MATERIAL_THRESHOLD_CP,
    },
  },
  {
    slug: "removal_of_defender",
    family: "tactics",
    category: "tactical",
    versionNo: 1,
    displayName: "Taking out the defender",
    humanDefinition:
      "You took or drove off the piece that was guarding something, and what it "
      + "was guarding could then be won. This measures whether you won it -- or, "
      + "when it was done to you, whether you saved it.",
    supportedRoles: ["execute", "respond"],
    roleNarratives: {
      execute: {
        opportunity: "remove a defender and take what it was guarding",
        succeeded: "took what the defender was guarding",
        missed: "removed the defender and left what it guarded",
      },
      respond: {
        opportunity: "hold something whose defender was removed",
        succeeded: "held it for less than it threatened",
        missed: "lost what the removed defender was guarding",
      },
    },
    evidenceSourceKind: "deterministic",
    detectorContract: {
      method: "defender_map_and_static_exchange",
      geometry:
        "a piece that survives the focal move was defended before it by a guard the focal move "
        + "either captured or attacked hard enough to force away",
      removalMethods: ["capture", "deflection"],
      attribution:
        "with the guard removed from the board, static exchange on what it was guarding must win "
        + "material. A target with a second adequate defender is a negative -- removing one holder "
        + "of a shared duty removes nothing",
      verification:
        "against every legal reply, the named charge remains winnable after counter-captures. A target "
        + "that can simply run away has not been won, however cleanly its guard was removed",
      execute: "success is a follow-up capture of the named charge; an acceptable non-target follow-up abstains",
      respond: "success is reaching the verified best-defence bound or better",
      censored: "the subject never moved again",
      abstain:
        "a shared duty, a target that escapes, a guard that was not actually guarding, or an "
        + "unreadable position",
      thresholdCp: MATERIAL_THRESHOLD_CP,
      note:
        "Overload and attraction are deliberately not separate concepts in this MVP.",
    },
  },
  {
    slug: "trapped_piece",
    family: "tactics",
    category: "tactical",
    versionNo: 1,
    displayName: "A piece with nowhere to go",
    humanDefinition:
      "A piece had no answer left: every square it could reach lost it, and so "
      + "did staying. This measures whether you collected it -- or, when it was "
      + "your piece, whether you got it out.",
    supportedRoles: ["execute", "respond"],
    roleNarratives: {
      execute: {
        opportunity: "trap a piece and take it",
        succeeded: "took the trapped piece",
        missed: "trapped a piece and let it go",
      },
      respond: {
        opportunity: "rescue a piece with nowhere to go",
        succeeded: "got it out for less than it was worth",
        missed: "lost the trapped piece",
      },
    },
    evidenceSourceKind: "deterministic",
    detectorContract: {
      method: "exhaustive_reply_walk_and_static_exchange",
      geometry: "the focal move changes an attacked non-king enemy piece from not provably lost at this horizon to lost",
      verification:
        "every legal reply is played and the piece is followed to wherever it ends up. It is "
        + "trapped only when static exchange wins it in every one of them -- retreating, being "
        + "defended, counterattacking, and capturing on the way out all count as answers",
      kingExcluded:
        "a king with no escape is checkmate or stalemate, which are results of the game rather "
        + "than a piece being won",
      execute: "success is a follow-up capture of the named trapped piece; an acceptable non-target follow-up abstains",
      respond: "success is reaching the verified best-defence bound or better",
      censored: "the subject never moved again",
      abstain:
        "any reply that saves it, a piece below the threshold, or an unreadable position. Sound "
        + "sacrifices are not distinguishable from blunders by static exchange alone, and where "
        + "the piece is genuinely saved by compensation this records nothing",
      thresholdCp: MATERIAL_THRESHOLD_CP,
      horizon: "one ply of defence",
    },
  },
]);

/**
 * The hash a concept version is pinned by.
 *
 * Over the definition rather than the row: the slug, the roles and the detector
 * contract are what determine whether two observations mean the same thing, and
 * the display name is not. Renaming "Taking what is offered" must not orphan a
 * season of evidence.
 *
 * `versionNo` now comes from the definition rather than from one number shared
 * by the whole catalogue. For every v1 concept the hashed input is byte for byte
 * what it was, so this change registers nothing new and invalidates nothing --
 * which is the point. What it buys is that bumping `critical_moment` to 2 leaves
 * the other five hashes alone.
 */
export function conceptVersionHash(definition: ConceptDefinition): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        slug: definition.slug,
        versionNo: definition.versionNo,
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

/** Everything a sentence about one concept in one role needs. */
export interface ConceptDescription {
  readonly slug: string;
  readonly role: string;
  /** "Keeping your pieces safe". Never a slug. */
  readonly label: string;
  readonly definition: string;
  readonly narrative: RoleNarrative | null;
}

/**
 * The reader-facing description of one concept in one role.
 *
 * Falls back rather than throwing, and the fallback is still not a slug: an
 * observation recorded under a concept this build of the catalogue has never
 * heard of is a real possibility — a detector can be promoted ahead of the
 * code that reads it — and the honest answer then is a plain phrase, not the
 * database key. `estimates/render.ts` treats a null narrative as "say the
 * label and nothing more", which loses detail without ever leaking an
 * identifier.
 */
export function describeConceptRole(slug: string, role: string): ConceptDescription {
  const concept = conceptBySlug(slug);
  if (!concept) {
    return {
      slug,
      role,
      label: "something Forma measures but this build cannot name",
      definition: "",
      narrative: null,
    };
  }
  return {
    slug,
    role,
    label: concept.displayName,
    definition: concept.humanDefinition,
    narrative: concept.roleNarratives[role as ConceptRole] ?? null,
  };
}
