import { Form, Link, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/signup";
import { getSession, signUpWithPassword, invalidateSession } from "../lib/session";
import { supabaseConfigured } from "../lib/supabase";
import { BrandLock } from "../components/PublicShell";

export function meta() {
  return [{ title: "Create account · Forma" }];
}

export async function clientLoader() {
  if (await getSession()) throw redirect("/today");
  return null;
}

export async function clientAction({ request }: Route.ClientActionArgs) {
  const form = await request.formData();
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");
  if (password.length < 8) return { error: "Use at least 8 characters.", pending: false };
  try {
    const { needsConfirmation } = await signUpWithPassword(email, password);
    if (needsConfirmation) {
      return {
        error: null,
        pending: true,
        message: `We sent a confirmation link to ${email}. Click it, then sign in.`,
      };
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Could not sign up.", pending: false };
  }
  invalidateSession();
  // Linking a chess account is a separate, skippable step — asking for it on the
  // same form as the password made signup feel like a form to fill in rather
  // than a thing to try.
  throw redirect("/account/connect");
}

export default function Signup({ actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";

  if (actionData?.pending) {
    return (
      <main className="auth-shell">
        <div className="auth-card">
          <Link to="/" className="auth-brand" aria-label="Forma home">
            <BrandLock size={24} />
          </Link>
          <h1>Check your email</h1>
          <p className="auth-sub">{actionData.message}</p>
          <Link to="/login" className="primary-button auth-submit">Go to sign in</Link>
        </div>
      </main>
    );
  }

  return (
    <main className="auth-shell">
      <div className="auth-card">
        <Link to="/" className="auth-brand" aria-label="Forma home">
          <BrandLock size={24} />
        </Link>
        <h1>Create your account</h1>
        <p className="auth-sub">
          Free to start. Link a chess account next and Forma reads your whole history.
        </p>

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
            <input
              type="password"
              name="password"
              autoComplete="new-password"
              placeholder="At least 8 characters"
              minLength={8}
              required
            />
          </label>
          {actionData?.error ? <p className="auth-error">{actionData.error}</p> : null}
          <button className="primary-button auth-submit" type="submit" disabled={busy || !supabaseConfigured}>
            {busy ? "Creating account…" : "Create account"}
          </button>
        </Form>

        <p className="auth-alt">
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
        <p className="auth-note">
          By creating an account you agree to our <Link to="/terms">Terms</Link> and{" "}
          <Link to="/privacy">Privacy policy</Link>.
        </p>
      </div>
    </main>
  );
}
