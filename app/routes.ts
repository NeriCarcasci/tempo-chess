import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
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

  // --- admin: admin.formachess.com -------------------------------------
  // One deployment serves both hosts; see routes/admin/layout.tsx for why, and
  // for why the hostname check there is presentation rather than a boundary.
  route("admin", "routes/admin/layout.tsx", [
    index("routes/admin/requests.tsx"),
    route("accounts", "routes/admin/accounts.tsx"),
    route("operations", "routes/admin/operations.tsx"),
  ]),
] satisfies RouteConfig;
