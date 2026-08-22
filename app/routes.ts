import { type RouteConfig, index, layout, route } from "@react-router/dev/routes";

/**
 * Which surface this build is.
 *
 * Read from the build environment rather than from the hostname, because the
 * two answer different questions. A hostname check runs in the browser and can
 * only hide a screen that has already been shipped; this decides what gets
 * built at all. The admin deployment is a separate Cloudflare Pages project
 * with its own artifact, and it should contain the operator console and the two
 * screens needed to sign into it -- not the marketing site with the console
 * tucked behind a redirect.
 *
 * The first attempt did it the other way round and deployed the landing page to
 * the admin subdomain, which is the whole reason this exists.
 */
const SURFACE = process.env.VITE_SURFACE ?? "product";

/**
 * The admin build.
 *
 * The console sits at `/`, so the deployment is the dashboard rather than a
 * site containing one. `login` is here because an operator has to sign in, and
 * `access` because an operator is an approved account first: somebody whose own
 * request is still pending gets sent there by the API's refusal, and without
 * this route that redirect would land on nothing.
 *
 * Nothing else is built. There is no marketing page, no product screen and no
 * chess board in this artifact.
 */
const adminSurface = [
  route("login", "routes/login.tsx"),
  // `sendPasswordReset` builds its callback as `location.origin/reset-password`,
  // so an operator resetting from the admin host gets a link back to the admin
  // host. Without this route that link lands on the console's 404.
  route("reset-password", "routes/reset-password.tsx"),
  route("access", "routes/access.tsx"),
  layout("routes/admin/layout.tsx", [
    index("routes/admin/requests.tsx"),
    route("accounts", "routes/admin/accounts.tsx"),
    route("operations", "routes/admin/operations.tsx"),
  ]),
] satisfies RouteConfig;

const productSurface = [
  // --- public: the marketing site --------------------------------------
  index("routes/home.tsx"),
  route("features", "routes/features.tsx"),
  route("pricing", "routes/pricing.tsx"),
  route("terms", "routes/terms.tsx"),
  route("privacy", "routes/privacy.tsx"),
  route("brand", "routes/brand.tsx"),

  // --- auth ------------------------------------------------------------
  route("login", "routes/login.tsx"),
  route("signup", "routes/signup.tsx"),
  route("reset-password", "routes/reset-password.tsx"),
  // Where an account that has not been let into the closed beta lands. Under
  // auth rather than under the product, because it is the screen the product's
  // own refusal redirects to and it must not itself require access.
  route("access", "routes/access.tsx"),
  route("account/connect", "routes/connect.tsx"),
  route("welcome", "routes/welcome.tsx"),

  // --- product: everything below needs a session -----------------------
  // The primary nav is the three phases of a game, plus the queue that draws
  // from all three. Lessons and the drill surfaces live under them.
  route("onboarding", "routes/onboarding.tsx"),
  route("report", "routes/report.tsx"),
  route("today", "routes/dashboard.tsx"),
  route("dashboard", "routes/dashboard-redirect.tsx"),
  // One openings screen, on /v1. `/openings/:familySlug` is the same module
  // with that line's row open and the walk under it.
  route("openings", "routes/openings.tsx"),
  route("openings/:familySlug", "routes/opening-family.tsx"),
  // `/explorer` was the second build of the same idea. It redirects now rather
  // than 404s, because the URL has been linked.
  route("explorer", "routes/explorer.tsx"),
  route("middlegame", "routes/middlegame.tsx"),
  route("endgame", "routes/endgame.tsx"),
  route("lessons", "routes/lessons.tsx"),
  route("lessons/:slug", "routes/lesson.tsx"),
  route("account", "routes/account.tsx"),
  route("profile", "routes/profile.tsx"),
  route("mistakes", "routes/mistakes.tsx"),
  route("play", "routes/play.tsx"),
  route("train", "routes/train.tsx"),
  route("dev/operations", "routes/operations.tsx"),
  route("dev/preview-rook", "routes/__preview-rook.tsx"),
  route("dev/foundation", "routes/__foundation.tsx"),
  route("game/:id", "routes/game.tsx"),

  // --- admin ------------------------------------------------------------
  // Also mounted in the product build, under /admin, so the console can be
  // reached in development without a second dev server. The deployed admin
  // surface is the separate artifact above, not this.
  route("admin", "routes/admin/layout.tsx", [
    index("routes/admin/requests.tsx"),
    route("accounts", "routes/admin/accounts.tsx"),
    route("operations", "routes/admin/operations.tsx"),
  ]),
] satisfies RouteConfig;

export default (SURFACE === "admin" ? adminSurface : productSurface) satisfies RouteConfig;
