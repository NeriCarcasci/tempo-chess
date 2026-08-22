/**
 * The renderer boundary.
 *
 * Database architecture 19.7 states the rule: the renderer cannot create engine
 * scores, concept observations, confidence, or improvement claims absent from
 * its structured input. A rule that only exists in a prompt is a rule the model
 * breaks quietly, so this module makes it checkable — the rendered text is
 * scanned for the two things prose can smuggle in, numbers and claim verbs, and
 * anything the structured input does not support holds the text back.
 *
 * The check is deliberately conservative in one direction only. It can hold
 * back a sentence that was actually fine; it cannot pass one that invented a
 * statistic. Given the choice, a coaching product should be mute rather than
 * confidently wrong about a person.
 */

export type SafetyState = "passed" | "held" | "rejected";

export interface RenderCheck {
  state: SafetyState;
  /** Present whenever the state is not `passed`. */
  note: string | null;
  /** The specific tokens that were not supported, for an operator. */
  unsupported: readonly string[];
}

/**
 * Verbs that assert a change over time.
 *
 * Prose is allowed to describe what a finding says. It is not allowed to
 * introduce an improvement claim, because platform spec 3.4 requires one to be
 * earned by a comparable later real-game opportunity and a renderer has no
 * access to that evidence.
 */
const IMPROVEMENT_LANGUAGE =
  /\b(improv\w*|better than before|progress\w*|got stronger|getting stronger|regress\w*|declin\w*|worse than before)\b/i;

/** Anything that reads as a measurement: 12, 0.42, 47%, 1.5x. */
const NUMERIC_TOKEN = /-?\d+(?:\.\d+)?%?/g;

/**
 * Numbers a sentence may contain without the structured input naming them.
 *
 * Small integers appear in ordinary English ("one of your games", "the first
 * move") and holding those back would make the renderer useless without making
 * it safer. Anything above ten, anything fractional and any percentage has to
 * be supported.
 */
function isFreeNumber(token: string): boolean {
  if (token.includes("%") || token.includes(".")) return false;
  const value = Number(token);
  return Number.isInteger(value) && value >= 0 && value <= 10;
}

/**
 * Every number the structured input supports, in the spellings prose uses.
 *
 * A stored 0.4235 may legitimately be written as 0.42, 42% or 0.4, so each
 * numeric value expands into the roundings a writer would reach for. Rounding
 * is the one transformation prose is allowed to apply, because it changes
 * precision rather than fact.
 */
export function supportedNumbers(input: unknown): Set<string> {
  const supported = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === "number" && Number.isFinite(value)) {
      addSpellings(supported, value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const item of Object.values(value as Record<string, unknown>)) walk(item);
    }
  };
  walk(input);
  return supported;
}

function addSpellings(into: Set<string>, value: number): void {
  into.add(String(value));
  into.add(String(Math.round(value)));
  for (const digits of [0, 1, 2, 3]) into.add(value.toFixed(digits));
  if (value >= 0 && value <= 1) {
    const percent = value * 100;
    for (const digits of [0, 1]) {
      into.add(`${percent.toFixed(digits)}%`);
      into.add(percent.toFixed(digits));
    }
    into.add(`${Math.round(percent)}%`);
  }
}

/**
 * Check one rendered explanation against the facts it was given.
 *
 * `held` rather than `rejected` for an unsupported number: the text is kept so
 * an operator can see what the renderer tried to say, and it is not shown.
 * `rejected` is reserved for improvement language, which is not a precision
 * problem but a claim the renderer had no standing to make.
 */
export function checkRendering(
  text: string,
  structuredInput: unknown,
  options: { improvementClaimAllowed?: boolean } = {},
): RenderCheck {
  if (text.trim().length === 0) {
    return { state: "rejected", note: "the renderer produced nothing", unsupported: [] };
  }

  if (options.improvementClaimAllowed !== true && IMPROVEMENT_LANGUAGE.test(text)) {
    const match = IMPROVEMENT_LANGUAGE.exec(text);
    return {
      state: "rejected",
      note: "the text asserts a change over time that the finding does not claim",
      unsupported: match ? [match[0]] : [],
    };
  }

  const supported = supportedNumbers(structuredInput);
  const unsupported = [...(text.match(NUMERIC_TOKEN) ?? [])].filter(
    (token) => !isFreeNumber(token) && !supported.has(token),
  );

  if (unsupported.length > 0) {
    return {
      state: "held",
      note: `the text contains ${unsupported.length} number(s) the finding does not support`,
      unsupported: [...new Set(unsupported)],
    };
  }

  return { state: "passed", note: null, unsupported: [] };
}

