import "./unit-env.js";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateOpenApiDocument, serializeOpenApiDocument } from "../openapi.js";
import { V1_ROUTES } from "../routes/index.js";
import type { RouteDefinition } from "../registry.js";

/**
 * The OpenAPI drift gate.
 *
 * `npm run v1:openapi` regenerates the committed document; `--check` fails when
 * the committed bytes differ from what the registry produces. The check is the
 * point: a generated artifact that nobody verifies is a hand-maintained one
 * with extra steps.
 */

export const OPENAPI_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "openapi",
  "v1.json",
);

const serialized = serializeOpenApiDocument(
  generateOpenApiDocument(V1_ROUTES as readonly RouteDefinition<never, never, never>[]),
);

if (process.argv.includes("--check")) {
  let committed: string;
  try {
    committed = readFileSync(OPENAPI_PATH, "utf8");
  } catch {
    console.error("openapi gate: server/openapi/v1.json is missing; run `npm run v1:openapi`");
    process.exit(1);
  }
  if (committed !== serialized) {
    console.error(
      "openapi gate: the committed document does not match the route registry; run `npm run v1:openapi`",
    );
    process.exit(1);
  }
  console.log("openapi gate: committed document matches the route registry");
} else {
  writeFileSync(OPENAPI_PATH, serialized);
  console.log(`openapi: wrote ${OPENAPI_PATH}`);
}
