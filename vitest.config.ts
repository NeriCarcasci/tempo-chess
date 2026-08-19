/**
 * The web test runner.
 *
 * Deliberately a standalone file rather than a `test:` block on
 * `vite.config.ts`. That config loads `reactRouter()`, which runs typegen,
 * injects virtual modules and strips `loader`/`action` exports from anything it
 * recognises as a route module — a route under test would come back with its
 * exports removed. Vitest prefers this file and then ignores `vite.config.ts`
 * entirely, which is the point.
 *
 * `include` is narrow on purpose: the default glob would sweep in the forty
 * standalone scripts under `server/src/**`, every one of which calls
 * `process.exit()` and expects a database.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    include: ["app/**/*.test.{ts,tsx}"],
    setupFiles: ["app/test-setup.ts"],
  },
});