/**
 * A deterministic explanation for a finding, with no model involved.
 *
 * v1 renders from templates. That is not a placeholder for a language model: it
 * is the baseline a language model has to beat while staying inside the same
 * check, and it means the product ships readable findings without a provider
 * call in the publication path.
 *
 * ## What was wrong with the first version of this function
 *
 * It interpolated `claim.dimension`, which is a database column name, into
 * sentences that otherwise only restated the estimate. A live report told a
 * customer that "critical_moment_recognize_objective is costing you: 22% of
 * your chances". Every word of that is either an identifier or a number, and
 * nothing in it tells anybody what to do on Tuesday evening.
 *
 * The repair is not a better adjective. It is that `findings.ts` now computes
 * the things a useful sentence needs — the concept in the catalogue's own
 * words, the sample the rate came from, a location when the evidence supports
 * one, one real moment to look at — and this function assembles them. Nothing
 * here decides anything: if the claim has no location, no location is
 * mentioned, and the reason is that the evidence did not support one rather
 * than that the template ran out of room.
 *
 * ## The shape every explanation takes
 *
 * Verdict, then evidence, then what was excluded from it, then where it
 * happens, then one moment. Sentences are dropped from the middle when the
 * claim does not carry them; the order never changes, so two findings are
 * comparable by reading the same position in each.
 */
export function renderTemplate(finding: {
  findingType: string;
  claim: Record<string, unknown>;
}): string {
  const claim = finding.claim;
  const concept = asRecord(claim.concept);
  const label = asString(concept.label) ?? "this part of your game";
  const named = midSentence(label);
  const opportunity = asString(concept.opportunity);
  const succeeded = asString(concept.succeeded);
  const missed = asString(concept.missed);

  const observed = asNumber(claim.observed);
  const successes = asNumber(claim.successes);
  const graded = asNumber(claim.graded) ?? 0;
  const censored = asNumber(claim.censored) ?? 0;

  const sentences: string[] = [];
  const say = (sentence: string | null): void => {
    if (sentence !== null) sentences.push(sentence);
  };

  switch (finding.findingType) {
    case "strength":
      say(`You are reliably good at ${named}.`);
      say(rate(claim, { observed, successes, graded, opportunity, succeeded }));
      say(censoredNote(censored));
      say(locationNote(claim, "It is strongest in", "strongest"));
      say(exampleNote(claim, "played"));
      break;

    case "foundational_miss":
      say(`You are losing ground on ${named}.`);
      say(rate(claim, { observed, successes, graded, opportunity, succeeded }));
      say(censoredNote(censored));
      say(locationNote(claim, "The misses bunch in", "misses"));
      say(exampleNote(claim, "missed"));
      break;

    case "development_frontier": {
      say(`Your play is least settled on ${named}.`);
      const low = pct(claim.intervalLow);
      const high = pct(claim.intervalHigh);
      say(
        observed === null
          ? `The evidence puts you between ${low} and ${high}, which is too wide to call either way.`
          : `${observed} chances is not enough to tell a real rate of ${low} from one of ${high}, so Forma is not calling this either way yet.`,
      );
      say(censoredNote(censored));
      say(locationNote(claim, "What has gone wrong so far bunches in", "misses"));
      say(exampleNote(claim, "missed"));
      break;
    }

    case "repeated_pattern": {
      const occurrences = asNumber(claim.occurrences);
      say(
        occurrences !== null && opportunity !== null && missed !== null
          ? `The same thing keeps happening with ${named}: ${occurrences} times across your games you had a chance to ${opportunity} and ${missed}.`
          : `The same thing kept happening with ${named} across your games.`,
      );
      say(censoredNote(censored));
      say(locationNote(claim, "They bunch in", "misses"));
      say(exampleNote(claim, "missed"));
      break;
    }

    case "early_improvement_signal":
      say(
        `There is an early sign of movement on ${named}: your recent games run ${points(claim.delta)} above your earlier ones, and Forma puts the chance that is real at ${confidence(claim.improvementProbability, claim.probabilityFloor)}.`,
      );
      say(
        observed === null
          ? `That is a signal and not a verdict yet.`
          : `That is a signal and not a verdict — it rests on ${observed} recent chances.`,
      );
      break;

    case "established_improvement":
      say(
        `On ${named}, something has genuinely changed: your recent games run ${points(claim.delta)} above your earlier ones, and the evidence puts the chance that is real at ${confidence(claim.improvementProbability, claim.probabilityFloor)}.`,
      );
      say(
        observed === null
          ? `That is enough to say out loud.`
          : `It rests on ${observed} recent chances, which is enough to say out loud.`,
      );
      break;

    case "inconsistency":
      return phaseContrast(claim);

    case "insufficient_evidence":
      return gap(claim, named, opportunity);

    default:
      say(`Forma recorded a finding about ${named}.`);
  }

  return sentences.join(" ");
}

