import { useEffect, useState } from "react";
import { Link, NavLink } from "react-router";
import { getSession, peekSession } from "../lib/session";
import { Logo } from "./Logo";

/**
 * Chrome for the marketing site. Separate from TopNav on purpose: TopNav assumes
 * a signed-in player and carries board/sound settings, which mean nothing to a
 * visitor who hasn't signed up yet.
 */

/** Kept as a named export so the auth cards share one lockup with the nav. */
export function BrandLock({ size = 22 }: { size?: number }) {
  return <Logo size={size} />;
}

const LINKS = [
  { to: "/features", label: "Features" },
  { to: "/pricing", label: "Pricing" },
];

export function PublicNav() {
  // Marketing pages are reachable while signed in, so the primary action has to
  // change: a returning player wants their dashboard, not another signup form.
  const [signedIn, setSignedIn] = useState(() => Boolean(peekSession()));
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getSession().then((session) => {
      if (!cancelled) setSignedIn(Boolean(session));
    });
    return () => { cancelled = true; };
  }, []);

  return (
    <header className="public-header">
      <a href="#main" className="skip-link">Skip to content</a>
      <div className="public-header-inner">
        <Link to="/" className="public-brand" aria-label="Forma home">
          <Logo />
        </Link>

        <button
          type="button"
          className="public-burger"
          aria-label="Menu"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <span aria-hidden="true" />
          <span aria-hidden="true" />
        </button>

        <nav className={`public-nav ${open ? "is-open" : ""}`} aria-label="Marketing navigation">
          {LINKS.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              prefetch="intent"
              onClick={() => setOpen(false)}
              className={({ isActive }) => (isActive ? "is-active" : undefined)}
            >
              {link.label}
            </NavLink>
          ))}
          {signedIn ? (
            <Link to="/today" className="primary-button public-cta" prefetch="intent">
              Go to dashboard
            </Link>
          ) : (
            <>
              <Link to="/login" className="public-signin" prefetch="intent">Sign in</Link>
              <Link to="/signup" className="primary-button public-cta" prefetch="intent">
                Start free
              </Link>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}

export function PublicFooter() {
  return (
    <footer className="public-footer">
      <div className="public-footer-inner">
        <div className="public-footer-brand">
          <Logo size={20} />
          <p>
            Multi-game chess analysis. We read your whole history, not one game,
            and tell you the truth about it.
          </p>
        </div>
        <nav aria-label="Product">
          <h2>Product</h2>
          <Link to="/features">Features</Link>
          <Link to="/pricing">Pricing</Link>
          <Link to="/signup">Create account</Link>
          <Link to="/login">Sign in</Link>
        </nav>
        <nav aria-label="Legal">
          <h2>Legal</h2>
          <Link to="/terms">Terms of service</Link>
          <Link to="/privacy">Privacy policy</Link>
        </nav>
        <nav aria-label="Elsewhere">
          <h2>Elsewhere</h2>
          <a href="https://lichess.org" target="_blank" rel="noreferrer noopener">Lichess</a>
          <a href="https://www.chess.com" target="_blank" rel="noreferrer noopener">Chess.com</a>
        </nav>
      </div>
      <div className="public-footer-base">
        <span>© {new Date().getFullYear()} Forma</span>
        <span>
          Opening data from the CC0{" "}
          <a href="https://github.com/lichess-org/chess-openings" target="_blank" rel="noreferrer noopener">
            Lichess chess-openings
          </a>{" "}
          catalogue. Not affiliated with Lichess or Chess.com.
        </span>
      </div>
    </footer>
  );
}

/** Page wrapper: nav, a `<main>` landmark, and the footer. */
export function PublicPage({ children }: { children: React.ReactNode }) {
  return (
    <div className="public-shell">
      <PublicNav />
      <main id="main">{children}</main>
      <PublicFooter />
    </div>
  );
}
