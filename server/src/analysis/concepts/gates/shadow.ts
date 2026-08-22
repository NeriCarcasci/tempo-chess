/**
 * `npm run concepts:shadow` — the detectors run over full games, and every
 * label they emit checked against the board it claims to describe.
 *
 * The hand-authored fixtures prove a detector finds the thing it was written
 * for. They cannot prove it stays quiet everywhere else, because a fixture is a
 * position somebody chose. This runs all twelve families over the committed
 * benchmark corpus — a hundred and twenty games across openings, middlegames
 * and endgames, both colours, quiet and tactical and winning and losing — and
 * adjudicates what comes out.
 *
 * ## What this can decide, and what it cannot
 *
 * It decides **structural validity**, exhaustively and without a human:
 *
 *   * the focal move is legal in the position it is claimed from;
 *   * every square named in the facts holds the piece the label implies;
 *   * the actor and affected colours match who actually moved;
 *   * the verification line, where one is claimed, replays legally;
 *   * ply ranges are ordered and inside the game;
 *   * no two labels share one physical occurrence and role;
 *   * every draft is recordable and its difficulty uncontaminated.
 *
 * A label failing any of those is a defect of the kind FOR-138 lists by name —
 * illegal line, wrong colour, fabricated evidence, duplicate physical event —
 * and the run fails.
 *
 * It does **not** decide semantic precision. "Is this fork worth naming to a
 * player" is a judgement about chess, and the 90% reviewed-precision bar in
 * FOR-138 means a person reading labels and disagreeing with some of them. This
 * harness produces the sample that review works from — every emitted label with
 * the position, the move, the facts and the payoff — and says plainly that the
 * review has not happened. A number invented here and called precision would be
 * the exact failure the whole project is built to avoid.
 *
 * ## Coverage is reported apart from precision
 *
 * A family that fires twice in a hundred and twenty games is not thereby
 * accurate; it is barely observed. The two numbers are printed separately so
 * neither can stand in for the other.
 */

import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { Chess as PgnChess } from "chess.js";
import { parseUci } from "chessops/util";
import { buildBenchmarkCorpus } from "../../../benchmark/corpus.js";
import { difficultyIsUncontaminated, isRecordableOpportunity } from "../../observations.js";
import { detectGame, withheldFrom } from "../detect.js";
import {
  PositionIndex,
  type CandidateLine,
  type DetectedOpportunity,
  type GameFacts,
  type PositionFact,
  type TransitionFact,
} from "../evidence.js";

/** Everything the catalogue can produce, so an unobserved family is noticed. */
const ALL_FAMILIES = [
  "double_attack",
  "pin",
  "skewer",
  "discovered_attack",
  "removal_of_defender",
  "trapped_piece",
  "material_safety",
  "free_material",
  "critical_moment",
  "only_move",
  "winning_conversion",
  "worse_position_defence",
] as const;

const TACTICAL_FAMILIES = [
  "double_attack",
  "pin",
  "skewer",
  "discovered_attack",
  "removal_of_defender",
  "trapped_piece",
] as const;

interface Defect {
  readonly game: string;
  readonly slug: string;
  readonly role: string;
  readonly focalPly: number;
  readonly kind: string;
  readonly detail: string;
}

interface FamilyResult {
  emitted: number;
  structurallyValid: number;
  censored: number;
  gamesFired: Set<string>;
  defects: Defect[];
}

/**
 * One corpus game as the detector reads it.
 *
 * The corpus stores PGN, and the endgame archetypes carry SetUp/FEN headers, so
 * the game does not always start from the initial position. Replaying through
 * `chess.js` rather than assuming a start square is what makes those twenty
 * games usable instead of silently skipped -- and the endgames are where the
 * tactical families fire most.
 *
 * `withPvs` decides whether stored candidate lines are supplied. FOR-138 asks
 * for games with and without deep evidence, because a detector that only
 * behaves when a line is present has not been validated on the games that lack
 * one, and most games lack one on most plies.
 */