/**
 * The rate, always with the sample and the interval it came from.
 *
 * There is no branch of this function that prints a bare percentage. A rate
 * without its evidence is the thing platform spec 3.3 exists to stop, and the
 * cheapest way to guarantee it is to have no code path that can produce one.
 */
function rate(
  claim: Record<string, unknown>,
  parts: {
    observed: number | null;
    successes: number | null;
    graded: number | null;
    opportunity: string | null;
    succeeded: string | null;
  },
): string {
  const range = `the evidence puts the real rate between ${pct(claim.intervalLow)} and ${pct(claim.intervalHigh)}`;
  const { observed, successes, graded, opportunity, succeeded } = parts;
  // A graded rubric splits an observation across both sides, so "you did it 12
  // times" would be a count nothing in the data supports. The rate and the
  // interval still hold, and saying less is the only honest option.
  const countable = (graded ?? 0) === 0 && observed !== null && successes !== null;
  if (countable && opportunity !== null && succeeded !== null) {
    // The count and the rate are deliberately in separate sentences with the
    // weighting named between them. `estimator_v1` discounts old evidence on a
    // 120-day half-life and starts from a Jeffreys prior, so the rate is not
    // `successes / observed` and a reader who divides the two numbers will get
    // a different answer. Printing them either side of a dash implied they were
    // the same arithmetic, and being caught out by a reader's own division is
    // exactly the kind of small wrongness that costs a report its credibility.
    return `Over ${observed} chances to ${opportunity}, you ${succeeded} ${successes} times. Weighted towards your recent games that comes to ${pct(claim.estimate)}, and ${range}.`;
  }
  if (observed !== null) {
    return `Across ${observed} recorded chances your rate is ${pct(claim.estimate)}, and ${range}.`;
  }
  return `Your rate is ${pct(claim.estimate)}, and ${range}.`;
}

/**
 * What was left out of the rate, and why it was left out.
 *
 * §17.5 excludes a chance the player never got a move at. The exclusion is
 * correct and invisible, which is the problem: a reader who is told "you saved
 * it 12 times out of 30" and separately sees they played 39 of these will
 * conclude the report lost nine. Naming them keeps the rule legible instead of
 * merely applied.
 */
function censoredNote(censored: number): string | null {
  if (censored <= 0) return null;
  if (censored === 1) {
    return "One further chance ended before you had a move, and it counts neither way.";
  }
  return `${censored} further chances ended before you had a move, and they count neither way.`;
}

