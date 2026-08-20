import { useEffect } from "react";
import { Link, redirect, useLoaderData, useNavigate } from "react-router";
import type { Route } from "./+types/onboarding";
import { OnboardingShell } from "../components/onboarding/OnboardingShell";
import { StageTrail } from "../components/onboarding/StageTrail";
import { JourneyFailure } from "../components/onboarding/JourneyFailure";
import { EmptyState, ProblemNote, WorkingStrip } from "../components/v1/Honesty";
import { RouteError } from "../components/RouteError";
import { getMe, getOnboarding, getWorkflow, startRun } from "../lib/onboarding/api";
import { nextScreen, shouldPoll } from "../lib/onboarding/nextScreen";
import { waitLabel, workflowStageLabel, type FailureReason } from "../lib/onboarding/copy";
import { newIdempotencyKey } from "../lib/v1/client";
import { usePoll } from "../lib/v1/usePoll";
import { requireUser } from "../lib/session";
import type { OnboardingState, Workflow } from "../lib/v1/types";

/**
 * While Forma reads your games.
 *
 * The screen is driven entirely by `nextAction` and the sync workflow, and it
 * holds one rule above all others: **a wait is never silent and never
 * unbounded**. When the workflow dies the run does not notice — its status
 * stays `active` and its next action stays `wait` — so this screen watches the
 * workflow as well, and stops.
 */

const POLL_MS = 4000;

export function meta() {
  return [{ title: "Reading your games · Forma" }];
}

interface LoaderData {
  state: OnboardingState;
  workflow: Workflow | null;
}

export async function clientLoader(): Promise<LoaderData> {
  // `requireUser`, not `requireSession`: this screen *is* onboarding, and
  // `requireSession` bounces anyone without a legacy linked account to
  // /welcome — which bounces straight back here as soon as a run exists.
  await requireUser();
  let state = await getOnboarding();

  // Nobody arrives here without a run on the happy path, but somebody who
  // refreshed at the wrong moment, or linked on another device, will. Run
  // creation lives here and on /welcome, and nowhere else.
  if (state.stage === "not_started") {
    const me = await getMe();
    // The planner needs an *active* account with an open membership. Counting a
    // disconnected one sends the person into a run that fails immediately.
    if (!me.accounts.some((account) => account.status === "active")) {
      throw redirect("/welcome");
    }
    state = await startRun({ idempotencyKey: newIdempotencyKey() });
  }

  const destination = nextScreen({ state });
  if (destination.kind === "report") throw redirect("/report");

  const workflow = state.syncWorkflowId ? await getWorkflow(state.syncWorkflowId) : null;
  return { state, workflow };
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return <RouteError title="Could not open this page" error={error} />;
}

export default function Onboarding() {
  const initial = useLoaderData<LoaderData>();

  const { value, error } = usePoll<LoaderData>(
    async () => {
      const state = await getOnboarding();
      const workflow = state.syncWorkflowId ? await getWorkflow(state.syncWorkflowId) : null;
      return { state, workflow };
    },
    {
      initial,
      intervalMs: POLL_MS,
      enabled: (data) => shouldPoll({ state: data.state, workflow: data.workflow }),
    },
  );

  const { state, workflow } = value;
  const destination = nextScreen({ state, workflow });
  const navigate = useNavigate();

  // The report can become ready *between* polls, not only before the page
  // loaded. Handling it in the loader alone left this screen rendering nothing
  // at the exact moment the journey succeeded — the poll had stopped, no branch
  // matched, and the page emptied itself.
  useEffect(() => {
    if (destination.kind === "report") void navigate("/report", { replace: true });
  }, [destination.kind, navigate]);

  return (
    <OnboardingShell
      title="Reading your games"
      sub="This takes a few minutes. You can close the tab — it carries on without you."
    >
      <StageTrail stage={state.stage} />

      {/* Polite and atomic: the label and the stage change together every few
          seconds, and announcing them piecemeal would interrupt somebody
          mid-sentence with half a status. */}
      <div className="onboarding-body" aria-live="polite" aria-atomic="true">
        {error ? <ProblemNote error={error} /> : null}

        {destination.kind === "wait" ? (
          <WorkingStrip
            label={waitLabel(destination.reason)}
            percent={workflow?.progress.percent ?? null}
            detail={workflowStageLabel(workflow?.progress.stage ?? null) ?? undefined}
          />
        ) : null}

        {destination.kind === "stuck" ? (
          <JourneyFailure
            reason={destination.reason as FailureReason | null}
            workflowFailed={destination.workflowFailed}
            retry={
              destination.reason === "no_linked_account" ? (
                <Link to="/welcome" className="primary-button">
                  Connect an account
                </Link>
              ) : (
                <Link to="/welcome" className="chip-btn">
                  Start again
                </Link>
              )
            }
          />
        ) : null}

        {destination.kind === "diagnostic" ? (
          <EmptyState
            title="The optional examination is not built yet"
            detail="Your report does not need it — it is built from your real games either way."
            action={
              destination.reportId ? (
                <Link to="/report" className="primary-button">
                  See your baseline report
                </Link>
              ) : undefined
            }
          />
        ) : null}

        {destination.kind === "welcome" ? (
          <EmptyState
            title="There is no chess account connected"
            detail="Forma reads the games you have already played, so it needs an account to read them from."
            action={
              <Link to="/welcome" className="primary-button">
                Connect an account
              </Link>
            }
          />
        ) : null}

        {destination.kind === "report" ? (
          <EmptyState
            title="Your report is ready"
            detail="Taking you to it now."
            action={
              <Link to="/report" className="primary-button">
                Read your report
              </Link>
            }
          />
        ) : null}

        {destination.kind === "done" ? (
          <EmptyState
            title="Your report is ready"
            detail="Goal setting is not built yet, so this is as far as the journey goes for now."
            action={
              <Link to="/report" className="primary-button">
                Read your report
              </Link>
            }
          />
        ) : null}
      </div>
    </OnboardingShell>
  );
}
