import { useEffect, useRef, useState } from "react";
import { Form, Link, redirect, useActionData, useNavigation } from "react-router";
import type { Route } from "./+types/welcome";
import { OnboardingShell } from "../components/onboarding/OnboardingShell";
import { ProviderChoice, type Provider } from "../components/onboarding/ProviderChoice";
import { RouteError } from "../components/RouteError";
import { getOnboarding, linkAndStart } from "../lib/onboarding/api";
import { nextScreen } from "../lib/onboarding/nextScreen";
import { ProblemError } from "../lib/v1/problem";
import { apiFetch } from "../lib/api";
import { invalidateSession, requireUser, setActiveAccount } from "../lib/session";
import { invalidateCache } from "../lib/loaderCache";
import { LichessMark, ChessComMark } from "../components/PlatformMarks";

/**
 * Connect a chess account, and start the examination.
 *
 * Two steps rather than one submit. Looking the name up first and showing what
 * came back is what stops a typo becoming a linked account, an import that
 * fails where nobody can see it, and a product full of zeroes with no
 * explanation.
 *
 * The lookup is the one legacy call this screen keeps: `/v1` has no
 * equivalent — there is no public provider-profile route on the versioned
 * surface — and dropping it would drop the "is this you?" confirmation.
 *
 * ## The double write, and when it goes
 *
 * Confirming links the account **twice**, on purpose and temporarily. `/v1`
 * writes `app.linked_accounts` and the canonical chess tables; the session and
 * every product screen that has not been ported yet read the legacy
 * `public.linked_accounts` and `public.games`. Linking on one surface only
 * would leave the person bounced out of every product route by
 * `requireSession()` with nothing on screen to explain it.
 *
 * Delete the legacy half — steps 1 to 3 below — when the last legacy consumer
 * is ported. Nothing else here changes when that happens.
 */

export function meta() {
  return [{ title: "Connect your chess account · Forma" }];
}

interface Candidate {
  platform: Provider;
  username: string;
  url: string;
  games: number | null;
  rating: number | null;
  closed: boolean;
}

type ActionResult =
  | { kind: "not-found"; platform: Provider; username: string }
  | { kind: "candidate"; candidate: Candidate }
  | { kind: "error"; message: string; code?: string };

export async function clientLoader() {
  await requireUser();
  const state = await getOnboarding();

  // A run that is *live* belongs on the progress screen. Three things must all
  // hold before redirecting, and each was a trap:
  //
  //   * `not_started` always reports `link_account` even for somebody who has
  //     already linked, so it proves nothing on its own;
  //   * a failed or abandoned run must fall through — reconnecting is the only
  //     way out of one, and bouncing it back to /onboarding leaves the person
  //     circling between a dead end and the screen that would fix it;
  //   * a run whose next step is `link_account` obviously stays here.
  const destination = nextScreen({ state });
  const live = state.status === "active" || state.status === "activated";
  if (state.stage !== "not_started" && live && destination.kind !== "welcome") {
    throw redirect("/onboarding");
  }
  return null;
}

export async function clientAction({ request }: Route.ClientActionArgs): Promise<ActionResult> {
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "lookup");
  const platform = (String(form.get("platform") ?? "lichess") === "chesscom"
    ? "chesscom"
    : "lichess") as Provider;
  const username = String(form.get("username") ?? "").trim();

  if (!username) return { kind: "error", message: "Enter the name you play under." };

  if (intent === "lookup") {
    const response = await apiFetch(
      `/platform-accounts/${platform}/${encodeURIComponent(username)}`,
    );
    if (response.status === 404) return { kind: "not-found", platform, username };
    if (!response.ok) {
      return {
        kind: "error",
        message: "That chess site did not answer. It is usually brief — try again in a moment.",
      };
    }
    const candidate = (await response.json()) as Candidate;
    return { kind: "candidate", candidate };
  }

  // --- confirm ------------------------------------------------------------
  try {
    // 1-3: the legacy surface, so the session and the unported screens work.
    const legacy = await apiFetch("/me/accounts", {
      json: { username, platform },
    });
    if (legacy.ok || legacy.status === 409) {
      const body = (await legacy.json().catch(() => null)) as { id?: string; userId?: string } | null;
      if (body?.id && body.userId) setActiveAccount(body.userId, body.id);
      invalidateSession();
      invalidateCache();
      await apiFetch("/imports/lichess", {
        // `platform` is not optional: without it the importer assumed Lichess
        // for everybody, which imported nothing for a Chess.com player.
        json: { username, platform, games: "all" },
      }).catch(() => null);
    }

    // 4-5: the versioned surface, which is what the examination reads.
    const state = await linkAndStart({ provider: platform, handle: username });

    // A 2xx does not mean it started: with no active linked account the planner
    // fails the run inside the same request.
    if (state.status === "failed") {
      return {
        kind: "error",
        message:
          "That account linked, but there was nothing to read from it. Check the name and try again.",
        code: state.failureReason ?? undefined,
      };
    }
    throw redirect("/onboarding");
  } catch (error) {
    if (error instanceof Response) throw error;
    if (error instanceof ProblemError) {
      return { kind: "error", message: error.message, code: error.code };
    }
    return { kind: "error", message: "That did not go through. Try again." };
  }
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return <RouteError title="Could not open this page" error={error} />;
}

