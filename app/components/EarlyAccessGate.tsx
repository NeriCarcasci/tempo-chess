import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { RookMascot, type RookHandle } from "./RookMascot";

const ACCESS_CODE = String(import.meta.env.VITE_EARLY_ACCESS_CODE ?? "").trim();
const ACCESS_KEY = "tempo.early-access.v1";

/**
 * This is a launch/presentation control, not authentication. Vite variables are
 * public in the built bundle; real data security remains behind Supabase and the
 * API's server-side authorization.
 */
export const earlyAccessEnabled = ACCESS_CODE.length > 0;

/* Long enough for the mascot's success cue to read before the page behind it
   takes over. Kept short: this is a beat, not a wait. */
const UNLOCK_MS = 700;

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
  const [unlocked, setUnlocked] = useState(false);
  const rook = useRef<RookHandle>(null);
  const timer = useRef(0);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (unlocked) return;
    if (code.trim() !== ACCESS_CODE) {
      setError(true);
      rook.current?.play("error");
      return;
    }
    setUnlocked(true);
    rook.current?.play("success");
    grantAccess();
    timer.current = window.setTimeout(onGrant, UNLOCK_MS);
  }

  return (
    <main className="early-gate">
      <div className="early-gate-inner">
        <RookMascot ref={rook} mood="curious" size={148} track sound />

        <h1>
          Your mistakes have a <em>shape</em>.
        </h1>

        <form className="early-form" onSubmit={submit} data-error={error || undefined}>
          <label htmlFor="early-code" className="sr-only">
            Access code
          </label>
          <input
            id="early-code"
            name="code"
            value={code}
            onChange={(event) => {
              setCode(event.target.value);
              if (error) setError(false);
            }}
            placeholder="Access code"
            autoComplete="one-time-code"
            autoCapitalize="none"
            spellCheck={false}
            disabled={unlocked}
            aria-invalid={error}
            aria-describedby="early-code-note"
            autoFocus
          />
          <button type="submit" disabled={unlocked} aria-label="Enter">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M5 12h13M12.5 6l6 6-6 6"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </form>

        {/* Always present so a rejected code does not shift the form. */}
        <p id="early-code-note" className="early-note" role="status">
          {error ? "That code is not recognised." : ""}
        </p>
      </div>
    </main>
  );
}
