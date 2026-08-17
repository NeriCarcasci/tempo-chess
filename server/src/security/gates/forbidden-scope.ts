/**
 * `npm run security:forbidden-scope` — 12 rules.
 *
 * These prove the branch did *not* do things. Two scan surfaces are used, and
 * the difference matters:
 *
 *   - "addition" rules scan the files this branch changed against the pinned
 *     base commit, because pre-existing code (the pipeline's in-process worker
 *     loop, for one) is not something E01 added and is not E01's to remove;
 *   - the leak rule scans every tracked file, because a secret committed
 *     anywhere is a secret committed.
 *
 * Exclusions are individually named paths, never patterns, and every rule prints
 * the exclusions it used so a reviewer can see exactly what was not scanned.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  assertionsFor,
  gateExitCode,
  loadManifest,
  runGate,
  type AssertionBody,
  type AssertionRecord,
} from "../assertions.js";
import { describeHits, readTextFile, repoRoot, scanTracked, trackedFiles, type ScanHit } from "../repo-scan.js";

const COMMAND = "cd server && npm run security:forbidden-scope";

/** The clean base this branch started from. Pinned by the contract. */
export const BASE_COMMIT = "b9b9a27585dc771b7755a07c9a28a66cce9ae520";

/**
 * Named documentation and fixture paths. Each of these exists to *describe* a
 * prohibition or to provide a deliberately secret-shaped synthetic value, so
 * matching the prohibition's own vocabulary is their job.
 */
const NAMED_DOC_EXCLUSIONS = [
  "docs/security/E01-recovery-scope.md",
  "docs/security/E01-assertion-manifest.json",
  "docs/security/E01-runbook.md",
  "docs/security/E01-handoff.md",
  "docs/security/E01-incident-note.md",
  "docs/security/E01-grant-rls-matrix.md",
  "server/src/security/fixtures/synthetic-credentials.ts",
  "server/src/security/gates/forbidden-scope.ts",
] as const;

/** Canonical inputs are committed byte-for-byte and may not be edited to please a scanner. */
const CANONICAL_PREFIXES = ["plans/"] as const;

const LEAK_SCAN_OPTIONS = {
  excludeFiles: NAMED_DOC_EXCLUSIONS,
  excludePrefixes: CANONICAL_PREFIXES,
} as const;

/**
 * The forbidden-scope gate's own retained stdout necessarily names each rule it
 * proves, including the Cloud Tasks prohibition. That exact generated file is
 * excluded only from addition-rule vocabulary scans; it remains inside the
 * leak scan below with every other evidence file.
 */
const ADDITION_SCAN_OPTIONS = {
  excludeFiles: [...NAMED_DOC_EXCLUSIONS, "evidence/E01/logs/security-forbidden-scope.stdout.log"],
  excludePrefixes: CANONICAL_PREFIXES,
} as const;

/** Files this branch added or modified relative to the pinned base. */
export function changedFiles(root: string): string[] {
  const output = execFileSync("git", ["diff", "--name-only", "--diff-filter=ACMR", BASE_COMMIT], {
    cwd: root,
    encoding: "utf8",
  });
  return output.split("\n").filter((path) => path.length > 0);
}

function formatExclusions(): string {
  return `excluding ${NAMED_DOC_EXCLUSIONS.length} named documentation/fixture paths and ${CANONICAL_PREFIXES.join(", ")}`;
}

/** Prove the leak rule itself rejects a secret-shaped value under evidence/E01. */
function assertEvidenceLeakFixtureRejected(): string {
  const path = "evidence/E01/adversarial-secret-fixture.log";
  if (
    NAMED_DOC_EXCLUSIONS.includes(path as never) ||
    CANONICAL_PREFIXES.some((prefix) => path.startsWith(prefix))
  ) {
    throw new Error("the adversarial evidence fixture is excluded from the tracked-file boundary");
  }
  const value = ["postgresql", "://", "fixture_role", ":", "fixture-password-value", "@", "db.invalid:6543/postgres"].join("");
  const rejected = SECRET_SHAPED.some((pattern) => new RegExp(pattern.source, pattern.flags.replace("g", "")).test(value));
  if (!rejected) throw new Error("a secret-shaped value in evidence/E01 was accepted by the leak predicate");
  return "adversarial secret-shaped value in evidence/E01 is rejected";
}

function rule(
  label: string,
  patterns: readonly RegExp[],
  scope: "changed" | "tracked",
  extra?: (root: string, files: readonly string[]) => ScanHit[],
): AssertionBody {
  return async () => {
    const root = repoRoot();
    const files = scope === "changed" ? changedFiles(root) : trackedFiles(root);
    const hits: ScanHit[] = [];
    for (const pattern of patterns) {
      hits.push(...scanTracked(root, pattern, ADDITION_SCAN_OPTIONS, files));
    }
    if (extra) hits.push(...extra(root, files));
    if (hits.length > 0) {
      throw new Error(`${label}: ${describeHits(hits).slice(0, 6).join(", ")}`);
    }
    return `no ${label} across ${files.length} ${scope} files, ${formatExclusions()}`;
  };
}

