/**
 * The eight safe-error assertions for the rehearsal.
 *
 * Each one takes a distinct sensitive payload class, pushes it through the two
 * paths a failure can escape by — the process log and the client response — and
 * requires it to survive neither. The live API's own captured output is checked
 * as well, so a payload that leaks through some other serialiser in the running
 * process is caught rather than assumed away.
 */

import type { AssertionBody } from "../assertions.js";
import { GENERIC_CLIENT_MESSAGE, redactError, safeClientMessage } from "../redaction.js";
import {
  SYNTHETIC_API_KEY,
  SYNTHETIC_BEARER_TOKEN,
  SYNTHETIC_DATABASE_URL,
  SYNTHETIC_FEN,
  SYNTHETIC_JWT,
  SYNTHETIC_PASSWORD,
  SYNTHETIC_PGN,
  SYNTHETIC_PROVIDER_PAYLOAD,
  SYNTHETIC_ROW_PAYLOAD,
  SYNTHETIC_SQL,
} from "../fixtures/synthetic-credentials.js";

/** The running API's captured stdout and stderr. */
export type LogReader = () => string;

function requireAbsent(text: string, forbidden: readonly string[], context: string): void {
  for (const needle of forbidden) {
    if (needle.length > 0 && text.includes(needle)) {
      throw new Error(`${context} still contains ${needle.slice(0, 24)}...`);
    }
  }
}

function body(
  label: string,
  build: () => unknown,
  forbidden: readonly string[],
  logs: LogReader,
): AssertionBody {
  return async () => {
    const error = build();
    requireAbsent(redactError(error), forbidden, "log output");
    const client = safeClientMessage(error);
    requireAbsent(client, forbidden, "client body");
    if (client !== GENERIC_CLIENT_MESSAGE) {
      throw new Error("an uncurated failure produced a non-generic client message");
    }
    // The live process must not have emitted the payload either.
    requireAbsent(logs(), forbidden, "running API output");
    return `${label} removed from log output, client body, and the running API's output`;
  };
}

export function safeErrorBodies(logs: LogReader): Map<string, AssertionBody> {
  return new Map<string, AssertionBody>([
    [
      "Postgres URL password",
      body(
        "database URL and password",
        () => new Error(`connection failed: ${SYNTHETIC_DATABASE_URL}`),
        [SYNTHETIC_PASSWORD, SYNTHETIC_DATABASE_URL],
        logs,
      ),
    ],
    [
      "Bearer token",
      body(
        "bearer token and header",
        () => new Error(`upstream rejected Bearer ${SYNTHETIC_BEARER_TOKEN}`),
        [SYNTHETIC_BEARER_TOKEN],
        logs,
      ),
    ],
    ["JWT", body("JWT", () => new Error(`token ${SYNTHETIC_JWT} expired`), [SYNTHETIC_JWT], logs)],
    [
      "API key",
      body("API key", () => new Error(`key ${SYNTHETIC_API_KEY} refused`), [SYNTHETIC_API_KEY], logs),
    ],
    [
      "SQL text",
      body(
        "SQL text and driver detail",
        () =>
          Object.assign(new Error(`error running ${SYNTHETIC_SQL}`), {
            detail: "Key (email)=(someone@synthetic.invalid) already exists.",
            table_name: "profiles",
            column_name: "email",
          }),
        [SYNTHETIC_SQL, "someone@synthetic.invalid", "Key (email)"],
        logs,
      ),
    ],
    [
      "row payload",
      body(
        "row values",
        () => new Error(`row rejected: ${SYNTHETIC_ROW_PAYLOAD}`),
        [SYNTHETIC_ROW_PAYLOAD, "someone@synthetic.invalid"],
        logs,
      ),
    ],
    [
      "provider payload",
      body(
        "provider body",
        () => new Error(`provider said ${SYNTHETIC_PROVIDER_PAYLOAD}`),
        [SYNTHETIC_PROVIDER_PAYLOAD, "synthetic-player"],
        logs,
      ),
    ],
    [
      "PGN/FEN",
      body(
        "PGN and FEN payloads",
        () => new Error(`parse failed for ${SYNTHETIC_PGN} at ${SYNTHETIC_FEN}`),
        [SYNTHETIC_PGN, SYNTHETIC_FEN],
        logs,
      ),
    ],
  ]);
}
