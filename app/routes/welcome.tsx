import { useEffect, useRef, useState } from "react";
import { Form, Link, redirect, useActionData, useNavigation } from "react-router";
import type { Route } from "./+types/welcome";
import { OnboardingShell } from "../components/onboarding/OnboardingShell";
import { ProviderChoice, type Provider } from "../components/onboarding/ProviderChoice";
import { ConnectPanel } from "../components/onboarding/ConnectPanel";
import { RouteError } from "../components/RouteError";
import { getMe, getOnboarding, linkAccount, startRun, unlinkAccount } from "../lib/onboarding/api";
import { nextScreen } from "../lib/onboarding/nextScreen";
import { ProblemError } from "../lib/v1/problem";
import { newIdempotencyKey } from "../lib/v1/client";
import type { LinkedAccount } from "../lib/v1/types";
import { apiFetch } from "../lib/api";
import { requireUser, setActiveAccount } from "../lib/session";
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
 * ## The double write is gone
 *
 * Confirming used to link the account twice and then start the prototype's
 * importer, so the screens that read `public.games` had something to draw. It
 * writes `/v1` only now. The legacy half stored a *different* account id, and
 * the session validates the stored active account against `/v1/me`, so the id
 * it kept matched nothing: linking could leave the product pointed at an
 * account no loader could resolve. Games arrive with the examination run that
 * "Read my games" starts, which is the only importer the canonical system has.
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
  | { kind: "added"; handle: string }
  | { kind: "removed" }
  | { kind: "error"; message: string; code?: string };

/**
 * The lookup, run from the component rather than through the route action.
 *
 * It is a read that changes nothing, and routing it through an action meant
 * every keystroke-and-submit revalidated the loader and re-rendered the whole
 * card — the panel replayed its arrival animations and the account list rebuilt
 * itself, all to answer a question about one text field. Kept local, the only
 * thing that changes is the slot that asked.
 */
type LookupResult =
  | { kind: "candidate"; candidate: Candidate }
  | { kind: "not-found"; platform: Provider; username: string }
  | { kind: "error"; message: string };

async function lookupAccount(platform: Provider, username: string): Promise<LookupResult> {
  const response = await apiFetch(`/platform-accounts/${platform}/${encodeURIComponent(username)}`);
  if (response.status === 404) return { kind: "not-found", platform, username };
  if (!response.ok) {
    return {
      kind: "error",
      message: "That chess site did not answer. It is usually brief, so try again in a moment.",
    };
  }
  // The route answers `{ found: false }` with a 200, not a 404: "we asked and
  // there is no such player" is a successful lookup. It also wraps the account
  // in an envelope. Reading the envelope as the account itself is what made
  // every field undefined and crashed the screen on `games.toLocaleString()`.
  const body = (await response.json()) as { found: false } | { found: true; account: Candidate };
  if (!body.found || !body.account) return { kind: "not-found", platform, username };
  return { kind: "candidate", candidate: body.account };
}

interface LoaderData {
  /** Everything already connected, so the list survives adding the next one. */
  accounts: LinkedAccount[];
}

export async function clientLoader(): Promise<LoaderData> {
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
    // Straight to the report when there is one. Sending everybody through
    // /onboarding meant a person whose report was written days ago got a
    // progress screen for the length of one redirect.
    throw redirect(destination.kind === "report" ? "/report" : "/onboarding");
  }
  // The list is read from the server rather than accumulated in component
  // state: adding an account is a write on two surfaces, and a client-side
  // list would happily show one that only half-landed.
  const me = await getMe().catch(() => null);
  return { accounts: me?.accounts ?? [] };
}