export default function Welcome() {
  const result = useActionData<ActionResult>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const [provider, setProvider] = useState<Provider>("lichess");

  // The screen swaps under the person when the lookup resolves, and the button
  // they pressed is disabled while it runs — which drops focus to <body>. Move
  // it to the new heading so a keyboard or screen-reader user is told where
  // they now are instead of being silently returned to the top of the document.
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (result) headingRef.current?.focus();
  }, [result]);

  if (result?.kind === "candidate") {
    const { candidate } = result;
    return (
      <OnboardingShell
        title="Is this you?"
        sub="Forma will read this account's public games and build your first report from them."
        headingRef={headingRef}
      >
        <div className="line-list" style={{ marginTop: "1.2rem" }}>
          <div className="line-row">
            <div className="coverage-dimension">
              <strong>
                {candidate.platform === "chesscom" ? <ChessComMark size={16} /> : <LichessMark size={16} />}{" "}
                {candidate.username}
              </strong>
              <p className="tag-note">
                {candidate.games === null
                  ? "Public games available"
                  : `${candidate.games.toLocaleString()} public games`}
                {candidate.rating === null ? "" : ` · rated ${candidate.rating}`}
              </p>
              {candidate.closed ? (
                <p className="tag-note">This account is closed. Its games can still be read.</p>
              ) : null}
            </div>
          </div>
        </div>

        <Form method="post" className="onboarding-actions">
          <input type="hidden" name="intent" value="confirm" />
          <input type="hidden" name="platform" value={candidate.platform} />
          <input type="hidden" name="username" value={candidate.username} />
          <button className="primary-button btn-lg" disabled={busy}>
            {busy ? "Starting…" : "Yes, read my games"}
          </button>
          <Link to="/welcome" className="chip-btn">
            Not me
          </Link>
        </Form>
      </OnboardingShell>
    );
  }

  return (
    <OnboardingShell
      title="Connect your chess account"
      sub="Forma reads the games you have already played. Nothing is posted, and only public game data is read."
    >
      <Form method="post" className="auth-reset">
        <input type="hidden" name="intent" value="lookup" />
        <ProviderChoice value={provider} onChange={setProvider} />
        <input type="hidden" name="platform" value={provider} />
        <label>
          <span>Your name on that site</span>
          <input
            name="username"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="e.g. ncarcasc"
            required
            // Bound to the message below, so the field itself carries the
            // reason rather than leaving it stranded further down the page.
            aria-describedby={result?.kind === "not-found" || result?.kind === "error" ? "welcome-problem" : undefined}
            aria-invalid={result?.kind === "not-found" || result?.kind === "error" ? true : undefined}
          />
        </label>
        <button className="primary-button btn-lg" disabled={busy}>
          {busy ? "Looking…" : "Find my account"}
        </button>
      </Form>

      <div aria-live="assertive" id="welcome-problem">
        {result?.kind === "not-found" ? (
          <p className="auth-error">
            No {result.platform === "chesscom" ? "Chess.com" : "Lichess"} player called{" "}
            <code>{result.username}</code>. Check the spelling, or try the other site.
          </p>
        ) : null}
      {/* The specific sentence, not the generic one: `ProblemNote` is for a
          `ProblemError` whose code decides the copy, and here the server has
          already told us what went wrong. */}
        {result?.kind === "error" ? <p className="auth-error">{result.message}</p> : null}
      </div>
    </OnboardingShell>
  );
}
