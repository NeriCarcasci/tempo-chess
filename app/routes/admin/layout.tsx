import { NavLink, Outlet, redirect, isRouteErrorResponse, useRouteError } from "react-router";
import { RookMark } from "../../components/Logo";
import { isAdminHost } from "../../lib/admin";
import { getAccessToken } from "../../lib/session";

/**
 * The shell for `admin.formachess.com`.
 *
 * ## Why this is a route tree in the product app rather than a second app
 *
 * Three options were on the table: a route tree here gated by hostname, a
 * second Cloudflare Pages deployment sharing this API, and a separate app.
 *
 * The deciding fact is that nothing secret can live in a browser bundle either
 * way. `VITE_`-prefixed values are compiled in, so a separate deployment would
 * hold exactly the same secrets as this one, which is none. Separation would
 * therefore buy no security at all, and would cost a second build, a second
 * copy of the API client, the session layer and the design tokens, and a second
 * thing to remember to deploy. The two would drift, and the half that drifted
 * would be the one nobody looks at.
 *
 * So: one build, one deployment, and `admin.formachess.com` is a second custom
 * domain on the same Pages project. The route chunk is lazily loaded, so the
 * marketing site does not ship the admin screens to a visitor who never asks
 * for them, but that is a size argument and not a security one.
 *
 * ## What the hostname gate is and is not
 *
 * It is presentation. Anybody can request `/admin` on any host that serves this
 * bundle, and the 404 below is a convenience, not a boundary. Every screen
 * under here is empty without the API, and the API refuses a caller that does
 * not hold an operator grant in `app.operators` -- a check made by the database
 * inside a security-definer function, not by anything in this file.
 */

export function meta() {
  return [{ title: "Forma admin" }, { name: "robots", content: "noindex, nofollow" }];
}

export async function clientLoader() {
  if (!isAdminHost(window.location.hostname)) {
    // Not "forbidden": on the product domain this path is simply not a page.
    // A 403 here would confirm that an admin surface exists at this path, to
    // somebody who guessed the path.
    throw new Response("Not found", { status: 404 });
  }
  // Signed out is the one thing worth answering before the child loaders fire,
  // so an operator gets the sign-in form rather than three failed reads.
  if (!(await getAccessToken())) throw redirect("/login");
  return null;
}

const TABS = [
  { to: "/admin", label: "Requests", end: true },
  { to: "/admin/accounts", label: "Accounts", end: false },
  { to: "/admin/operations", label: "Operations", end: false },
];

export default function AdminLayout() {
  return (
    <div className="admin-shell">
      <header className="admin-bar">
        <div className="admin-brand">
          <RookMark size={22} />
          <span>Forma</span>
          <span className="admin-tag">admin</span>
        </div>
        <nav className="admin-tabs" aria-label="Admin sections">
          {TABS.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              end={tab.end}
              className={({ isActive }) => `admin-tab ${isActive ? "is-active" : ""}`}
            >
              {tab.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <main className="admin-main">
        <Outlet />
      </main>
    </div>
  );
}

/**
 * The refusal, rendered rather than thrown away.
 *
 * An approved account without an operator grant gets a 403 from every read
 * under here. Without this boundary that surfaces as the app's generic error
 * page, which says something went wrong -- and nothing went wrong.
 */
export function ErrorBoundary() {
  const error = useRouteError();
  const status = isRouteErrorResponse(error) ? error.status : 500;
  const forbidden =
    status === 403 ||
    (error instanceof Error && "code" in error && error.code === "FORBIDDEN");

  return (
    <main className="auth-shell">
      <div className="auth-card">
        <h1>{forbidden ? "Not your surface" : "Something went wrong"}</h1>
        <p className="auth-sub">
          {forbidden
            ? "This account is signed in and does not run Forma."
            : "The admin surface could not load. The request id is in the console."}
        </p>
      </div>
    </main>
  );
}
