import { Form, Link, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/connect";
import { requireUser, invalidateSession, signOut } from "../lib/session";
import { apiFetch } from "../lib/api";
import { invalidateCache } from "../lib/loaderCache";
import { BrandLock } from "../components/PublicShell";

/**
 * Onboarding: a signed-in account is worth nothing until it points at some
 * games. Every study surface reads from an imported history, so this is the one
 * step between signing up and having a product.
 */

export function meta() {
  return [{ title: "Connect your chess account · Tempo" }];
}

interface ConnectData {
  email: string | null;
  existing: string | null;
}

export async function clientLoader(): Promise<ConnectData> {
  const session = await requireUser();
  return { email: session.email, existing: session.accounts[0]?.username ?? null };
}

export async function clientAction({ request }: Route.ClientActionArgs) {
  const form = await request.formData();
  const username = String(form.get("username") ?? "").trim();
  const platform = String(form.get("platform") ?? "lichess") as "lichess" | "chesscom";
  if (username.length < 2) return { error: "Enter your username." };

  const linked = await apiFetch("/me/accounts", { json: { username, platform } });
  if (!linked.ok) {
    const body = await linked.json().catch(() => null) as { error?: string } | null;
    return { error: body?.error ?? "Could not link that account." };
  }

  // Linking changes who /me reports, so both caches have to go before the
  // dashboard loader runs.
  invalidateSession();
  invalidateCache();

  // Kick off the first import so the dashboard has something to show. A failure
  // here isn't fatal — the dashboard offers a sync button too.
  await apiFetch("/imports/lichess", { json: { username, games: "all" } }).catch(() => null);

  throw redirect("/dashboard");
}

export default function Connect({ loaderData, actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";

  return (
    <main className="auth-shell">
      <div className="auth-card auth-card-wide">
        <Link to="/" className="auth-brand" aria-label="Tempo home">
          <BrandLock size={24} />
        </Link>
        <h1>Connect your chess account</h1>
        <p className="auth-sub">
          Tempo analyses games you've already played. Tell us where you play and
          we will import your history. It takes a minute or two for a few hundred
          games.
        </p>

        <Form method="post" className="auth-form">
          <fieldset className="auth-choice">
            <legend>Where do you play?</legend>
            <label>
              <input type="radio" name="platform" value="lichess" defaultChecked />
              <span>Lichess</span>
            </label>
            <label>
              <input type="radio" name="platform" value="chesscom" />
              <span>Chess.com</span>
            </label>
          </fieldset>
          <label>
            <span>Your username there</span>
            <input
              type="text"
              name="username"
              placeholder="e.g. ncarcasc"
              defaultValue={loaderData.existing ?? ""}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              required
            />
          </label>
          {actionData?.error ? <p className="auth-error">{actionData.error}</p> : null}
          <button className="primary-button auth-submit" type="submit" disabled={busy}>
            {busy ? "Importing your games…" : "Connect and import"}
          </button>
        </Form>

        <p className="auth-note">
          We only read public game data. Signed in as {loaderData.email ?? "your account"}.{" "}
          <button
            type="button"
            className="auth-inline-link"
            onClick={async () => {
              await signOut();
              location.href = "/";
            }}
          >
            sign out
          </button>
          .
        </p>
      </div>
    </main>
  );
}