/**
 * A deterministic expected-score walk that actually goes somewhere.
 *
 * Flat 0.5 for every ply means no position is ever winning and none is ever
 * worse, so two of the twelve families can never fire. This drifts across the
 * game and crosses both thresholds.
 */
function scoreAt(ply: number): number {
  const swing = Math.sin(ply / 7) * 0.42;
  return Math.min(0.98, Math.max(0.02, 0.5 + swing));
}

function factsFor(pgn: string, withPvs: boolean): GameFacts | null {
  const replay = new PgnChess();
  try {
    replay.loadPgn(pgn);
  } catch {
    return null;
  }
  const history = replay.history({ verbose: true });
  if (history.length === 0) return null;

  const positions: PositionFact[] = [{ ply: 0, fen: history[0]!.before }];
  history.forEach((move, index) => {
    positions.push({ ply: index + 1, fen: move.after });
  });

  const transitions = history.map((move, index): TransitionFact => ({
    fromPly: index,
    actorColor: move.color === "w" ? "white" : "black",
    playedMoveUci: move.lan,
    bestMoveUci: move.lan,
    playedMoveRank: 1,
    playedMoveAcceptable: true,
    // The engine-derived families read these, and a harness that held them
    // constant would validate the board detectors while never once exercising
    // `only_move`, `winning_conversion` or `worse_position_defence`. They are
    // varied deterministically -- this is a structural harness, so the point is
    // to exercise every code path, not to reproduce a real engine's judgements.
    onlyMove: index % 11 === 0 ? true : index % 8 === 0 ? false : null,
    criticality: index % 8 === 0 ? 0.4 : null,
    acceptableMoveCount: index % 8 === 0 ? 2 : null,
    candidateCount: index % 8 === 0 ? 3 : null,
    expectedScoreBefore: scoreAt(index),
    expectedScoreAfter: scoreAt(index + 1),
    phase: index < 20 ? "opening" : index < 60 ? "middlegame" : "endgame",
  }));

  const candidatesByPly = new Map<number, readonly CandidateLine[]>();
  if (withPvs) {
    for (const transition of transitions) {
      if (transition.candidateCount === null) continue;
      const next = history[transition.fromPly + 1];
      const line = next === undefined
        ? [transition.playedMoveUci]
        : [transition.playedMoveUci, next.lan];
      candidatesByPly.set(transition.fromPly + 1, [
        { rank: 1, uci: line[0]!, expectedScore: 0.5, pv: line },
      ]);
    }
  }

  // The subject is White for half the corpus and Black for the other half, so
  // both the `execute` and the `respond` side of every family is exercised. A
  // harness that only ever made the subject White would validate one of the two
  // roles each detector emits.
  return {
    subjectColor: withPvs ? "white" : "black",
    speed: "blitz",
    playedAt: new Date("2026-08-01T00:00:00Z"),
    termination: "resign",
    result: "white",
    positions,
    transitions,
    candidatesByPly,
  };
}

