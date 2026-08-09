import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  // --- public: the marketing site --------------------------------------
  index("routes/home.tsx"),
  route("features", "routes/features.tsx"),
  route("pricing", "routes/pricing.tsx"),
  route("terms", "routes/terms.tsx"),
  route("privacy", "routes/privacy.tsx"),

  // --- auth ------------------------------------------------------------
  route("login", "routes/login.tsx"),
  route("signup", "routes/signup.tsx"),
  route("account/connect", "routes/connect.tsx"),

  // --- product: everything below needs a session -----------------------
  route("dashboard", "routes/dashboard.tsx"),
  route("openings", "routes/openings.tsx"),
  route("openings/:familySlug", "routes/opening-family.tsx"),
  route("lessons", "routes/lessons.tsx"),
  route("lessons/:slug", "routes/lesson.tsx"),
  route("account", "routes/account.tsx"),
  route("mistakes", "routes/mistakes.tsx"),
  route("play", "routes/play.tsx"),
  route("train", "routes/train.tsx"),
  route("dev/operations", "routes/operations.tsx"),
  route("game/:id", "routes/game.tsx"),
] satisfies RouteConfig;
