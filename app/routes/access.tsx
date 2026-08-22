import { Form, Link, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/access";
import { MAX_NOTE_LENGTH, getAccessRequest, setAccessNote } from "../lib/access";
import { getAccessToken, invalidateSession, signOut } from "../lib/session";
import { SIGNED_IN_PATH } from "../lib/admin";
import { BrandLock } from "../components/PublicShell";
import type { AccessRequest } from "../lib/v1/types";

/**
 * Where an account that has not been let into the closed beta lands.
 *
 * Deliberately does not call `requireSession`. That function redirects here,
 * and a screen that called it would be redirecting to itself. It reads the
 * access request directly, which is one of exactly two `/v1` calls an
 * unapproved account is allowed to make.
 *
 * The gate is not this page. The API refuses every product endpoint for this
 * account whatever the browser does, and this page exists so the refusal has
 * somewhere honest to land rather than a blank screen or a sign-in loop.
 */

export function meta() {
  return [{ title: "Closed beta · Forma" }];
}

interface LoaderData {
  request: AccessRequest;
}

export async function clientLoader(): Promise<LoaderData> {
  const token = await getAccessToken();
  if (!token) throw redirect("/login");

  const request = await getAccessRequest();
  if (request.state === "approved") {
    // They were approved while this tab was open. The cached session still says
    // they were refused, so it has to go before the redirect or the next loader
    // reads the stale answer and sends them straight back here.
    invalidateSession();
    throw redirect(SIGNED_IN_PATH);
  }
  return { request };
}

type ActionResult = { saved: boolean; error: string | null };

export async function clientAction({ request }: Route.ClientActionArgs): Promise<ActionResult> {
  const form = await request.formData();
  if (form.get("intent") === "sign-out") {
    await signOut();
    throw redirect("/");
  }
  try {
    await setAccessNote(String(form.get("note") ?? ""));
    return { saved: true, error: null };
  } catch (error) {
    if (error instanceof Response) throw error;
    return { saved: false, error: "We could not save that. Try again in a moment." };
  }
}

/**
 * The date, spelled out.
 *
 * A relative age ("3 days ago") on this screen would be a countdown, and this
 * is the one screen where we are explicitly not promising a duration.
 */
function asDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function Declined({ request }: { request: AccessRequest }) {
  return (
    <>
      <h1>Not this time</h1>
      <p className="auth-sub">
        We looked at your request and are not able to give you access to Forma.
      </p>
      {request.decisionNote ? <p className="access-decision">{request.decisionNote}</p> : null}
      {/* One sentence, no lecture, and no invitation to argue with a form. A
          reply address is a real route back for somebody who thinks this is
          wrong, and it costs nothing to offer. */}
      <p className="auth-note">
        If you think that is a mistake, write to{" "}
        <a href="mailto:hello@formachess.app">hello@formachess.app</a>.
      </p>
    </>
  );
}

function Pending({ request, result }: { request: AccessRequest; result?: ActionResult }) {
  const navigation = useNavigation();
  const saving = navigation.state === "submitting";
  return (
    <>
      <h1>Forma is in closed beta</h1>
      {/* Says only what is true. Nothing in the product sends mail: there is no
          email provider wired, deliberately, because that is an
          outbound-sending decision and it is not ours to make. Promising an
          email nothing sends is the exact failure this screen exists to avoid,
          so it promises a page instead, which is a promise the code keeps. */}
      <p className="auth-sub">
        Your request was recorded on {asDate(request.requestedAt)}. Someone reads these by
        hand, so this is not instant. There is nothing else you need to do. Come back to
        this page and it will say where your request stands.
      </p>

      <Form method="post" className="auth-form">
        <label>
          <span>Anything you want us to know (optional)</span>
          <textarea
            name="note"
            rows={5}
            maxLength={MAX_NOTE_LENGTH}
            defaultValue={request.note ?? ""}
            placeholder="Where you play, roughly what level, and what you are trying to fix."
          />
        </label>
        <p className="auth-note access-hint">
          This is the part that makes a decision possible. A line about your chess helps
          more than anything else you could send.
        </p>
        {result?.error ? <p className="auth-error">{result.error}</p> : null}
        {result?.saved ? <p className="access-saved">Saved.</p> : null}
        <button type="submit" className="primary-button auth-submit" disabled={saving}>
          {saving ? "Saving" : request.note ? "Update" : "Send"}
        </button>
      </Form>
    </>
  );
}

export default function Access({ loaderData, actionData }: Route.ComponentProps) {
  const { request } = loaderData;
  return (
    <main className="auth-shell">
      <div className="auth-card access-card">
        <Link to="/" className="auth-brand" aria-label="Forma home">
          <BrandLock size={24} />
        </Link>

        {request.state === "declined" ? (
          <Declined request={request} />
        ) : (
          <Pending request={request} result={actionData} />
        )}

        {/* Signing out is the other thing an account in this state can do, and
            it needs to be reachable: somebody who signed up with the wrong
            address has no other way out of this screen. */}
        <Form method="post" className="access-signout">
          <input type="hidden" name="intent" value="sign-out" />
          <button type="submit" className="link-button">
            Sign out
          </button>
        </Form>
      </div>
    </main>
  );
}
