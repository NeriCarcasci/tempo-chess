import { NavLink, Outlet, redirect, isRouteErrorResponse, useRouteError } from "react-router";
import { RookMark } from "../../components/Logo";
import { ADMIN_BASE, ADMIN_BUILD, isAdminHost } from "../../lib/admin";
import { getAccessToken } from "../../lib/session";

/**
 * The shell for `admin.formachess.com`.
 *
 * ## Two builds, one source
 *
 * The admin surface ships as its own Cloudflare Pages project, built from this
 * repository with `VITE_SURFACE=admin`. `app/routes.ts` then builds a different
 * route tree: this console at `/`, plus sign-in and the closed-beta screen, and
 * nothing else. No marketing page, no product screen.
 *
 * The first attempt shared one artifact between both hostnames and used the
 * hostname check below as the only thing separating them. That put the landing
 * page at the root of the admin deployment, which is not an admin dashboard, it
 * is the website with a console hidden inside it.
 *
 * Sharing the source is still right: one API client, one session layer, one set
 * of design tokens. It is the *artifact* that has to differ, not the code.
 *
 * ## What the hostname check is and is not
 *
 * In the product build this console is also mounted at `/admin`, so it can be
 * reached in development without a second dev server, and the hostname check
 * keeps it off the marketing domain. That check is presentation, not a
 * boundary: anybody can request the path on any host that serves the bundle.
 * Every screen here is empty without the API, and the API refuses a caller that
 * does not hold an operator grant in `app.operators` -- a check made by the
 * database inside a security-definer function, not by anything in this file.
 */

export function meta() {
  return [{ title: "Forma admin" }, { name: "robots", content: "noindex, nofollow" }];
}

export async function clientLoader() {
  // In the admin build the whole deployment is the console, so there is no
  // marketing surface to keep it away from and no hostname to check against.
  if (!ADMIN_BUILD && !isAdminHost(window.location.hostname)) {
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

// A hardcoded `/admin` would give the admin deployment three links to nowhere.
const TABS = [
  { to: `${ADMIN_BASE}/`, label: "Requests", end: true },
  { to: `${ADMIN_BASE}/accounts`, label: "Accounts", end: false },
  { to: `${ADMIN_BASE}/operations`, label: "Operations", end: false },
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
