import { GOAL_POLICY, type GoalPolicy, type RequirementKind, type RequirementUnit } from "./contract.js";

/**
 * Generating a plan: what to actually do about a goal.
 *
 * Ranked from published evidence, never from a template of good habits. There
 * is no universal "four games per day" rule — a plan is derived from the
 * specific gaps a specific person's report found, and a requirement that cannot
 * say which gap it addresses is a chore rather than coaching.
 *
 * The cap matters as much as the ranking. A plan with fourteen requirements is
 * a plan nobody follows, and a coaching product whose advice is ignored has
 * done worse than one that said less.
 */

export interface EvidenceGap {
  /** The dimension the report is weakest or least certain about. */
  dimensionKey: string;
  displayName: string;
  /** How far from the target, 0 to 1. Higher is more urgent. */
  shortfall: number;
  /** How uncertain the estimate is. Wide means "play more", not "study more". */
  intervalWidth: number;
  /** Observations behind it. Thin evidence changes what the plan can ask for. */
  observationCount: number;
  /** True when the gap is on an essential metric of the cycle. */
  essential: boolean;
}

export interface Requirement {
  requirementKey: string;
  kind: RequirementKind;
  quantity: number;
  unit: RequirementUnit;
  windowDays: number;
  essential: boolean;
  rationale: string;
  displayRank: number;
  cohortFilter: Record<string, unknown>;
}

/**
 * Turn gaps into requirements.
 *
 * The choice of *kind* is the interesting part, and it is driven by why the gap
 * exists rather than by what a coach would usually say:
 *
 * - a wide interval on few observations means Forma does not know yet, so the
 *   requirement is to play, not to practise something we cannot confirm needs
 *   practising;
 * - a narrow interval well short of target means the weakness is established,
 *   so targeted practice is warranted;
 * - a narrow interval close to target means the work is reviewing, so the
 *   player sees the decisions they are already nearly getting right.
 *
 * Prescribing drills for a gap we have not actually measured is the most common
 * way a coaching product wastes somebody's time.
 */
export function generatePlan(
  gaps: readonly EvidenceGap[],
  policy: GoalPolicy = GOAL_POLICY,
): Requirement[] {
  const ranked = [...gaps].sort(
    (a, b) =>
      Number(b.essential) - Number(a.essential) ||
      b.shortfall - a.shortfall ||
      a.dimensionKey.localeCompare(b.dimensionKey),
  );

  const requirements: Requirement[] = [];
  for (const gap of ranked.slice(0, policy.maxRequirements)) {
    const uncertain = gap.intervalWidth >= 0.35 || gap.observationCount < 12;
    const kind: RequirementKind = uncertain
      ? "play_games"
      : gap.shortfall >= 0.4
        ? "targeted_practice"
        : "review_games";

    requirements.push({
      requirementKey: `${kind}_${gap.dimensionKey}`.slice(0, 63),
      kind,
      quantity: quantityFor(kind, gap),
      unit: unitFor(kind),
      windowDays: 7,
      essential: gap.essential,
      rationale: rationaleFor(kind, gap),
      displayRank: requirements.length,
      cohortFilter: { dimension: gap.dimensionKey },
    });
  }

  return requirements;
}

function unitFor(kind: RequirementKind): RequirementUnit {
  switch (kind) {
    case "play_games":
      return "games";
    case "review_games":
      return "reviews";
    case "targeted_practice":
      return "sessions";
    case "study_material":
      return "minutes";
    case "rest":
      return "days";
  }
}

/**
 * How much to ask for.
 *
 * Scaled by how much is missing, and deliberately modest at the top end. A plan
 * asking for twelve games a week from somebody who plays three is a plan that
 * fails in week one and takes the user's confidence with it.
 */
function quantityFor(kind: RequirementKind, gap: EvidenceGap): number {
  if (kind === "play_games") return gap.observationCount < 12 ? 5 : 3;
  if (kind === "targeted_practice") return gap.shortfall >= 0.7 ? 3 : 2;
  return 2;
}

function rationaleFor(kind: RequirementKind, gap: EvidenceGap): string {
  const area = gap.displayName;
  switch (kind) {
    case "play_games":
      return `We have seen ${gap.observationCount} chances at ${area}, which is not enough to be sure where you stand. More games is the fastest way to find out.`;
    case "targeted_practice":
      return `${area} is the clearest gap between where you are and your target, and the evidence behind that is settled enough to work on directly.`;
    case "review_games":
      return `You are close to your target on ${area}. Reviewing your own decisions there is what turns nearly-right into reliable.`;
    default:
      return `This addresses ${area}, which your report identified as a gap between where you are and your target.`;
  }
}

/**
 * How much of the plan the user actually did.
 *
 * Counted against the requirements they *accepted*, not against everything that
 * was prescribed. Somebody who declined two of six requirements and did all
 * four of the rest has full adherence, because adherence is a measure of
 * keeping your word rather than of obedience.
 */
export function measureAdherence(input: {
  requirements: readonly Requirement[];
  acceptedKeys: readonly string[];
  observed: Readonly<Record<string, number>>;
}): { met: number; total: number } {
  const accepted = new Set(input.acceptedKeys);
  const relevant = input.requirements.filter((requirement) =>
    accepted.has(requirement.requirementKey),
  );
  const met = relevant.filter(
    (requirement) => (input.observed[requirement.requirementKey] ?? 0) >= requirement.quantity,
  ).length;
  return { met, total: relevant.length };
}
