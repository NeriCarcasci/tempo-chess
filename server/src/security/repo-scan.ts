/**
 * Tracked-file scanning, shared by the forbidden-scope gate and the two role
 * assertions that are about the repository rather than the database.
 *
 * The scan is over `git ls-files`, not a directory walk: what matters is what the
 * branch actually commits. Build output, node_modules, and anything ignored are
 * out of scope by construction.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The commit E01 was merged to `main` at.
 *
 * E01's addition rules — "this branch did not add X" — are claims about E01's
 * own diff. Read against a later epic's working tree they stop testing E01 and
 * start forbidding every successor from doing its own scope, so the rules that
 * judge additions read the repository as it stood here. Rules about secrets
 * still scan the current tree: a credential committed anywhere is committed.
 */
export const E01_HEAD_COMMIT = "3bd676b7dd46c3078fef2df1d6150194afbbb648";

export interface ScanHit {
  file: string;
  line: number;
  /** Already truncated; callers put this in evidence. */
  text: string;
}

/** Repository root, from the gate's working directory. */
export function repoRoot(from: string = process.cwd()): string {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: from,
    encoding: "utf8",
  }).trim();
  return resolve(root);
}

export function trackedFiles(root: string): string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter((path) => path.length > 0);
}

const BINARY_EXTENSIONS = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|eot|pdf|zip|gz|wasm|nnue)$/i;
const MAX_SCAN_BYTES = 4 * 1024 * 1024;

/** Read a tracked text file, or `null` when it is binary or too large to scan. */
export function readTextFile(root: string, file: string): string | null {
  if (BINARY_EXTENSIONS.test(file)) return null;
  const path = `${root}/${file}`;
  try {
    if (statSync(path).size > MAX_SCAN_BYTES) return null;
    const raw = readFileSync(path);
    // A NUL byte in the first block is the usual "this is not text" signal.
    if (raw.subarray(0, 8000).includes(0)) return null;
    return raw.toString("utf8");
  } catch {
    return null;
  }
}

export interface ScanOptions {
  /** Exact tracked paths to skip. */
  excludeFiles?: readonly string[];
  /** Path prefixes to skip. */
  excludePrefixes?: readonly string[];
  /** Read file content as it stood at this commit instead of on disk. */
  at?: string;
}

/** Read a tracked text file as it stood at `commit`, or `null` if it was absent. */
export function readTextFileAt(root: string, file: string, commit: string): string | null {
  if (BINARY_EXTENSIONS.test(file)) return null;
  try {
    const raw = execFileSync("git", ["show", `${commit}:${file}`], {
      cwd: root,
      encoding: "buffer",
      maxBuffer: MAX_SCAN_BYTES,
    });
    if (raw.subarray(0, 8000).includes(0)) return null;
    return raw.toString("utf8");
  } catch {
    return null;
  }
}

/** Paths tracked at `commit`. */
export function trackedFilesAt(root: string, commit: string): string[] {
  return execFileSync("git", ["ls-tree", "-r", "-z", "--name-only", commit], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter((path) => path.length > 0);
}

function excluded(file: string, options: ScanOptions): boolean {
  if (options.excludeFiles?.includes(file)) return true;
  return options.excludePrefixes?.some((prefix) => file.startsWith(prefix)) ?? false;
}

/** Every tracked line matching `pattern`, outside the named exclusions. */
export function scanTracked(
  root: string,
  pattern: RegExp,
  options: ScanOptions = {},
  files: readonly string[] = trackedFiles(root),
): ScanHit[] {
  const hits: ScanHit[] = [];
  for (const file of files) {
    if (excluded(file, options)) continue;
    const content = options.at
      ? readTextFileAt(root, file, options.at)
      : readTextFile(root, file);
    if (content === null) continue;
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      // `lastIndex` would carry between lines on a /g pattern.
      const matcher = new RegExp(pattern.source, pattern.flags.replace("g", ""));
      if (matcher.test(lines[index])) {
        hits.push({ file, line: index + 1, text: lines[index].trim().slice(0, 160) });
      }
    }
  }
  return hits;
}

/** Tracked paths whose name matches `pattern`. */
export function scanPaths(
  root: string,
  pattern: RegExp,
  options: ScanOptions = {},
  files: readonly string[] = trackedFiles(root),
): string[] {
  return files.filter((file) => !excluded(file, options) && pattern.test(file));
}

/**
 * An executable operational path for the migration role: a credential, a
 * connection string, an environment binding, or a command that would run as it.
 * Naming the role in the frozen migration, in documentation, or as a constant a
 * probe compares against is not an operational path.
 */
const MIGRATOR_OPERATIONAL_PATTERNS: readonly RegExp[] = [
  /postgres(?:ql)?:\/\/forma_migrator/i,
  /\bforma_migrator\s*:\s*[^@\s]+@/i,
  /\b[A-Z0-9_]*MIGRATOR[A-Z0-9_]*_(?:URL|PASSWORD|SECRET|DSN)\b/,
  /\bPGUSER\s*=\s*forma_migrator/i,
  /--user(?:name)?[= ]forma_migrator/i,
  /\bas\s+forma_migrator\b/i,
];

/**
 * E01's contract is that *E01* left the migration role inert. Later epics give
 * it the operational path that is their outcome, so the scan reads E01's tree.
 */
export function scanMigratorOperationalPaths(
  root: string,
  commit: string = E01_HEAD_COMMIT,
): ScanHit[] {
  const files = trackedFilesAt(root, commit);
  const hits: ScanHit[] = [];
  for (const pattern of MIGRATOR_OPERATIONAL_PATTERNS) {
    hits.push(...scanTracked(root, pattern, { at: commit }, files));
  }
  // Any environment file that names the role at all is a credential surface.
  for (const file of files) {
    if (!/(^|\/)\.env(\.|$)/.test(file)) continue;
    const content = readTextFileAt(root, file, commit);
    if (content && /forma_migrator/i.test(content)) {
      hits.push({ file, line: 0, text: "environment file names forma_migrator" });
    }
  }
  return dedupe(hits);
}

export function dedupe(hits: readonly ScanHit[]): ScanHit[] {
  const seen = new Set<string>();
  const unique: ScanHit[] = [];
  for (const hit of hits) {
    const key = `${hit.file}:${hit.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(hit);
  }
  return unique.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
}

export function describeHits(hits: readonly ScanHit[]): string[] {
  return hits.map((hit) => `${hit.file}:${hit.line}`);
}
