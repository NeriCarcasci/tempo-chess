import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useNavigation,
} from "react-router";

import type { Route } from "./+types/root";
import "@fontsource-variable/manrope";
import "@fontsource-variable/newsreader";
import "@fontsource-variable/jetbrains-mono";
import "./app.css";
import "./early-access.css";

export const links: Route.LinksFunction = () => [
  /* The SVG is the real favicon; the .ico is the same mark rasterised, for the
     browsers that ignore image/svg+xml and for anything that goes straight to
     /favicon.ico without reading the document at all. `rel="alternate icon"`
     is what keeps the two from competing. */
  { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
  { rel: "alternate icon", href: "/favicon.ico", sizes: "32x32" },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#f4f1ea" />
        {/* Unconditional while Forma is in closed beta. This used to hang off
            the early-access code, which is gone -- but the reason for it never
            was that code: an unlaunched product should not be in an index, and
            access is about to be decided by approval rather than by a string in
            the bundle. Remove this at public launch, deliberately. */}
        <meta name="robots" content="noindex, nofollow" />
        <Meta />
        <Links />
      </head>
      <body>
        <NavProgress />
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

/** Thin top-of-page bar that animates while a route navigation is pending. */
function NavProgress() {
  const navigation = useNavigation();
  const active = navigation.state !== "idle";
  return <div className={`nav-progress ${active ? "is-active" : ""}`} role="presentation" />;
}

export default function App() {
  return <Outlet />;
}

/**
 * The shape of a product page, not the shape of a page we deleted.
 *
 * This drew a five-panel dashboard - a bordered bar, a wide pulse and four
 * `.panel` boxes in a 1+1+2 grid - which is the layout `/today` was rebuilt
 * away from. Every route without a fallback of its own borrowed it, so the
 * first thing a reader met on the hub, on `/mistakes` and on `/profile` was a
 * skeleton of a page that no longer exists, at `max-w-[1200px] px-5` against
 * the product shell's own 1160px and 1.5rem, so the column jumped sideways on
 * hydration.
 *
 * It also used Tailwind's `animate-pulse`, which this product's reduced-motion
 * block never reaches: the block turns off `ghost-breathe`, the product's own
 * skeleton animation, and knows nothing about Tailwind's.
 *
 * What the pages behind it actually share is a heading over a wide block, so
 * that is what this is - on the product shell's own measure, in the product's
 * own ghost, and still under one roof rather than five boxes.
 */
export function HydrateFallback() {
  return (
    <div className="min-h-dvh" aria-busy="true">
      <div className="hydrate-bar" />
      <div className="hydrate-shell">
        <span className="ghost-block is-head" />
        <span className="ghost-block is-lead" />
        <span className="ghost-block is-body" />
      </div>
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Oops!";
  let details = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "Error";
    details =
      error.status === 404
        ? "The requested page could not be found."
        : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="pt-16 p-4 container mx-auto">
      <h1>{message}</h1>
      <p>{details}</p>
      {stack && (
        <pre className="w-full p-4 overflow-x-auto">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}
