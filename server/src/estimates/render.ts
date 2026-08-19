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
 */
export function renderTemplate(finding: {
  findingType: string;
  claim: Record<string, unknown>;
}): string {
  const claim = finding.claim;
  const dimension = String(claim.dimension ?? "this area");
  const pct = (value: unknown): string =>
    typeof value === "number" ? `${Math.round(value * 100)}%` : "an unmeasured share";

  switch (finding.findingType) {
    case "strength":
      return `You handle ${dimension} reliably: ${pct(claim.estimate)} of your chances, with the plausible range from ${pct(claim.intervalLow)} to ${pct(claim.intervalHigh)}.`;
    case "foundational_miss":
      return `${dimension} is costing you: ${pct(claim.estimate)} of your chances, with the plausible range from ${pct(claim.intervalLow)} to ${pct(claim.intervalHigh)}.`;
    case "development_frontier":
      return `${dimension} is where your play is least settled. The evidence puts you between ${pct(claim.intervalLow)} and ${pct(claim.intervalHigh)}, which is too wide to call either way yet.`;
    case "repeated_pattern":
      return `The same problem in ${dimension} came up repeatedly across your games.`;
    case "early_improvement_signal":
      return `There is an early signal in ${dimension}. It is not yet enough evidence to call it settled.`;
    case "established_improvement":
      return `Your ${dimension} has changed for real, and the evidence behind it is strong enough to say so.`;
    case "insufficient_evidence":
      return `There is not enough evidence about ${dimension} yet. Play more games where it comes up and this will fill in.`;
    default:
      return `A finding about ${dimension}.`;
  }
}
