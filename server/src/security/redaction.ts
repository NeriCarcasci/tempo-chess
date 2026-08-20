import { createHash } from "node:crypto";

/**
 * Safe errors for E01.
 *
 * The design rule here is allowlist, not denylist. An earlier version scrubbed
 * known secret *shapes* out of an error message and let the rest through, which
 * is only as good as the pattern list: an unrecognised payload — a bare email, a
 * provider's plain-text reason, an internal marker — survived intact. So no free
 * text from an exception reaches a log line or a database column any more. What
 * reaches them is a classification drawn from a closed set. Curated messages
 * are client-only: their explicit marker preserves the legacy response body,
 * but never makes their text safe for a process log.
 *
 * Three exits are covered, because a payload only has to escape through one:
 *
 *   - `redactError()` builds the *log* line;
 *   - `safeClientMessage()` decides what a caller may read;
 *   - `persistableError()` decides what may be written to a row.
 *
 * Pattern redaction is kept underneath the client path as defence in depth for
 * curated strings and anything a caller interpolates into one.
 *
 * This is redaction only. E01 introduces no problem-details document, no error
 * codes on the wire, and no request IDs — those belong to E03, and the two frozen
 * legacy bodies in `contract.ts` stay byte-for-byte as they are.
 */

/** What a caller sees when the underlying failure is not a curated message. */
export const GENERIC_CLIENT_MESSAGE = "Something went wrong. Try again in a moment.";

/**
 * Bumped whenever the classification set or the redaction rules change, so a
 * retained observation can be tied to the policy that produced it. Recorded in
 * the evidence manifest alongside a content hash of the rules themselves.
 */
export const REDACTION_VERSION = "e01-redaction-3";

/**
 * Errors whose message was written for a human caller and contains only that
 * caller's own input. Marking is explicit: nothing is user-facing by default.
 */
export abstract class CuratedError extends Error {
  readonly safeClientMessage = true as const;
}

export function isCurated(error: unknown): error is CuratedError {
  return error instanceof CuratedError;
}

/**
 * The closed set of failure classifications. Nothing outside this list can be
 * logged or persisted, so a new failure mode shows up as `unknown` rather than
 * as whatever text the underlying library happened to produce.
 */
export const ERROR_CLASSES = [
  "config_rejected",
  "identity_failed",
  "db_unavailable",
  "db_permission_denied",
  "db_constraint",
  "db_error",
  "provider_unavailable",
  "provider_rejected",
  "auth_required",
  "not_found",
  "validation_failed",
  "timeout",
  "cancelled",
  "unknown",
] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];

/** Postgres SQLSTATE class prefixes we can name without reading any message text. */
function classifyPostgres(code: string): ErrorClass | undefined {
  if (code === "42501") return "db_permission_denied";
  if (code.startsWith("23")) return "db_constraint";
  if (code.startsWith("08") || code === "57P01" || code === "57P03") return "db_unavailable";
  if (code.startsWith("42")) return "db_error";
  return undefined;
}

/** Node/undici transport codes. Also message-free. */
function classifyTransport(code: string): ErrorClass | undefined {
  if (["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ECONNRESET", "EPIPE"].includes(code)) {
    return "db_unavailable";
  }
  if (["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT"].includes(code)) {
    return "timeout";
  }
  return undefined;
}

/**
 * Classify a failure from its *structure* — constructor name, SQLSTATE, syscall
 * code, HTTP status — never from its message text. That is the whole point: the
 * message is exactly the part that cannot be trusted.
 */
