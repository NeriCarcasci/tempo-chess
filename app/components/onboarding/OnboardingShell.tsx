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
  split,
  headingRef,
  children,
}: {
  title: string;
  sub?: ReactNode;
  /** For the report, which is a document rather than a form. */
  wide?: boolean;
  /**
   * A second panel beside the form, on the accent ground.
   *
   * Only the connect screen passes one, and only because that screen has
   * something worth drawing: where the games come from. The card grows a
   * column rather than the panel floating beside it, so the two halves share
   * one radius and one shadow and read as a single object. Under 860px the
   * column is dropped entirely rather than stacked — a decorative panel above
   * a form is a screenful of scrolling before the first field.
   */
  split?: ReactNode;
  /** So a screen that swaps under the reader can move focus to the new title. */
  headingRef?: RefObject<HTMLHeadingElement | null>;
  children: ReactNode;
}) {
  const className = split
    ? "auth-card auth-card-split"
    : wide
      ? "auth-card auth-card-wide"
      : "auth-card";

  return (
    <main className="auth-shell">
      <a className="skip-link" href="#onboarding-main">
        Skip to content
      </a>
      {/* `tabIndex={-1}` so the skip link actually moves focus. Without it the
          URL gains a fragment and focus stays where it was, which is the
          failure mode that makes skip links look like they work. */}
      <div className={className} id="onboarding-main" tabIndex={-1}>
        <div className="auth-card-body">
          <Link to="/" className="auth-brand" aria-label="Forma home">
            <BrandLock size={24} />
          </Link>
          <h1 ref={headingRef} tabIndex={headingRef ? -1 : undefined}>
            {title}
          </h1>
          {/* A `div`, not a `p`: a screen may hand the rook in here, and a
              mascot beside a bubble is block content the parser will not
              accept inside a paragraph. */}
          {sub ? <div className="auth-sub">{sub}</div> : null}
          {children}
        </div>
        {split}
      </div>
    </main>
  );
}