/** Every way a label can be structurally wrong about the board it names. */
function adjudicate(
  gameId: string,
  facts: GameFacts,
  index: PositionIndex,
  found: DetectedOpportunity,
): Defect[] {
  const defects: Defect[] = [];
  const at = (kind: string, detail: string) => defects.push({
    game: gameId,
    slug: found.conceptSlug,
    role: found.draft.role,
    focalPly: found.event.focalPly,
    kind,
    detail,
  });

  const before = index.at(found.event.focalPly);
  const after = index.at(found.event.focalPly + 1);

  if (!before) at("unreadable_position", `no position at ply ${found.event.focalPly}`);
  if (found.event.startPly > found.event.focalPly || found.event.focalPly > found.event.endPly) {
    at("ply_range", `${found.event.startPly}/${found.event.focalPly}/${found.event.endPly}`);
  }
  if (found.event.endPly > facts.positions.length) {
    at("ply_range", `end ply ${found.event.endPly} is past the end of the game`);
  }

  // Most families put their focal ply on the move that created the occurrence.
  // `winning_position_reached` does not: its focal ply is the *position* that
  // became winning, which is one past the move that made it and can be the last
  // position of the game. Requiring a move there reported two correct labels as
  // defects -- a bug in this harness, not in the detector.
  const focalIsAMove = found.event.eventType !== "winning_position_reached";
  const transition = facts.transitions.find((row) => row.fromPly === found.event.focalPly);
  if (!transition) {
    if (focalIsAMove) at("no_transition", `no move at ply ${found.event.focalPly}`);
  } else if (before) {
    const move = parseUci(transition.playedMoveUci);
    if (!move || !before.isLegal(move)) {
      at("illegal_focal_move", transition.playedMoveUci);
    }
    // The actor is whoever moved. A label that says otherwise has attributed
    // somebody's move to the other player.
    const expectedActor = transition.actorColor === facts.subjectColor ? "subject" : "opponent";
    const tactical = (TACTICAL_FAMILIES as readonly string[]).includes(found.conceptSlug);
    if (tactical && found.event.actor !== expectedActor) {
      at("wrong_colour", `actor ${found.event.actor} but ${transition.actorColor} moved`);
    }
  }

  // Fabricated evidence: a square named in the facts that holds nothing.
  //
  // Which board to check against depends on the fact. Most tactical facts
  // describe the position the move created, so they are checked after it. A
  // couple describe the position it was played from -- `material_exposed.square`
  // is the piece that was hanging, and when the player moved it to safety, which
  // is the success case, that square is legitimately empty afterwards. Checking
  // every key against the after-position reported fifty of those as fabricated
  // evidence, which was a defect in this harness rather than in the detector.
  const SQUARE_FACTS: Record<string, "before" | "after"> = {
    pinner: "after",
    pinned: "after",
    target: "after",
    front: "after",
    rear: "after",
    attacker: "after",
    defender: "after",
    discoveredPiece: "after",
    uncoveredTarget: "after",
    moverTo: "after",
    to: "after",
    squareAfter: "after",
    from: "before",
    square: found.event.eventType === "material_exposed" ? "before" : "after",
  };
  if (after && before) {
    for (const [key, when] of Object.entries(SQUARE_FACTS)) {
      const value = found.event.facts[key];
      if (typeof value !== "number") continue;
      if (value < 0 || value > 63) { at("fabricated_evidence", `${key}=${value} is not a square`); continue; }
      const board = when === "before" ? before : after;
      if (!board.pieceAt(value as never)) {
        at("fabricated_evidence", `${key} names ${value}, which is empty ${when} the move`);
      }
    }
    const line = found.event.facts.verificationLine;
    if (Array.isArray(line) && line.length > 0) {
      const replay = after.position.clone();
      for (const uci of line) {
        const move = typeof uci === "string" ? parseUci(uci) : null;
        if (!move || !replay.isLegal(move)) { at("illegal_line", String(uci)); break; }
        replay.play(move);
      }
    }
  }

  if (!isRecordableOpportunity(found.draft)) at("unrecordable", "the validators would refuse this row");
  if (!difficultyIsUncontaminated(found.draft.difficulty)) at("contaminated_difficulty", "outcome in difficulty");

  return defects;
}

