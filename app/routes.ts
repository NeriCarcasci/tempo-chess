import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("operations", "routes/operations.tsx"),
  route("game/:id", "routes/game.tsx"),
] satisfies RouteConfig;