export function classifyError(error: unknown): ErrorClass {
  if (error === null || error === undefined) return "unknown";
  const carrier = error as Record<string, unknown>;

  const name = error instanceof Error ? error.name : "";
  if (name === "RuntimeConfigError" || name === "CorsConfigError") return "config_rejected";
  if (name === "RuntimeIdentityError") return "identity_failed";
  if (name === "AssertionTimeout" || name === "TimeoutError") return "timeout";
  if (name === "AbortError") return "cancelled";
  if (name === "AccountError") return "validation_failed";
  if (name === "LookupUnavailable") return "provider_unavailable";

  const code = typeof carrier.code === "string" ? carrier.code : "";
  if (code) {
    const postgres = classifyPostgres(code);
    if (postgres) return postgres;
    const transport = classifyTransport(code);
    if (transport) return transport;
  }

  const status = typeof carrier.status === "number" ? carrier.status : undefined;
  if (status === 401 || status === 403) return "auth_required";
  if (status === 404) return "not_found";
  if (status !== undefined && status >= 500) return "provider_unavailable";
  if (status !== undefined && status >= 400) return "provider_rejected";

  if (error instanceof TypeError || error instanceof RangeError) return "validation_failed";
  return "unknown";
}

interface Rule {
  readonly kind: string;
  readonly pattern: RegExp;
}

/**
 * Defence in depth for the text that *is* allowed through: curated messages, and
 * anything a caller interpolated into one. Order matters — credentials and tokens
 * are removed before the broader payload and statement rules run, so a secret
 * embedded in a JSON body or a SQL string is caught by its own specific rule.
 */
