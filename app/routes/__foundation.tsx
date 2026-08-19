import {
  ClaimBadge,
  CoverageBadge,
  EmptyState,
  Estimate,
  Figure,
  PracticeEmpty,
  ProblemNote,
  RedactionNote,
  VersionNote,
  WorkingStrip,
} from "../components/v1/Honesty";
import { CoveragePanel } from "../components/onboarding/CoveragePanel";
import { JourneyFailure } from "../components/onboarding/JourneyFailure";
import { StageTrail } from "../components/onboarding/StageTrail";
import { WithheldNote } from "../components/onboarding/WithheldNote";
import { ProblemError } from "../lib/v1/problem";
import { FAILURE_REASONS } from "../lib/onboarding/copy";
import { CLAIM_STATES, COVERAGE_STATES } from "../lib/v1/types";
import type { OpeningGraphV1Edge } from "../lib/v1/types";
import { formatEval, formatLoss, unjudgedOn } from "../components/v1/OpeningExplorer";
import { explorerEmptyCopy, type ExplorerEmptyReason } from "../lib/v1/openings";

/**
 * `/dev/foundation` — every honesty primitive, in every state it has.
 *
 * Not a style guide for its own sake. These components exist because the API
 * distinguishes "we do not know", "there is nothing" and "you may not see
 * this", and the only way to keep that distinction alive is to be able to look
 * at all three side by side and check that they still read differently.
 */

export function meta() {
  return [{ title: "Foundation · Forma" }, { name: "robots", content: "noindex" }];
}

function Row({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="grid gap-4">
      <div className="grid gap-1.5">
        <h2 className="text-[1.15rem] font-[620] leading-tight tracking-[-0.02em] text-ink">
          {title}
        </h2>
        {note ? <p className="max-w-[58ch] text-[0.92rem] leading-relaxed text-ink-muted">{note}</p> : null}
      </div>
      <div className="flex flex-wrap items-start gap-x-10 gap-y-6">{children}</div>
    </section>
  );
}