/** The journal must not gain a 0012 or 0013 entry either. */
function journalHasNo(root: string, tag: string): ScanHit[] {
  const journal = readTextFile(root, "server/drizzle/meta/_journal.json") ?? "";
  return journal.includes(tag)
    ? [{ file: "server/drizzle/meta/_journal.json", line: 0, text: `journal names ${tag}` }]
    : [];
}

function migrationFilesNamed(root: string, files: readonly string[], prefix: string): ScanHit[] {
  return files
    .filter((file) => new RegExp(`(^|/)${prefix}[_-]`).test(file))
    .map((file) => ({ file, line: 0, text: `migration artifact named ${prefix}` }));
}

/**
 * A general-purpose credential or deployment CLI: a committed executable that
 * exists to provision, rotate, deploy, or promote. Evidence probes that *read*
 * metadata are not that, and are recognised by never containing a mutation verb.
 */
function credentialCliFiles(root: string, files: readonly string[]): ScanHit[] {
  const suspicious = files.filter((file) =>
    /(^|\/)(cli)\//.test(file) ||
    /(rotate|provision|bootstrap|deploy|promote|apply)-(credential|owner|runtime|staging|containment|alerts|traffic)/.test(
      file,
    ),
  );
  return suspicious.map((file) => ({ file, line: 0, text: "credential/deployment CLI entrypoint" }));
}

const SECRET_SHAPED: readonly RegExp[] = [
  /\bsb_secret_[A-Za-z0-9_-]{16,}/,
  /\bsbp_[A-Za-z0-9]{20,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /postgres(?:ql)?:\/\/[^\s:@/]+:[^\s:@/]+@/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:password|passwd|api[_-]?key|secret[_-]?key|access[_-]?token)\s*[:=]\s*["'][^"'\s]{12,}["']/i,
];

/**
 * Placeholder tokens, reassembled at runtime so this file is not its own hit.
 *
 * The rule's target list is exactly the contract's: a live secret, a password, a
 * token, TO-DO, FIX-ME, a placeholder success, or an empty suite. "Placeholder"
 * alone is ordinary interface vocabulary — a form input has one — so only a
 * placeholder standing in for a *result* counts. Pre-existing code that throws
 * "not implemented" is fail-closed rather than a fake pass, and is not in scope
 * for this rule or for this epic.
 */
function placeholderPatterns(): RegExp[] {
  return [
    new RegExp(`\\b${["T", "O", "D", "O"].join("")}\\b`),
    new RegExp(`\\b${["F", "I", "X", "M", "E"].join("")}\\b`),
    /\bplaceholder\s+(?:success|pass(?:ed)?|result|assertion|evidence)\b/i,
    /\b(?:success|pass(?:ed)?|result|assertion|evidence)\s+placeholder\b/i,
  ];
}

/** Every gate command must own a positive number of assertions and a real script. */
function emptySuiteHits(root: string): ScanHit[] {
  const manifest = JSON.parse(
    readFileSync(`${root}/docs/security/E01-assertion-manifest.json`, "utf8"),
  ) as { expected_totals: Record<string, number> };
  const scripts = (
    JSON.parse(readFileSync(`${root}/server/package.json`, "utf8")) as {
      scripts: Record<string, string>;
    }
  ).scripts;
  const hits: ScanHit[] = [];
  for (const [command, total] of Object.entries(manifest.expected_totals)) {
    if (total <= 0) {
      hits.push({ file: "docs/security/E01-assertion-manifest.json", line: 0, text: `${command} has no assertions` });
    }
    const match = /npm run ([\w:-]+)/.exec(command);
    if (match && !scripts[match[1]]) {
      hits.push({ file: "server/package.json", line: 0, text: `missing script ${match[1]}` });
    }
  }
  return hits;
}

