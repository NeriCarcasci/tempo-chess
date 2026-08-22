/**
 * That a backfill knows what it is about to do before it does it.
 *
 * The command touches other people's evidence, and the failure modes worth a
 * test are the quiet ones: a run selected that should not have been, a run
 * silently dropped, an interrupted batch that resumes somewhere other than
 * where it stopped, and a reconciliation that says everything is fine because
 * it never checked.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classify,
  exitCodeFor,
  OptionError,
  parseOptions,
  reconcile,
  selectRuns,
  summarise,
  type BackfillOptions,
  type RunCandidate,
  type RunOutcome,
} from "./backfill-plan.js";

const candidate = (over: Partial<RunCandidate> & { runId: string }): RunCandidate => ({
  subjectGameId: `game-${over.runId}`,
  hasManifest: false,
  ...over,
});

const options = (over: Partial<BackfillOptions> = {}): BackfillOptions => ({
  profileId: "profile-1",
  mode: "missing",
  dryRun: false,
  limit: 0,
  ...over,
});

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

test("the profile is required, because it decides whose evidence is touched", () => {
  assert.throws(() => parseOptions([], {}), OptionError);
  assert.throws(() => parseOptions([], { PROFILE_ID: "   " }), OptionError);
  assert.equal(parseOptions([], { PROFILE_ID: "p1" }).profileId, "p1");
});

test("the default mode is the safe one", () => {
  const parsed = parseOptions([], { PROFILE_ID: "p1" });
  assert.equal(parsed.mode, "missing");
  assert.equal(parsed.dryRun, false);
  assert.equal(parsed.limit, 0);
});

test("an unknown flag stops the command rather than being ignored", () => {
  // A typo in a flag that touches evidence must not silently become the
  // default. `--dryrun` is one keystroke from `--dry-run` and means the
  // opposite thing.
  assert.throws(() => parseOptions(["--dryrun"], { PROFILE_ID: "p1" }), OptionError);
  assert.throws(() => parseOptions(["--limit=all"], { PROFILE_ID: "p1" }), OptionError);
  assert.throws(() => parseOptions(["--limit=0"], { PROFILE_ID: "p1" }), OptionError);
});

test("the flags that exist do what they say", () => {
  const parsed = parseOptions(["--dry-run", "--verify", "--limit=25"], { PROFILE_ID: "p1" });
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.mode, "verify");
  assert.equal(parsed.limit, 25);
});

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

test("a missing manifest is selected without an assessment precondition", () => {
  assert.equal(classify(candidate({ runId: "a" })), "detect");
  assert.equal(classify(candidate({ runId: "b" })), "detect");
  assert.equal(classify(candidate({ runId: "c", hasManifest: true })), "verify");
});

test("the default mode selects every run that has never been measured", () => {
  const { selected, skipped } = selectRuns([
    candidate({ runId: "a" }),
    candidate({ runId: "b", hasManifest: true }),
    candidate({ runId: "c" }),
  ], options());
  assert.deepEqual(selected.map((run) => run.runId), ["a", "c"]);
  assert.equal(skipped.verify, 1);
});

test("verify mode adds measured runs and zero-assessment runs", () => {
  const { selected } = selectRuns([
    candidate({ runId: "a" }),
    candidate({ runId: "b", hasManifest: true }),
    candidate({ runId: "c" }),
  ], options({ mode: "verify" }));
  assert.deepEqual(selected.map((run) => run.runId), ["a", "b", "c"]);
});

test("an interrupted batch resumes where it stopped", () => {
  // Two properties together. The order does not move between invocations, and
  // a run that completed carries a manifest so the default mode no longer
  // selects it. Without the first, a resumed batch redoes arbitrary runs and
  // skips others forever.
  const all = ["c", "a", "d", "b"].map((runId) => candidate({ runId }));
  const first = selectRuns(all, options({ limit: 2 }));
  assert.deepEqual(first.selected.map((run) => run.runId), ["a", "b"]);

  const afterFirstPass = all.map((run) =>
    first.selected.some((done) => done.runId === run.runId)
      ? { ...run, hasManifest: true }
      : run);
  const second = selectRuns(afterFirstPass, options({ limit: 2 }));
  assert.deepEqual(second.selected.map((run) => run.runId), ["c", "d"]);
});

test("a second completed pass selects nothing", () => {
  const done = ["a", "b"].map((runId) => candidate({ runId, hasManifest: true }));
  assert.deepEqual(selectRuns(done, options()).selected, []);
});

test("the limit bounds the batch without losing count of the rest", () => {
  const all = ["a", "b", "c", "d", "e"].map((runId) => candidate({ runId }));
  const { selected, skipped } = selectRuns(all, options({ limit: 2 }));
  assert.equal(selected.length, 2);
  assert.equal(skipped.detect, 3, "the three left over are counted, not forgotten");
});

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

const counts = { opportunities: 0, censored: 0, unregisteredConcept: 0, unrecordableDraft: 0, byConcept: {} };

test("every selected run is completed, abstained, named for a new run, or failed", () => {
  const outcomes: RunOutcome[] = [
    { kind: "completed", runId: "a", checksum: "x", opportunities: 3, censored: 1 },
    { kind: "abstained", runId: "b", reason: "no_assessed_transitions" },
    { kind: "needs_new_run", runId: "c" },
    { kind: "failed", runId: "d", code: "boom" },
  ];
  const report = summarise(5, { detect: 0, verify: 1 }, outcomes, counts);
  assert.equal(report.eligible, 4);
  assert.deepEqual(reconcile(report), { ok: true, problems: [] });
  assert.equal(exitCodeFor(report, true, true), 1, "a real failed run takes precedence");
});

test("an abstained run is named but is not complete success", () => {
  const report = summarise(1, { detect: 0, verify: 0 }, [
    { kind: "abstained", runId: "a", reason: "malformed_transition_evidence" },
  ], counts);
  assert.equal(exitCodeFor(report, true, true), 2);
});

test("a dry run accounts for selected runs as planned, never completed", () => {
  const report = summarise(
    3,
    { detect: 1, verify: 0 },
    [],
    counts,
    2,
  );
  assert.equal(report.eligible, 2);
  assert.equal(report.planned, 2);
  assert.equal(report.completed, 0);
  assert.deepEqual(reconcile(report), { ok: true, problems: [] });
});

test("a run that vanished without an outcome is caught", () => {
  // The failure this exists for: a backfill that loses runs silently is worse
  // than one that does not run, because it reports success.
  const report = summarise(2, { detect: 0, verify: 0 }, [], counts);
  report.eligible = 2;
  const check = reconcile(report);
  assert.equal(check.ok, false);
  assert.match(check.problems.join(" "), /vanished without an outcome/);
});

test("runs considered must equal those selected plus those skipped", () => {
  const report = summarise(10, { detect: 1, verify: 1 }, [
    { kind: "completed", runId: "a", checksum: null, opportunities: 0, censored: 0 },
  ], counts);
  const check = reconcile(report);
  assert.equal(check.ok, false, "10 considered, 1 selected and 3 skipped does not add up");
});

test("a run needing a new analysis run is not counted as a failure", () => {
  // It is the expected answer for a game measured under an older catalogue, and
  // counting it as a failure would make a healthy backfill look broken and
  // hide the ones that really did fail.
  const report = summarise(1, { detect: 0, verify: 0 }, [
    { kind: "needs_new_run", runId: "a" },
  ], counts);
  assert.equal(report.failed, 0);
  assert.equal(report.needsNewRun, 1);
  assert.equal(reconcile(report).ok, true);
  assert.equal(
    exitCodeFor(report, true, true),
    2,
    "operator action is outstanding, so automation must not read this as complete success",
  );
});