export default function Foundation() {
  const rateLimited = new ProblemError(
    {
      type: "https://docs.formachess.com/problems/rate-limited",
      title: "Too many requests",
      status: 429,
      code: "RATE_LIMITED",
      requestId: "req_8f2c1a",
      retryable: true,
    },
    26,
  );
  const internal = new ProblemError({
    type: "https://docs.formachess.com/problems/internal-error",
    title: "Something went wrong",
    status: 500,
    code: "INTERNAL_ERROR",
    requestId: "req_5d90bb",
  });

  return (
    <main className="relative z-10 mx-auto grid max-w-[860px] gap-12 px-6 py-14">
      <header className="grid gap-2.5">
        <p className="cap">Forma · foundation</p>
        <h1 className="max-w-[20ch] text-[clamp(1.6rem,3.4vw,2.15rem)] font-[650] leading-[1.12] tracking-[-0.028em] text-ink text-balance">
          The pieces every screen shares
        </h1>
        <p className="max-w-[54ch] text-[0.95rem] leading-relaxed text-ink-muted">
          Each renders a distinction the API makes. If two of them ever start looking the
          same, the product has quietly stopped telling the truth.
        </p>
      </header>

      <Row
        title="Coverage"
        note="How much evidence stands behind a claim. Shown beside the claim, not buried in a tooltip."
      >
        {COVERAGE_STATES.map((state) => (
          <CoverageBadge key={state} state={state} showBlurb />
        ))}
      </Row>

      <Row
        title="Estimates"
        note="A number with the interval it came with. A point estimate alone is a stronger claim than the estimator made."
      >
        <Estimate value={0.62} low={0.51} high={0.73} />
        <Estimate value={0.62} />
        <Estimate value={null} />
        <Estimate value={null} unavailableReason="metric_not_estimated" />
      </Row>

      <Row
        title="Claim state"
        note="Only ‘target met’ may be drawn as success, and ‘gone backwards’ is never hidden."
      >
        {CLAIM_STATES.map((state) => (
          <ClaimBadge key={state} state={state} />
        ))}
      </Row>

      <Row
        title="Public figures"
        note="A count small enough to be a person is withheld, and says so — it is not zero and not unknown."
      >
        <p className="text-[0.95rem] text-ink">
          <Figure figure={{ disclosure: "exact", value: 1284 }} /> players
        </p>
        <p className="text-[0.95rem] text-ink">
          <Figure figure={{ disclosure: "suppressed", below: 10 }} /> players
        </p>
      </Row>

      <Row
        title="Provenance"
        note="Which analysis said this, and when. Every claim-bearing screen carries one."
      >
        <VersionNote
          version={{
            publicationId: "b31c…",
            generatedAt: "2026-08-14T09:12:00Z",
            subjectSnapshotId: null,
            recipeVersionId: null,
            policyVersions: {},
          }}
          gameCount={138}
        />
        <VersionNote version={null} />
      </Row>

      <Row
        title="Redactions"
        note="Named by the response. Withheld by plan and not-carried-here are different sentences."
      >
        <div className="max-w-[42ch]">
          <RedactionNote
            redaction={{ path: "data.trajectory", reason: "entitlement" }}
            what="Your trajectory over time"
          />
        </div>
        <div className="max-w-[42ch]">
          <RedactionNote
            redaction={{ path: "data.providerHandles", reason: "projection" }}
            what="Chess accounts"
            where={<a href="/account">your account settings</a>}
          />
        </div>
      </Row>

      <Row
        title="Work in progress"
        note="An unknown total is an indeterminate bar, not a 0% one that looks broken."
      >
        <div className="w-[320px]">
          <WorkingStrip
            label="Importing your games"
            percent={null}
            detail="Reading your Lichess archive."
          />
        </div>
        <div className="w-[320px]">
          <WorkingStrip label="Analysing 138 games" percent={64} />
        </div>
      </Row>

      <Row title="Empty states" note="Three different days, three different screens.">
        <div className="w-full max-w-[460px]">
          <PracticeEmpty reason="nothing_due" />
        </div>
        <div className="w-full max-w-[460px]">
          <PracticeEmpty reason="no_material" />
        </div>
        <div className="w-full max-w-[460px]">
          <EmptyState
            title="No goal yet"
            detail="A goal turns the report into something with a date on it. You can set one whenever you like."
          />
        </div>
      </Row>

      <Row title="The journey" note="Where a run is now. The trail never marks a stage complete: the server derives the stage from evidence and can legitimately move it backwards.">
        <div className="w-full">
          <StageTrail stage="analysing" />
        </div>
      </Row>

      <Row title="Coverage" note="What Forma could read, before anything it concluded. The unavailable shape renders words — null is not zero.">
        <div className="w-full max-w-[460px]">
          <CoveragePanel
            coverage={{
              state: "published",
              overallState: "limited",
              totalGames: 138,
              eligibleGames: 120,
              limitations: ["few_games", "single_speed"],
              dimensions: [
                { dimensionKey: "king_safety", observationCount: 2, state: "limited", limitationReason: "only 2 chances observed" },
                { dimensionKey: "tactics", observationCount: 94, state: "sufficient", limitationReason: null },
              ],
            } as never}
          />
        </div>
        <div className="w-full max-w-[460px]">
          <CoveragePanel
            coverage={{
              state: "unavailable",
              overallState: null,
              totalGames: null,
              eligibleGames: null,
              limitations: [],
              dimensions: [],
            } as never}
          />
        </div>
      </Row>

      <Row title="A journey that stopped" note="Five named reasons, five next steps — plus the sixth branch for a sync that died without the run noticing.">
        {FAILURE_REASONS.slice(0, 3).map((reason) => (
          <div key={reason} className="w-full max-w-[440px]">
            <JourneyFailure reason={reason} />
          </div>
        ))}
        <div className="w-full max-w-[440px]">
          <JourneyFailure reason={null} workflowFailed />
        </div>
      </Row>

      <Row title="Withheld" note="Named and counted, never absent.">
        <div className="max-w-[46ch]">
          <WithheldNote entry={{ section: "constraints", count: 4, entitlementKey: "pro_detail" }} />
        </div>
      </Row>

      <Row title="Failure" note="One vocabulary, and the reference on the one failure we refuse to explain.">
        <div className="w-full max-w-[460px]">
          <ProblemNote error={rateLimited} />
        </div>
        <div className="w-full max-w-[460px]">
          <ProblemNote error={internal} />
        </div>
      </Row>

      <Row
        title="An opening branch"
        note="A move nobody analysed is not a move that went well. The two must never read the same, and neither may rely on colour alone."
      >
        {EXPLORER_BRANCHES.map(({ label, edge }) => (
          <div key={label} className="grid gap-1.5">
            <span className="cap">{label}</span>
            <BranchTags edge={edge} />
          </div>
        ))}
      </Row>

      <Row
        title="An explorer with nothing to walk"
        note="Three different situations produce the same empty graph. Telling someone with four hundred games that they have none, because they clicked Black, is the worst of the three."
      >
        {EXPLORER_EMPTY.map((reason) => {
          const copy = explorerEmptyCopy(reason, 12);
          return (
            <div key={reason} className="w-full max-w-[420px]">
              <EmptyState title={copy.title} detail={copy.detail} />
            </div>
          );
        })}
      </Row>

      <Row
        title="An evaluation, from either side"
        note="The API states White's perspective once. An absent evaluation is a dash, never a zero — a zero is a claim that the position is level."
      >
        {([
          ["White, +1.2", formatEval(120, null, "white")],
          ["Black, same position", formatEval(120, null, "black")],
          ["Mate in three", formatEval(null, 3, "white")],
          ["Not evaluated", formatEval(null, null, "white")],
        ] as const).map(([label, value]) => (
          <div key={label} className="grid gap-1">
            <span className="cap">{label}</span>
            <span className="metric">{value}</span>
          </div>
        ))}
      </Row>
    </main>
  );
}