function buildRules(): Map<string, AssertionBody> {
  return new Map<string, AssertionBody>([
    [
      "migration 0012",
      rule("0012 migration file, tag, or reference", [/\b0012_/], "changed", (root, files) => [
        ...journalHasNo(root, "0012"),
        ...migrationFilesNamed(root, files, "0012"),
      ]),
    ],
    [
      "migration 0013",
      rule("0013 migration file, tag, or reference", [/\b0013_/], "changed", (root, files) => [
        ...journalHasNo(root, "0013"),
        ...migrationFilesNamed(root, files, "0013"),
      ]),
    ],
    [
      "actor helpers",
      rule(
        "actor propagation helper",
        [
          /\bauthz\.ts\b/,
          /private\.actor_id/,
          /\bset\s+local\s+\w/i,
          /set_config\(\s*['"]\w*actor/i,
          /\b(withActor|actorContext|currentActorId|propagateActor)\b/,
        ],
        "changed",
      ),
    ],
    [
      "worker",
      rule(
        "worker identity, client, or service addition",
        [
          /\bforma_worker\b/i,
          /\bworker[_-]?(identity|role|credential|client|service|pool)\b/i,
          /\bWORKER_(URL|PASSWORD|SECRET|DSN)\b/,
        ],
        "changed",
      ),
    ],
    [
      "standby",
      rule(
        "standby identity, client, or rotation addition",
        [/\bforma_standby\b/i, /\bstandby[_-]?(identity|role|credential|client|secret|rotation)\b/i, /\bSTANDBY_[A-Z_]+\b/],
        "changed",
      ),
    ],
    [
      "Cloud Tasks",
      rule(
        "Cloud Tasks dependency, configuration, or code",
        [/@google-cloud\/tasks/i, /\bcloudtasks\b/i, /\bcloud\s+tasks\b/i, /\bCloudTasksClient\b/],
        "changed",
      ),
    ],
    [
      "permanent staging topology",
      rule(
        "persistent staging project, service, or IaC",
        [
          /\bstaging[_-]?(project|service|environment|topology|url|ref)\b/i,
          /\bSTAGING_[A-Z_]+\b/,
          /\bterraform\b/i,
          /\bpulumi\b/i,
        ],
        "changed",
        (_root, files) =>
          files
            .filter((file) => /\.(tf|tfvars|tfstate)$/.test(file))
            .map((file) => ({ file, line: 0, text: "infrastructure-as-code file" })),
      ),
    ],
    [
      "role/password mutation",
      rule(
        "role or password mutation",
        [
          /alter\s+role\s+[\w".]+\s+(?:with\s+)?(?:encrypted\s+)?password/i,
          /create\s+role\s+[\w".]+[^;\n]*\bpassword\b/i,
          /\b(rotateCredential|provisionCredential|retireCredential)\b/,
          /gcloud\s+sql\s+users\s+set-password/i,
        ],
        "changed",
      ),
    ],
    [
      "secret mutation",
      rule(
        "Secret Manager mutation",
        [
          /gcloud\s+secrets\s+(create|delete|update)\b/i,
          /gcloud\s+secrets\s+versions\s+(add|destroy|disable|enable)\b/i,
          /gcloud\s+secrets\s+(add|remove)-iam-policy-binding\b/i,
          /\bsecretmanager[^\n]*\.(createSecret|addSecretVersion|setIamPolicy|destroySecretVersion)\b/i,
        ],
        "changed",
      ),
    ],
    [
      "deploy/traffic mutation",
      rule(
        "deployment, traffic, or provider mutation",
        [
          /gcloud\s+run\s+(deploy|services\s+(update|replace|delete|add-iam-policy-binding))\b/i,
          /gcloud\s+run\s+services\s+update-traffic\b/i,
          /gcloud\s+builds\s+submit\b/i,
          /\bwrangler\s+(deploy|publish)\b/i,
          /supabase\s+(db\s+push|migration\s+up|link|projects\s+create)\b/i,
        ],
        "changed",
      ),
    ],
    [
      "credential CLI",
      rule("general-purpose credential or deployment CLI", [], "changed", credentialCliFiles),
    ],
    [
      "leak/placeholders",
      async () => {
        const root = repoRoot();
        const files = trackedFiles(root);
        const hits: ScanHit[] = [];
        for (const pattern of SECRET_SHAPED) {
          hits.push(...scanTracked(root, pattern, LEAK_SCAN_OPTIONS, files));
        }
        for (const pattern of placeholderPatterns()) {
          hits.push(...scanTracked(root, pattern, LEAK_SCAN_OPTIONS, files));
        }
        hits.push(...emptySuiteHits(root));
        if (hits.length > 0) {
          throw new Error(`leak or placeholder: ${describeHits(hits).slice(0, 8).join(", ")}`);
        }
        return `no live secret, token, placeholder, or empty suite across ${files.length} tracked files, ${formatExclusions()}; ${assertEvidenceLeakFixtureRejected()}`;
      },
    ],
  ]);
}

export function buildForbiddenScopeBodies(
  records: readonly AssertionRecord[],
): Map<string, AssertionBody> {
  const rules = buildRules();
  const bodies = new Map<string, AssertionBody>();
  for (const record of records) {
    const body = rules.get(record.target);
    if (!body) throw new Error(`no forbidden-scope rule for target "${record.target}"`);
    bodies.set(record.id, body);
  }
  return bodies;
}

export async function main(): Promise<number> {
  const root = repoRoot();
  const manifest = loadManifest(root);
  const records = assertionsFor(manifest, COMMAND);
  const outcome = await runGate({
    command: COMMAND,
    records,
    bodies: buildForbiddenScopeBodies(records),
  });
  return gateExitCode(outcome);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`security:forbidden-scope failed to run: ${String(error)}\n`);
      process.exit(1);
    },
  );
}
