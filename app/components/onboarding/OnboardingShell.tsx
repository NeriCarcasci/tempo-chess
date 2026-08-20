import { Link } from "react-router";
import type { ReactNode, RefObject } from "react";
import { BrandLock } from "../PublicShell";

/**
 * The frame the three onboarding screens share.
 *
 * The same `auth-shell` / `auth-card` the sign-in pages use, and for the same
 * reason: a person mid-onboarding has no games yet, so the product navigation
 * would offer them a row of tabs that all lead to empty surfaces. It also owns
 * the only skip link on these pages — `TopNav` owns its own, and these screens
 * do not have one.
 *
 * `.auth-shell` already establishes the stacking context these pages need, so
 * nothing here sets `z-index`.
 */
export function OnboardingShell({
  title,
  sub,
  wide = false,
  headingRef,
  children,
}: {
  title: string;
  sub?: ReactNode;
  /** For the report, which is a document rather than a form. */
  wide?: boolean;
  /** So a screen that swaps under the reader can move focus to the new title. */
  headingRef?: RefObject<HTMLHeadingElement | null>;
  children: ReactNode;
}) {
  return (
    <main className="auth-shell">
      <a className="skip-link" href="#onboarding-main">
        Skip to content
      </a>
      {/* `tabIndex={-1}` so the skip link actually moves focus. Without it the
          URL gains a fragment and focus stays where it was, which is the
          failure mode that makes skip links look like they work. */}
      <div
        className={wide ? "auth-card auth-card-wide" : "auth-card"}
        id="onboarding-main"
        tabIndex={-1}
      >
        <Link to="/" className="auth-brand" aria-label="Forma home">
          <BrandLock size={24} />
        </Link>
        <h1 ref={headingRef} tabIndex={headingRef ? -1 : undefined}>
          {title}
        </h1>
        {sub ? <p className="auth-sub">{sub}</p> : null}
        {children}
      </div>
    </main>
  );
}