function main(): void {
  const withheld = withheldFrom(process.env);
  const corpus = buildBenchmarkCorpus();
  const results = new Map<string, FamilyResult>();
  const identities = new Set<string>();
  const duplicates: Defect[] = [];
  let games = 0;
  let labels = 0;

  for (const game of corpus) {
    for (const withPvs of [true, false]) {
      const facts = factsFor(game.pgn, withPvs);
      if (!facts) continue;
      games += 1;
      const index = new PositionIndex(facts.positions);
      const runId = `${game.id}:${withPvs ? "pv" : "nopv"}`;
      for (const found of detectGame(facts, { withheld })) {
      labels += 1;
      const result = results.get(found.conceptSlug) ?? {
        emitted: 0, structurallyValid: 0, censored: 0, gamesFired: new Set<string>(), defects: [],
      };
      result.emitted += 1;
      result.gamesFired.add(runId);
      if (!found.draft.responseObserved) result.censored += 1;

      const identity = `${runId}|${found.event.detectionKey}|${found.conceptSlug}|${found.draft.role}`;
      if (identities.has(identity)) {
        duplicates.push({
          game: runId, slug: found.conceptSlug, role: found.draft.role,
          focalPly: found.event.focalPly, kind: "duplicate_event",
          detail: found.event.detectionKey,
        });
      }
      identities.add(identity);

      const defects = adjudicate(runId, facts, index, found);
      if (defects.length === 0) result.structurallyValid += 1;
      else result.defects.push(...defects);
      results.set(found.conceptSlug, result);
      }
    }
  }

  const summary = {
    corpusGames: games,
    labels,
    withheld: [...withheld],
    families: Object.fromEntries([...results].map(([slug, result]) => [slug, {
      emitted: result.emitted,
      structurallyValid: result.structurallyValid,
      structuralPrecision: result.emitted === 0 ? null : result.structurallyValid / result.emitted,
      censored: result.censored,
      coverageGames: result.gamesFired.size,
      defects: result.defects.slice(0, 50),
      defectCount: result.defects.length,
    }])),
    duplicates,
    // Said in the artefact itself, not only in the console, because the
    // artefact is what gets attached to a ticket and read later.
    semanticReviewOutstanding:
      "Structural validity is decided here. Whether a label is worth showing a player is a "
      + "judgement about chess that a person has to make, and it has not been made. No number in "
      + "this file is a reviewed-precision figure.",
  };

  const path = "concepts-shadow.json";
  writeFileSync(path, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  console.log(`concepts:shadow  ${games} corpus games, ${labels} labels`);
  for (const family of ALL_FAMILIES) {
    const result = results.get(family);
    if (!result) {
      console.log(`  ${family.padEnd(22)} not observed in this corpus`);
      continue;
    }
    const precision = result.emitted === 0 ? 0 : result.structurallyValid / result.emitted;
    console.log(
      `  ${family.padEnd(22)} ${String(result.emitted).padStart(5)} labels  `
      + `${(precision * 100).toFixed(1)}% structurally valid  `
      + `${result.gamesFired.size}/${games} games  ${result.censored} censored`
      + (result.defects.length > 0 ? `  ${result.defects.length} DEFECTS` : ""),
    );
  }
  console.log(`written          ${path}`);
  console.log(
    "note             structural validity only. Whether a label is worth showing a player is a "
    + "human judgement and has not been made.",
  );

  const totalDefects = [...results.values()].reduce((sum, result) => sum + result.defects.length, 0);
  assert.equal(duplicates.length, 0, `${duplicates.length} labels shared one physical occurrence and role`);
  assert.equal(
    totalDefects,
    0,
    `${totalDefects} labels are structurally wrong about the board they describe; see ${path}`,
  );

  // A family nobody observed has not passed. It has not been tested at all, and
  // reporting it beside the ones that were is how absent evidence turns into
  // apparent evidence. FOR-138 asks for exactly this to be said out loud.
  const unobserved = ALL_FAMILIES.filter((family) =>
    !withheld.has(family) && (results.get(family)?.emitted ?? 0) === 0);
  if (unobserved.length > 0) {
    console.log("");
    console.log(`concepts:shadow  ${unobserved.length} families produced nothing on this corpus:`);
    for (const family of unobserved) console.log(`  ${family}`);
    console.log(
      "                 They are neither validated nor refuted here. Either the corpus does "
      + "not contain the geometry they look for, or they are stricter than it. Shipping them "
      + "as validated would be a claim this run does not support.",
    );
    // Distinct from a defect exit: nothing is wrong, and nothing is proven.
    process.exit(3);
  }
}

main();
