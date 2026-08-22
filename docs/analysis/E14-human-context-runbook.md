# E14 — calibrated human context and practical counterplay

What this epic adds, what it measured, what it is allowed to say, and how to
withdraw it.

## The separation, in one paragraph

Stockfish says what is true. A human model says what a player of a stated
strength is likely to play. Those are different claims, and E14 keeps them
apart in the schema rather than in a convention: human output lives in
`analysis.model_inferences`, objective output lives in
`analysis.position_evaluations`, and a trigger on each refuses the other's rows.
The practical layer is a separate table keyed by the objective assessment, so it
can be recomputed under a new calibration or withdrawn entirely without
rewriting one objective row.

## What was promoted

`maia-1.0` — the nine CSSLab Maia networks (bands 1100–1900), executed through
Lc0 v0.32.1 at one node with `--policy-softmax-temp=1.0`.

One node is deliberate. Maia's claim is in its policy head; letting Lc0 search
would blend a human prior with a machine's tree and produce a distribution that
is neither. The softmax temperature is set to 1.0 because Lc0's default of 1.359
is tuned for its own search and would flatten probabilities we then report as
calibrated.

### Licence

GPL-3.0, reviewed and recorded in `analysis.model_licence_reviews` before the
profile was allowed to claim `cleared` — a trigger enforces that order. Forma
runs unmodified binaries and weights as a separate process over UCI and does not
link against either, so no combined work is created, and nothing is
redistributed. **If Forma ever ships the Lc0 binary or the Maia weights to a
user, the corresponding source must be offered under the same licence.** The
distribution posture on file is `server_side_only`; changing it is a licence
decision, not a deployment detail.

### The holdout

7,810 positions from 1,317 public Lichess games and 817 distinct accounts,
sampled by `holdout_sampling_v1`: rated standard blitz and rapid, plies 10–120,
at most 8 positions per game, thinned by hash of `game:ply`.

- Manifest `4f62ec471c718113546780abdff281c689f0c2d605e125b0f5e26a778b95d932`.
- Body stored as an artifact in the private `system-artifacts` bucket. The
  corpus is **not** reproducible from the Lichess API — arena games roll off —
  so the body is the evidence and the hash only addresses it.
- Earliest game 2026-06-19, which is years after Maia's published training
  window.
- Account-disjoint **between slices**: no account contributes to two rating
  bands. Accounts that straddled a band boundary mid-corpus were dropped rather
  than assigned to one, because a player who crossed is evidence about neither.

Book plies are excluded on purpose. Opening moves are recalled rather than
chosen, and scoring a human model on them measures memorization and flatters
every model equally. This makes the accuracy numbers below *lower* than
published Maia figures, which include the opening.

**The limitation that is not solved:** disjointness from Maia's own training
accounts cannot be verified. The corpus that produced a public model is not
enumerable by us. The chronological gap is the mitigation, and this limitation
is recorded on the dataset row rather than assumed away.

### What passed

Seven slices out of twenty-two, over 7,810 positions, with zero inference
failures and a p95 inference latency of 3 ms:

| slice | n | accounts | top-1 | ECE | Brier |
| --- | --- | --- | --- | --- | --- |
| lichess blitz 1200–1300 | 536 | 39 | 0.418 | 0.036 | 0.202 |
| lichess blitz 1700–1800 | 671 | 80 | 0.414 | 0.074 | 0.215 |
| lichess blitz 1800–1900 | 762 | 67 | 0.444 | 0.056 | 0.215 |
| lichess blitz 1900–2000 | 709 | 76 | 0.465 | 0.072 | 0.215 |
| lichess blitz 2000–2100 | 474 | 53 | 0.496 | 0.039 | 0.211 |
| lichess blitz 2100–2200 | 514 | 30 | 0.465 | 0.074 | 0.213 |
| lichess rapid 1600–1700 | 460 | 39 | 0.450 | 0.056 | 0.207 |

The other fifteen slices are recorded as unsupported with their reasons — mostly
sample size, one on accuracy (blitz 1400–1500 reached 0.362 against a 0.4
floor), several on calibration error. Positions in those slices return
`practical_context_status: unavailable`, never a weakened Stockfish number.

Thresholds live in `PROMOTION_THRESHOLDS` in `server/src/models/contract.ts` and
are hashed into the calibration component version. They were fixed before the
benchmark ran. Changing one produces a new calibration version and a new shadow
comparison; it does not re-label existing evidence.

## What a reader gets

Every move in a published review carries a `practicalContext` field. It is
either a refusal with a reason, or a vector:

- adequate reply count and the policy mass on those replies;
- **practical pressure as an interval, not a number.** The upper bound is
  `1 - adequateReplyProbability` and assumes every move the model did not retain
  was a bad one; the lower bound assumes every one of them was adequate. Quoting
  either alone is an assumption presented as a measurement;
- policy entropy, flagged as a lower bound whenever mass was dropped;
- the best objective reply's probability and rank in the opponent's policy, or
  nulls when the model did not retain it at all — which is itself the finding;
- `outOfDomain` when the rating that conditions the answer falls outside the
  band the cited slice measured;
- `opponentConceded` and `subjectCapitalized`, which are **separate evidence**.
  An opponent failing later does not make an objectively bad move brilliant in
  retrospect, so they sit beside the prediction and are never folded into it.

## Running it again

```
npm run models:holdout -- --out=holdout.jsonl --target=800
npm run models:benchmark -- --corpus=holdout.jsonl --engine=<lc0> --weights=<dir>
npm run models:promote -- --report=benchmark-result.json --corpus=holdout.jsonl
```

`models:promote` without `--apply` prints what it would write and exits. With
`--apply` and `DATABASE_URL` set it writes, in the order the schema requires:
licence review, model version, assets, profile, dataset, validation run,
metrics, calibration slices, and only then the lifecycle pointer. Set
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` as well or the corpus body is not
stored and the run says so.

Re-running is idempotent by content hash: the same corpus and the same networks
find the rows they already made. Reusing a dataset key for a *different* corpus
is refused rather than silently re-labelled — that is a new version.

## Serving it

The practical-context step runs as `analysis_practical_context` on the
`analysis` queue with resource class `cpu_model`, which E05 gave to
`forma-analysis` with the `model_inference` capability. **No topology change was
needed**, which is what having written the table down bought.

The worker needs two environment values:

- `MAIA_ENGINE_PATH` — the Lc0 binary.
- `MAIA_WEIGHTS` — `1100=/path/maia-1100.pb.gz,1200=/path/...`, one per band.

**Neither is set on the deployed image yet.** Until the image carries Lc0 and
the weights, `resolveHumanPolicyEngine()` returns null, every position becomes
`inference_failed`, the run still succeeds, and the objective review is
unaffected. That is the intended degraded state and not a fault to page on — but
it is also the reason the feature is not yet visible in production. Adding the
binary to the worker image is the next step, and it is an image change, not a
code change.

The Maia-1/Lc0 deployment path remains intentionally inactive. New CPU-only
continuation work uses Maia-3 5M and is documented in
`docs/analysis/maia3-continuations.md`; it requires its own benchmark and
production lifecycle event and may not reuse this Maia-1 calibration.

## Withdrawing it

Three levers, in increasing severity. None of them rewrites a result.

1. **Roll back the pointer.** Append a `component_lifecycle_events` row moving
   the model to `retired` (or promote a previous version). `resolvePromotedHumanModel`
   then returns null and every new row is `no_promoted_model`. Existing rows are
   untouched — they record what was true when they were written.
2. **Withdraw a slice.** Register a new calibration component version whose
   slice rows say `supported = false` with a reason. Positions in that slice
   become `slice_unsupported`. The old rows remain and remain readable.
3. **Stop serving it.** Unset `MAIA_ENGINE_PATH`. Every position becomes
   `inference_failed`. Use this when the model is misbehaving and you want it
   off now; use (1) when the decision is that it should not have been promoted.

There is no lever that edits a practical claim in place, deliberately. The
tables are immutable by trigger.

## Gates

| Gate | What it proves | Where it runs |
| --- | --- | --- |
| `models:unit` | 53 offline invariants: bands, distributions, bounds, refusals, the promotion gate | anywhere |
| `models:integration` | end to end on a disposable Postgres, including the refusal record | CI (needs Postgres) |
| `models:security` | grants, tenancy, and that no telemetry line carries a rating | CI (needs Postgres) |
| `models:migration` | 0027 from empty, from a 0026 database with rows, and twice | CI (needs Postgres) |
| `models:performance` | counts asserted, wall-clock advisory | CI (needs Postgres) |
| `models:live` | 17 checks against the live project, every destructive probe in a rolled-back savepoint | with `DATABASE_URL` |

## Migration

`0027_e14_practical_context` — eight tables, three triggers, additive and
forward-only. Applied to the live project; ledger 28.

One trigger lands on a table E12 owns: `model_profiles_licence_reviewed` refuses
a new profile that claims a cleared licence with no review behind it. It fires
before insert only, so the row E12 already wrote — Stockfish, cleared, from
before the review table existed — is untouched. `registerEngineComponents` now
writes Stockfish's review row before its profile, so the invariant holds going
forward for both models.