/** One edge per state a branch can be in. */
function branch(over: Partial<OpeningGraphV1Edge>): OpeningGraphV1Edge {
  return {
    a: 0, b: 1, u: "e2e4", s: "e4", g: 10, sh: 100, ac: "p", op: 10, fa: 0, ...over,
  } as OpeningGraphV1Edge;
}

const EXPLORER_BRANCHES: Array<{ label: string; edge: OpeningGraphV1Edge }> = [
  { label: "Judged, and fine", edge: branch({ g: 10, op: 10, fa: 0 }) },
  { label: "Judged, and costly", edge: branch({ g: 10, op: 10, fa: 3, dl: 0.062 }) },
  { label: "Nobody has looked", edge: branch({ g: 10, op: 0 }) },
  { label: "Partly looked at", edge: branch({ g: 10, op: 4, fa: 1, dl: 0.021 }) },
  { label: "The opponent's move", edge: branch({ ac: "o", g: 10, op: 0 }) },
];

const EXPLORER_EMPTY: ExplorerEmptyReason[] = ["no_games", "filtered_out", "not_materialized"];

/**
 * The tag row of a branch, without the board or the network.
 *
 * The invariant on display: every tag names its state in words as well as in
 * hue, so the meaning survives a monochrome screen.
 */
function BranchTags({ edge: subject }: { edge: OpeningGraphV1Edge }) {
  const unjudged = unjudgedOn(subject);
  const loss = formatLoss(subject.dl);
  if (subject.fa === 0 && unjudged === 0) {
    return <span className="tag tag-sub">nothing outstanding</span>;
  }
  return (
    <span className="flex flex-wrap items-baseline gap-2">
      {subject.fa > 0 ? (
        <span className="tag tag-loss">
          {subject.fa} flagged{loss ? ` · ${loss}` : ""}
        </span>
      ) : null}
      {unjudged > 0 ? <span className="tag tag-unknown">{unjudged} not analysed</span> : null}
    </span>
  );
}
