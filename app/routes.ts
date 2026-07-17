import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("openings", "routes/openings.tsx"),
  route("dev/operations", "routes/operations.tsx"),
  route("game/:id", "routes/game.tsx"),
] satisfies RouteConfig;