export async function clientAction({ request }: Route.ClientActionArgs): Promise<ActionResult> {
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "lookup");
  const platform = (String(form.get("platform") ?? "lichess") === "chesscom"
    ? "chesscom"
    : "lichess") as Provider;
  const username = String(form.get("username") ?? "").trim();

  // Only `add` carries a name. `start` and `remove` do not, and demanding one
  // of them rejected every disconnect before it reached the server.
  if (intent === "add" && !username) {
    return { kind: "error", message: "Enter the name you play under." };
  }

  // --- remove --------------------------------------------------------------
  // Disconnect, not delete: the server closes the membership and marks the link
  // disconnected so analysis already built from those games keeps a source. The
  // control says "Remove" because that is what it does to this list, and the
  // copy never promises erasure.
  if (intent === "remove") {
    const accountId = String(form.get("accountId") ?? "");
    if (!accountId) return { kind: "error", message: "That account is already gone." };
    try {
      await unlinkAccount({ accountId, idempotencyKey: newIdempotencyKey() });
      return { kind: "removed" };
    } catch (error) {
      if (error instanceof ProblemError) {
        return { kind: "error", message: error.message, code: error.code };
      }
      return { kind: "error", message: "That did not go through. Try again." };
    }
  }

  // --- add -----------------------------------------------------------------
  // Linking and starting are separate intents now. Somebody who plays on both
  // sites gets one report covering both, and the planner already emits a sync
  // task per account and holds the baseline until every one of them lands --
  // starting after the first would freeze a snapshot over half an archive.
  if (intent === "add") {
    try {
      const session = await requireUser();
      const account = await linkAccount({
        provider: platform,
        handle: username,
        idempotencyKey: newIdempotencyKey(),
      });

      // The id is the `/v1` one — it is the only list the session validates the
      // stored choice against. This also drops the session and loader caches,
      // so the next loader sees the account that was just added.
      setActiveAccount(session.userId, account.id);
      return { kind: "added", handle: username };
    } catch (error) {
      if (error instanceof ProblemError) {
        return { kind: "error", message: error.message, code: error.code };
      }
      return { kind: "error", message: "That did not go through. Try again." };
    }
  }

  // --- start ---------------------------------------------------------------
  try {
    const state = await startRun({ idempotencyKey: newIdempotencyKey() });
    // A 2xx does not mean it started: with no active linked account the planner
    // fails the run inside the same request.
    if (state.status === "failed") {
      return {
        kind: "error",
        message:
          "Those accounts linked, but there was nothing to read from them. Check the names and try again.",
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

/** A plus, drawn rather than typed, so it sits on the baseline of its own box. */
function PlusGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path
        d="M8 3v10M3 8h10"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** The dismiss cross. Same drawn-not-typed reason as the plus. */
function CrossGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path
        d="M4.5 4.5l7 7M11.5 4.5l-7 7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default function Welcome({ loaderData }: Route.ComponentProps) {
  const { accounts } = loaderData as LoaderData;
  const result = useActionData<ActionResult>();
  const navigation = useNavigation();
  const [provider, setProvider] = useState<Provider>("lichess");

  /**
   * Whether the add slot is open.
   *
   * One at a time, deliberately: the row is a single slot that either shows the
   * plus or shows the form that plus opened. Two half-filled forms on screen at
   * once would each need their own lookup, their own error and their own busy
   * state, and the person could still only submit one of them.
   */
  const [adding, setAdding] = useState(false);

  /**
   * The lookup lives here, not in the route action.
   *
   * A read that changes nothing has no business revalidating the loader: doing
   * so rebuilt the account list and replayed the panel's arrival animation
   * every time somebody checked a spelling. Local state means pressing Add
   * touches exactly one part of the screen, which is the part that asked.
   */
  const [looking, setLooking] = useState(false);
  const [lookup, setLookup] = useState<LookupResult | null>(null);

  const writing = navigation.state !== "idle";
  const busy = writing || looking;
  const candidate = lookup?.kind === "candidate" ? lookup.candidate : null;

  const connected = accounts.filter((account) => account.status === "active");
  const started = connected.length > 0;

  /**
   * The empty screen and the filled one are different shapes, not one shape
   * with things greyed out.
   *
   * With nothing connected there is no list to head, no slot to open and
   * nothing to read, so the card is the form and only the form. The section
   * heading, the plus and the start button arrive together the moment the first
   * account does, at which point each has something to say. Showing all three
   * at zero meant a label over an empty list, a control that opened the form
   * that was already the only thing to do, and a disabled button under the
   * sentence explaining why it was disabled.
   */
  const formOpen = started ? adding : true;

  // A link that landed closes the slot and clears the lookup with it, so the
  // next add starts from the same place the last one did.
  useEffect(() => {
    if (result?.kind === "added") {
      setAdding(false);
      setLookup(null);
    }
  }, [result]);

  const closeSlot = () => {
    setAdding(false);
    setLookup(null);
  };

  async function runLookup(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const username = String(data.get("username") ?? "").trim();
    if (!username) return;
    setLooking(true);
    try {
      setLookup(await lookupAccount(provider, username));
    } catch {
      setLookup({ kind: "error", message: "That did not go through. Try again." });
    } finally {
      setLooking(false);
    }
  }

  return (
    <OnboardingShell
      split={
        <ConnectPanel
          feeds={connected.map((account) => ({
            provider: account.provider === "chesscom" ? "chesscom" : "lichess",
            key: account.id,
          }))}
        />
      }
      title={started ? "Add another account?" : "Connect your chess account"}
      sub={
        started
          ? "Add every site you play on and the first report covers all of them together. You can start whenever you are ready."
          : "Forma reads the games you have already played. Nothing is posted, and only public game data is read."
      }
    >
      <section
        className="connect-accounts"
        aria-labelledby={started ? "connect-accounts-head" : undefined}
        aria-label={started ? undefined : "Add a chess account"}
      >
        {started ? (
          <p className="cap" id="connect-accounts-head">
            Connected accounts
          </p>
        ) : null}

        <ul className="connect-rows">
          {connected.map((account) => (
            <li key={account.id} className="connect-row is-linked">
              <span className="connect-row-mark" aria-hidden="true">
                {account.provider === "chesscom" ? (
                  <ChessComMark size={16} />
                ) : (
                  <LichessMark size={16} />
                )}
              </span>
              <span className="connect-row-text">
                <strong>{account.handle ?? "Connected account"}</strong>
                <small>{account.provider === "chesscom" ? "Chess.com" : "Lichess"}</small>
              </span>
              {/* A tick, not a colour on its own: DESIGN.md's rule that meaning
                  never rides on hue alone applies to a state as much as to a
                  result. It gives way to the remove control on approach, so the
                  row is a status at rest and an action when reached for. */}
              <span className="connect-row-state">
                <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
                  <path
                    d="M3.5 8.5l3 3 6-7"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.9"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                Connected
              </span>
              {/* Disconnect, not delete. The server closes the membership and
                  keeps the link on record so analysis already built from those
                  games still has a source, which is why this says Remove and
                  never promises erasure. */}
              <Form method="post" className="connect-row-remove">
                <input type="hidden" name="intent" value="remove" />
                <input type="hidden" name="accountId" value={account.id} />
                <button
                  className="connect-x"
                  disabled={busy}
                  aria-label={`Remove ${account.handle ?? "this account"}`}
                >
                  <CrossGlyph />
                </button>
              </Form>
            </li>
          ))}

          <li className="connect-row-slot">
            {formOpen ? (
              candidate ? (
                /* The lookup found somebody. What is left is the one check that
                   stops a typo becoming a linked account and an import of a
                   stranger, so it stays, inside the slot rather than as a card
                   underneath it. This form does write, so it is a real post. */
                <Form method="post" className={started ? "connect-add" : "connect-add is-bare"}>
                  <div className="connect-add-head">
                    <p className="cap">Is this you?</p>
                    <button
                      type="button"
                      className="connect-x"
                      onClick={closeSlot}
                      aria-label="Not me, search again"
                    >
                      <CrossGlyph />
                    </button>
                  </div>
                  <div className="connect-candidate">
                    <span className="connect-row-mark" aria-hidden="true">
                      {candidate.platform === "chesscom" ? (
                        <ChessComMark size={16} />
                      ) : (
                        <LichessMark size={16} />
                      )}
                    </span>
                    <span className="connect-row-text">
                      <strong>{candidate.username}</strong>
                      <small>
                        {candidate.games == null
                          ? "Public games available"
                          : `${candidate.games.toLocaleString()} public games`}
                        {candidate.rating == null ? "" : ` · rated ${candidate.rating}`}
                      </small>
                    </span>
                  </div>
                  {candidate.closed ? (
                    <p className="tag-note">This account is closed. Its games can still be read.</p>
                  ) : null}
                  <input type="hidden" name="intent" value="add" />
                  <input type="hidden" name="platform" value={candidate.platform} />
                  <input type="hidden" name="username" value={candidate.username} />
                  <button className="primary-button connect-add-go" disabled={busy}>
                    {writing ? "Adding…" : "Add this account"}
                  </button>
                </Form>
              ) : (
                /* The lookup itself. `onSubmit` rather than a post, because
                   asking whether a name exists changes nothing and should not
                   reload the card around it. */
                <form
                  onSubmit={runLookup}
                  className={started ? "connect-add" : "connect-add is-bare"}
                  aria-label="Add a chess account"
                >
                  {started ? (
                    <div className="connect-add-head">
                      <p className="cap">Add an account</p>
                      <button
                        type="button"
                        className="connect-x"
                        onClick={closeSlot}
                        aria-label="Cancel adding an account"
                      >
                        <CrossGlyph />
                      </button>
                    </div>
                  ) : null}
                  <ProviderChoice value={provider} onChange={setProvider} />
                  <label className="connect-field">
                    <span>Your name on that site</span>
                    <input
                      name="username"
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      placeholder="e.g. ncarcasc"
                      required
                      aria-describedby={lookup ? "welcome-problem" : undefined}
                      aria-invalid={
                        lookup?.kind === "not-found" || lookup?.kind === "error" ? true : undefined
                      }
                    />
                  </label>
                  <button className="primary-button connect-add-go" disabled={busy}>
                    {looking ? "Looking…" : started ? "Add" : "Add account"}
                  </button>
                </form>
              )
            ) : (
              /* The empty slot. It reads as a row so the list has a shape before
                 anything is in it, and its dashed edge is the one place on this
                 card a drawn line earns itself: it says "nothing here yet",
                 which no amount of surface or space says as quickly. */
              <button type="button" className="connect-plus" onClick={() => setAdding(true)}>
                <span className="connect-plus-icon" aria-hidden="true">
                  <PlusGlyph />
                </span>
                Add another account
              </button>
            )}
          </li>
        </ul>

        <div aria-live="assertive" id="welcome-problem" className="connect-say">
          {lookup?.kind === "not-found" ? (
            <p className="auth-error">
              No {lookup.platform === "chesscom" ? "Chess.com" : "Lichess"} player called{" "}
              <code>{lookup.username}</code>. Check the spelling, or try the other site.
            </p>
          ) : null}
          {lookup?.kind === "error" ? <p className="auth-error">{lookup.message}</p> : null}
          {/* The specific sentence, not the generic one: `ProblemNote` is for a
              `ProblemError` whose code decides the copy, and here the server has
              already told us what went wrong. */}
          {result?.kind === "error" ? <p className="auth-error">{result.message}</p> : null}
        </div>

        {/* Absent until there is something to read, rather than present and
            greyed. A disabled control with a sentence underneath explaining why
            it is disabled is two pieces of furniture doing the job of one
            missing thing, and it is the page's own rule elsewhere: something
            that cannot state its reason does not render. */}
        {started ? (
          <Form method="post" className="connect-start">
            <input type="hidden" name="intent" value="start" />
            <button className="primary-button btn-lg" disabled={busy}>
              {writing ? "Starting…" : "Read my games"}
            </button>
          </Form>
        ) : null}
      </section>
    </OnboardingShell>
  );
}