function locationNote(
  claim: Record<string, unknown>,
  lead: string,
  noun: "misses" | "strongest",
): string | null {
  const where = asRecordOrNull(claim.where);
  if (where !== null) {
    const label = asString(where.label);
    const count = asNumber(where.count);
    const total = asNumber(where.total);
    if (label === null) return null;
    if (count === null || total === null) return `${lead} ${label}.`;
    return `${lead} ${label}: ${count} of ${total}.`;
  }
  // Only claimable when the subject was large enough for the test to have been
  // run. "They are spread out" is itself a finding, and a report that said it
  // from five observations would be asserting a negative it never checked.
  if (claim.whereExamined !== true) return null;
  return noun === "misses"
    ? "They are spread across your games rather than bunched in one phase, opening or stretch of the game."
    : "It holds up across phases, openings and stages of the game rather than being narrow to one.";
}

/**
 * One real position, named by move number.
 *
 * Deliberately not a date: a date is a number the structured input would have
 * to carry as a number for the safety check to accept it, and "14 August" is a
 * worse handle for a chess player than "move 23" anyway. The game identifier
 * travels in the claim so a screen can link to the board.
 */
function exampleNote(claim: Record<string, unknown>, kind: "played" | "missed"): string | null {
  const example = asRecordOrNull(claim.example);
  if (example === null) return null;
  const moveNumber = asNumber(example.moveNumber);
  if (moveNumber === null) return null;
  const played = asUci(example.playedMoveUci);
  const best = asUci(example.bestMoveUci);

  let sentence: string;
  if (kind === "missed" && played !== null && best !== null && played !== best) {
    sentence = `The most recent was move ${moveNumber}, where you played ${played} and ${best} was the move.`;
  } else if (played !== null) {
    sentence = `The most recent was move ${moveNumber}, where you played ${played}.`;
  } else {
    sentence = `The most recent was at move ${moveNumber}.`;
  }

  const departure = asNumber(example.departureMoveNumber);
  if (departure !== null) {
    sentence +=
      departure <= moveNumber
        ? ` In that game your line left the opening book at move ${departure}.`
        : ` That was still inside your opening book, which the game left at move ${departure}.`;
  }
  return sentence;
}

/**
 * One phase of the game against another.
 *
 * Both sides in full, in one sentence, because the finding *is* the
 * comparison: a reader given "your opening is 45%" has been told a number, and
 * a reader given "45% in the opening against 67% in the endgame" has been told
 * where to spend Tuesday.
 *
 * The last sentence is not a disclaimer. Mixing concepts across phases is the
 * obvious way to get this wrong — the endgame contains chances the opening
 * never offers — and a reader who cannot tell whether we avoided that has to
 * take the whole claim on trust.
 */
function phaseContrast(claim: Record<string, unknown>): string {
  const weakest = asRecordOrNull(claim.weakest);
  const strongest = asRecordOrNull(claim.strongest);
  if (weakest === null || strongest === null) {
    return "Your play is not the same in every phase of the game.";
  }
  const weakLabel = asString(weakest.label) ?? "one phase";
  const strongLabel = asString(strongest.label) ?? "another";
  const sentences = [
    "You are not the same player in every phase of the game.",
    `On the kinds of chance that come up in both, you take ${pct(weakest.estimate)} of them in ${weakLabel} and ${pct(strongest.estimate)} in ${strongLabel}${counts(weakest, strongest)}.`,
    `Forma puts the chance that gap is real at ${confidence(claim.probability, claim.probabilityFloor)}, and the two sides are ${pct(weakest.intervalLow)} to ${pct(weakest.intervalHigh)} against ${pct(strongest.intervalLow)} to ${pct(strongest.intervalHigh)}.`,
  ];

  const shared = Array.isArray(claim.sharedConcepts)
    ? (claim.sharedConcepts as unknown[]).filter((item): item is string => typeof item === "string")
    : [];
  if (shared.length > 0) {
    sentences.push(
      `Only chances of the same kind were compared — ${list(shared.map(midSentence))} — so this is not one phase simply offering easier ones.`,
    );
  }
  return sentences.join(" ");
}

