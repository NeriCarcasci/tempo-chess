import { Form, Link, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/reset-password";
import { BrandLock } from "../components/PublicShell";
import { getSupabase, supabaseConfigured } from "../lib/supabase";
import { updatePassword } from "../lib/session";

export function meta() {
  return [{ title: "Choose a new password · Tempo" }];
}

export async function clientLoader() {
  if (!supabaseConfigured) return { ready: false };
  const { data } = await getSupabase().auth.getSession();
  return { ready: Boolean(data.session) };
}

export async function clientAction({ request }: Route.ClientActionArgs) {
  const form = await request.formData();
  const password = String(form.get("password") ?? "");
  const confirmation = String(form.get("confirmation") ?? "");
  if (password.length < 8) return { error: "Use at least 8 characters." };
  if (password !== confirmation) return { error: "The passwords do not match." };
  try {
    await updatePassword(password);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Could not update your password." };
  }
  throw redirect("/login?reset=success");
}

export default function ResetPassword({ loaderData, actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";

  return (
    <main className="auth-shell">
      <div className="auth-card">
        <Link to="/" className="auth-brand" aria-label="Tempo home">
          <BrandLock size={24} />
        </Link>
        <h1>Choose a new password</h1>
        <p className="auth-sub">
          {loaderData.ready
            ? "Use a new password you have not used for this account before."
            : "This reset link has expired or has already been used."}
        </p>
        {loaderData.ready ? (
          <Form method="post" className="auth-form">
            <label>
              <span>New password</span>
              <input type="password" name="password" autoComplete="new-password" minLength={8} required />
            </label>
            <label>
              <span>Confirm new password</span>
              <input type="password" name="confirmation" autoComplete="new-password" minLength={8} required />
            </label>
            {actionData?.error ? <p className="auth-error">{actionData.error}</p> : null}
            <button className="primary-button auth-submit" type="submit" disabled={busy}>
              {busy ? "Updating…" : "Update password"}
            </button>
          </Form>
        ) : (
          <Link to="/login" className="primary-button auth-submit">Request another link</Link>
        )}
      </div>
    </main>
  );
}
