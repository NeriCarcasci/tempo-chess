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
import "@fontsource-variable/jetbrains-mono";
import "./app.css";

export const links: Route.LinksFunction = () => [];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#f7f7f2" />
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

export function HydrateFallback() {
  return (
    <div className="min-h-dvh">
      <div className="h-14 border-b border-line" />
      <div className="mx-auto max-w-[1200px] px-5 pt-8 sm:px-8">
        <div className="mb-6 h-14 w-64 animate-pulse rounded-panel bg-surface" />
        <div className="space-y-6">
          <div className="panel h-40 animate-pulse" />
          <div className="panel h-36 animate-pulse" />
          <div className="grid gap-6 lg:grid-cols-2">
            <div className="panel h-56 animate-pulse" />
            <div className="panel h-56 animate-pulse" />
          </div>
        </div>
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
