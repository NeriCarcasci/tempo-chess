import { useState } from "react";
import { Form, Link, redirect, useNavigation, useSearchParams } from "react-router";
import type { Route } from "./+types/login";
import { SIGNED_IN_PATH } from "../lib/admin";
import {
  awaitingApproval,
  getSession,
  invalidateSession,
  sendPasswordReset,
  signInWithPassword,
} from "../lib/session";
import { supabaseConfigured } from "../lib/supabase";
import { BrandLock } from "../components/PublicShell";

export function meta() {
  return [{ title: "Sign in · Forma" }];
}

export async function clientLoader() {
  if (await getSession()) throw redirect(SIGNED_IN_PATH);
  // Signed in and not yet let into the closed beta. Showing the sign-in form
  // instead would invite them to authenticate again, which succeeds and lands
  // them back here.
  if (awaitingApproval()) throw redirect("/access");
  return null;
}

export async function clientAction({ request }: Route.ClientActionArgs) {
  const form = await request.formData();
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");
  if (!email || !password) return { error: "Enter your email and password." };
  try {
    await signInWithPassword(email, password);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Could not sign in." };
  }
  // The session cache is keyed to the previous user; drop it before the next
  // loader reads /me, or a fast re-login would show the old account's data.
  invalidateSession();
  const next = new URL(request.url).searchParams.get("next");
  // `next` is honoured when it is a same-site path, and the fallback differs by
  // surface: the admin build has no `/today`, so signing in there would land on
  // a route that is not in the bundle.
  throw redirect(next && next.startsWith("/") ? next : SIGNED_IN_PATH);
}

function ResetPassword() {
  const [state, setState] = useState<{ sent: boolean; error: string | null }>({
    sent: false,
    error: null,
  });
  const [email, setEmail] = useState("");
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button type="button" className="auth-inline-link" onClick={() => setOpen(true)}>
        Forgot your password?
      </button>
    );
  }
  return (
    <div className="auth-reset">
      <label>
        <span>Email for a reset link</span>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          autoComplete="email"
        />
      </label>
      <button
        type="button"
        className="secondary-button"
        disabled={!email || state.sent}
        onClick={async () => {
          try {
            await sendPasswordReset(email);
            setState({ sent: true, error: null });
          } catch (error) {
            setState({ sent: false, error: error instanceof Error ? error.message : "Failed." });
          }
        }}
      >
        {state.sent ? "Link sent" : "Send reset link"}
      </button>
      {state.error ? <p className="auth-error">{state.error}</p> : null}
      {state.sent ? <p className="auth-ok">Check your inbox for the reset link.</p> : null}
    </div>
  );
}

export default function Login({ actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const [params] = useSearchParams();
  const busy = navigation.state === "submitting";
  const justSignedUp = params.get("confirmed") === "1";
  const passwordReset = params.get("reset") === "success";

  return (
    <main className="auth-shell">
      <div className="auth-card">
        <Link to="/" className="auth-brand" aria-label="Forma home">
          <BrandLock size={24} />
        </Link>
        <h1>Welcome back</h1>
        <p className="auth-sub">Sign in to pick up your study where you left off.</p>

        {justSignedUp ? (
          <p className="auth-ok">Email confirmed. Sign in to continue.</p>
        ) : null}
        {passwordReset ? (
          <p className="auth-ok">Password updated. Sign in with your new password.</p>
        ) : null}
        {!supabaseConfigured ? (
          <p className="auth-error">
            Authentication isn't configured. Set <code>VITE_SUPABASE_URL</code> and{" "}
            <code>VITE_SUPABASE_ANON_KEY</code> in <code>.env</code>.
          </p>
        ) : null}

        <Form method="post" className="auth-form">
          <label>
            <span>Email</span>
            <input type="email" name="email" autoComplete="email" placeholder="you@example.com" required />
          </label>
          <label>
            <span>Password</span>
            <input type="password" name="password" autoComplete="current-password" placeholder="••••••••" required />
          </label>
          {actionData?.error ? <p className="auth-error">{actionData.error}</p> : null}
          <button className="primary-button auth-submit" type="submit" disabled={busy || !supabaseConfigured}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </Form>

        <ResetPassword />

        <p className="auth-alt">
          New here? <Link to="/signup">Create an account</Link>
        </p>
      </div>
    </main>
  );
}