const RULES: readonly Rule[] = [
  { kind: "database-url", pattern: /\bpostgres(?:ql)?:\/\/\S+/gi },
  { kind: "credentialed-url", pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@'"]+:[^\s/@'"]+@\S+/gi },
  { kind: "bearer", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi },
  { kind: "jwt", pattern: /\b[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g },
  { kind: "api-key", pattern: /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]+/g },
  { kind: "api-key", pattern: /\bsbp_[A-Za-z0-9]{16,}/g },
  {
    kind: "credential",
    pattern:
      /\b(?:password|passwd|secret|api[_-]?key|apikey|access[_-]?token|service[_-]?role[_-]?key)\b\s*[=:]\s*['"]?[^\s'",;}]+/gi,
  },
  { kind: "email", pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  {
    kind: "fen",
    pattern:
      /\b(?:[rnbqkpRNBQKP1-8]{1,8}\/){7}[rnbqkpRNBQKP1-8]{1,8}\s+[wb]\s+(?:[KQkq]{1,4}|-)\s+(?:[a-h][36]|-)\s+\d+\s+\d+/g,
  },
  { kind: "pgn-tag", pattern: /\[[A-Z][A-Za-z]*\s+"[^"]*"\]/g },
  { kind: "pgn", pattern: /(?:\b\d+\.\s*\S+(?:\s+\S+)?\s*){2,}/g },
  { kind: "payload", pattern: /\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\}/g },
  {
    kind: "sql",
    pattern:
      /\b(?:select\b[\s\S]*?\bfrom\b|insert\s+into|update\s+\w+\s+set|delete\s+from|grant\b|revoke\b|alter\s+table|create\s+policy|drop\s+policy)[^\n;]*/gi,
  },
  { kind: "sql-detail", pattern: /\b(?:detail|hint|where|query|schema|table|column|constraint):\s*[^\n]*/gi },
];

/** A stable SHA-256 of the rule set, recorded beside `REDACTION_VERSION`. */
export function redactionPolicySha256(): string {
  const source = [
    REDACTION_VERSION,
    ...ERROR_CLASSES,
    ...RULES.map((rule) => `${rule.kind}:${rule.pattern.source}:${rule.pattern.flags}`),
  ].join("\n");
  return createHash("sha256").update(source).digest("hex");
}

/** Scrub text that is already allowed through. Structure survives; secrets do not. */
export function redact(value: unknown): string {
  let text = typeof value === "string" ? value : String(value);
  for (const rule of RULES) {
    text = text.replace(rule.pattern, `[redacted:${rule.kind}]`);
  }
  return text;
}

/**
 * The log line for a failure.
 *
 * Structure only: a closed-set error type, its classification, the chain of
 * causes' classifications, and where in this program it was thrown. No
 * exception message reaches this string — curated messages are safe for their
 * intended client only, not for shared logs.
 *
 * The call site is part of the structure, and leaving it out cost real time:
 * `RangeError/validation_failed`, repeated sixty-one times, says a thing went
 * wrong and refuses to say where, so the only way to find it was to reason
 * about which line in the program could raise that name. A file and a line
 * number are facts about this repository — they are in the stack trace of any
 * crash, in the source map, and in the git history. They are not facts about
 * the person whose game was being analysed, which is what redaction is for.
 */
export function redactError(error: unknown, depth = 0): string {
  if (depth > 8) return "[redacted:depth-limit]";
  const parts: string[] = [];
  if (error instanceof Error) {
    parts.push(`${sanitiseName(error.name)}/${classifyError(error)}`);
    const site = throwSite(error);
    if (site) parts.push(`at ${site}`);
    if (error instanceof AggregateError) {
      for (const inner of error.errors) parts.push(redactError(inner, depth + 1));
    }
    if (error.cause !== undefined) parts.push(`caused by ${redactError(error.cause, depth + 1)}`);
  } else {
    parts.push(`${typeof error}/${classifyError(error)}`);
  }
  return parts.join(" | ");
}

/**
 * Where it was thrown, as this program's own frames.
 *
 * The stack's first line is `Name: message`, which is exactly what must not be
 * logged, so it is never read. Only frames pointing inside the application are
 * kept -- a `node_modules` or `node:internal` frame names somebody else's line
 * number and is noise here -- and only the first three, because the fourth
 * rarely changes the answer.
 */
function throwSite(error: Error): string | null {
  const stack = typeof error.stack === "string" ? error.stack : "";
  const frames: string[] = [];
  for (const line of stack.split("\n").slice(1)) {
    // Two shapes, because V8 omits the parentheses when the frame has no
    // function name: `at name (file:line:col)` and `at file:line:col`.
    const trimmed = line.trim();
    const match =
      /\((?:file:\/\/)?([^()]*?):(\d+):\d+\)$/.exec(trimmed)
      ?? /^at (?:file:\/\/)?([^()\s]*?):(\d+):\d+$/.exec(trimmed);
    if (!match) continue;
    const [, file, lineNumber] = match;
    if (file === undefined || lineNumber === undefined) continue;
    if (file.includes("node_modules") || file.startsWith("node:")) continue;
    // Relative to the source root, and either separator: the container builds
    // to `/app/dist/...` and a developer's machine may hand back a Windows path.
    const relative = file.replace(/^.*[/\\](?:dist|src)[/\\]/, "").replace(/\\/g, "/");
    frames.push(`${relative}:${lineNumber}`);
    if (frames.length === 3) break;
  }
  return frames.length > 0 ? frames.join(" <- ") : null;
}

/** Error names are caller-mutable, so logs admit only this closed vocabulary. */
function sanitiseName(name: string): string {
  const allowed = new Set([
    "Error",
    "AggregateError",
    "TypeError",
    "RangeError",
    "RuntimeConfigError",
    "CorsConfigError",
    "RuntimeIdentityError",
    "AssertionTimeout",
    "TimeoutError",
    "AbortError",
    "AccountError",
    "LookupUnavailable",
  ]);
  return allowed.has(name) ? name : "Error";
}

/** What the caller is allowed to read. Curated messages only; everything else collapses. */
export function safeClientMessage(error: unknown): string {
  if (isCurated(error) && error instanceof Error) return redact(error.message);
  return GENERIC_CLIENT_MESSAGE;
}

/**
 * What may be written to a row. Import and task failures are shown to the user
 * who owns them, so they carry a classification and nothing else — never the
 * driver's or the provider's own words.
 */
export function persistableError(error: unknown): ErrorClass {
  return classifyError(error);
}

/** The one place E01 writes an error to the process log. */
export function logSafeError(context: string, error: unknown): void {
  console.error(`${context}: ${redactError(error)}`);
}
