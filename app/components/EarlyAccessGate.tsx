import { useState, type FormEvent, type ReactNode } from "react";
import { Logo } from "./Logo";
import { RookMascot } from "./RookMascot";

const ACCESS_CODE = String(import.meta.env.VITE_EARLY_ACCESS_CODE ?? "").trim();
const ACCESS_KEY = "tempo.early-access.v1";

/**
 * This is a launch/presentation control, not authentication. Vite variables are
 * public in the built bundle; real data security remains behind Supabase and the
 * API's server-side authorization.
 */
export const earlyAccessEnabled = ACCESS_CODE.length > 0;

function hasAccess(): boolean {
  if (!earlyAccessEnabled || typeof window === "undefined") return !earlyAccessEnabled;
  try {
    return window.localStorage.getItem(ACCESS_KEY) === ACCESS_CODE;
  } catch {
    return false;
  }
}

function grantAccess(): void {
  try {
    window.localStorage.setItem(ACCESS_KEY, ACCESS_CODE);
  } catch {
    // Private browsing may refuse storage. The in-memory grant still opens the
    // preview for this visit; the code will simply be requested again on reload.
  }
}

export function EarlyAccessBoundary({
  children,
}: {
  children: ReactNode;
}) {
  const [granted, setGranted] = useState(hasAccess);
  if (!earlyAccessEnabled || granted) return children;
  return <EarlyAccessGate onGrant={() => setGranted(true)} />;
}

function EarlyAccessGate({ onGrant }: { onGrant: () => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState(false);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (code.trim() !== ACCESS_CODE) {
      setError(true);
      return;
    }
    grantAccess();
    onGrant();
  }

  return (
    <main className="early-gate">
      <header className="early-gate-head">
        <Logo size={24} />
        <span>Private preview</span>
      </header>

      <div className="early-gate-grid">
        <section className="early-gate-story" aria-labelledby="early-title">
          <p className="early-kicker">Analysis is underway</p>
          <h1 id="early-title">
            Your mistakes
            <br />
            have a <em>shape</em>.
          </h1>
          <p className="early-intro">
            Forma reads completed games as one connected story, then finds where
            a player's understanding repeatedly gives way.
          </p>

          <ol className="early-phases" aria-label="Forma analysis phases">
            <li><b>01</b><span>Opening</span><i /></li>
            <li><b>02</b><span>Middlegame</span><i /></li>
            <li><b>03</b><span>Endgame</span></li>
          </ol>
        </section>

        <section className="early-gate-entry" aria-labelledby="access-title">
          <div className="early-rook" aria-hidden="true">
            <RookMascot mood="curious" size={164} />
          </div>
          <div className="early-entry-copy">
            <p className="early-kicker">By invitation</p>
            <h2 id="access-title">Forma is in early access.</h2>
            <p>
              We are keeping the first analysis group deliberately small while
              the complete three-phase report is being finished.
            </p>
          </div>

          <form className="early-code-form" onSubmit={submit}>
            <label htmlFor="early-code">Early access code</label>
            <div className={`early-code-row ${error ? "has-error" : ""}`}>
              <input
                id="early-code"
                name="code"
                value={code}
                onChange={(event) => {
                  setCode(event.target.value);
                  if (error) setError(false);
                }}
                autoComplete="one-time-code"
                autoCapitalize="none"
                spellCheck={false}
                aria-invalid={error}
                aria-describedby={error ? "early-code-error" : undefined}
                autoFocus
              />
              <button type="submit">Enter Forma</button>
            </div>
            {error ? (
              <p id="early-code-error" className="early-code-error" role="alert">
                That invitation code is not recognised.
              </p>
            ) : (
              <p className="early-code-note">Invited testers and platform reviewers only.</p>
            )}
          </form>
        </section>
      </div>

      <footer className="early-gate-foot">
        <span>Analysis for completed games only.</span>
        <span>One code unlocks the full preview.</span>
      </footer>
    </main>
  );
}