function counts(weakest: Record<string, unknown>, strongest: Record<string, unknown>): string {
  const weakTaken = asNumber(weakest.successes);
  const weakOf = asNumber(weakest.observed);
  const strongTaken = asNumber(strongest.successes);
  const strongOf = asNumber(strongest.observed);
  if (weakTaken === null || weakOf === null || strongTaken === null || strongOf === null) return "";
  // Plain integers, never grouped. A thousands separator splits into two
  // numeric tokens, and the safety check would hold the whole sentence back
  // over a comma.
  return ` — ${weakTaken} of ${weakOf} against ${strongTaken} of ${strongOf}`;
}

function list(items: readonly string[]): string {
  if (items.length === 1) return items[0]!;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]!}`;
}

/** The refusals. Each names what is missing rather than reporting a zero. */
function gap(
  claim: Record<string, unknown>,
  label: string,
  opportunity: string | null,
): string {
  const chance = opportunity === null ? `a chance at this` : `a chance to ${opportunity}`;
  const chances = opportunity === null ? `chances at this` : `chances to ${opportunity}`;
  const rawSample = asNumber(claim.rawSample) ?? 0;
  const censored = asNumber(claim.censored) ?? 0;

  switch (asString(claim.reason)) {
    case "no_observations":
      return `Forma has nothing to say about ${label} yet: ${chance} never came up in the games it has read. Play games where it does and this will fill in.`;
    case "all_evidence_censored":
      return `${rawSample === 1 ? "One chance" : `${rawSample} chances`} to ${opportunity ?? "do this"} came up, and every one ended before you had a move to make. A chance you were never given is not a chance you missed, so there is nothing here to measure.`;
    case "below_minimum_sample":
      return censored > 0
        ? `${rawSample} ${chances} have come up so far, ${censored} of which ended before you had a move. That is too little to put a number on.`
        : `${rawSample} ${chances} have come up so far, which is too little to put a number on.`;
    case "outside_calibrated_range":
      return `Forma will not compare you to a peer group on ${label}. Your rating sits outside the band that comparison was calibrated on, and a number from outside it would be precision Forma has not earned.`;
    default:
      return `Forma could not estimate ${label} on this run, so it is not reporting one.`;
  }
}

function pct(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${Math.round(value * 100)}%`
    : "an unmeasured share";
}

/**
 * A probability, without letting it round up to certainty.
 *
 * A posterior of 0.9997 renders as "100%" under plain rounding, and telling
 * somebody a claim about them is 100% certain is not something this product
 * gets to say from any amount of evidence. Above the floor the sentence says
 * "over 99%", and the floor itself travels in the claim so the number in the
 * text is one the structured input supports rather than one the template
 * invented.
 */
function confidence(value: unknown, floor: unknown): string {
  const probability = asNumber(value);
  const bound = asNumber(floor);
  if (probability === null) return "an unmeasured chance";
  if (bound !== null && probability > bound) return `over ${pct(bound)}`;
  return pct(probability);
}

/**
 * A display name, ready to sit inside a sentence.
 *
 * The catalogue writes names as headings — "Positions that decide the game" —
 * and a template that puts one in front of a verb has to guess whether it is
 * singular. Every headline sentence therefore puts the name after a
 * preposition, and this lowercases the leading capital so the result reads as
 * English. Only the first character, and only when the second is already
 * lowercase, so a name that opens with an initialism keeps it.
 */
function midSentence(label: string): string {
  if (label.length < 2) return label;
  const second = label[1]!;
  if (second !== second.toLowerCase()) return label;
  return label[0]!.toLowerCase() + label.slice(1);
}

/** A delta, in percentage points. Never a bare number: the unit is the claim. */
function points(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "an unmeasured amount";
  const rounded = Math.round(value * 100);
  return rounded === 1 ? "1 percentage point" : `${rounded} percentage points`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asRecordOrNull(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * A move, only if it is really a move.
 *
 * Every square name is a letter and a digit from 1 to 8, which `isFreeNumber`
 * already treats as ordinary English, so a well-formed UCI move can never be
 * the thing that holds an explanation back. Anything that is not one is
 * dropped rather than printed, because a malformed move in the evidence would
 * otherwise arrive in the reader's sentence as a malformed move.
 */
function asUci(value: unknown): string | null {
  return typeof value === "string" && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(value) ? value : null;
}
