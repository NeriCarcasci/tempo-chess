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
  route("account/connect", "routes/connect.tsx"),
  route("welcome", "routes/welcome.tsx"),

  // --- product: everything below needs a session -----------------------
  // The primary nav is the three phases of a game, plus the queue that draws
  // from all three. Lessons and the drill surfaces live under them.
  route("onboarding", "routes/onboarding.tsx"),
  route("report", "routes/report.tsx"),
  route("today", "routes/dashboard.tsx"),
  route("dashboard", "routes/dashboard-redirect.tsx"),
  route("openings", "routes/openings.tsx"),
  route("openings/:familySlug", "routes/opening-family.tsx"),
  // The /v1 explorer, beside the legacy screens rather than over them: the tear
  // sheet, the repertoire stars and the drill queue still have no /v1 surface,
  // so replacing `/openings` today would remove working features.
  route("explorer", "routes/explorer.tsx"),
  route("middlegame", "routes/middlegame.tsx"),
  route("endgame", "routes/endgame.tsx"),
  route("lessons", "routes/lessons.tsx"),
  route("lessons/:slug", "routes/lesson.tsx"),
  route("account", "routes/account.tsx"),
  route("mistakes", "routes/mistakes.tsx"),
  route("play", "routes/play.tsx"),
  route("train", "routes/train.tsx"),
  route("dev/operations", "routes/operations.tsx"),
  route("dev/preview-rook", "routes/__preview-rook.tsx"),
  route("dev/foundation", "routes/__foundation.tsx"),
  route("game/:id", "routes/game.tsx"),
] satisfies RouteConfig;
