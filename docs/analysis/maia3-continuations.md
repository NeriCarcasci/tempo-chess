# Maia-3 CPU position continuations

Forma's continuation primitive asks a human-policy model what a player at a
stated rating might play. It is not an objective evaluation, does not write
historical game evidence, and does not restore the legacy play surface.

## Runtime

The private `forma-maia` service uses CSSLab Maia-3 5M on CPU:

- code revision `1e13597c42d4858b7cfd7cfdae01e297263364b2`;
- checkpoint revision `b6559de2398d7140b985f28fd2c19fb5e47ddabe`;
- checkpoint SHA-256
  `ba14208b2992d85502f5fb501934abf6aaaeb355e9f3fdf90e326911f562524f`;
- PyTorch CPU wheel only, AMP disabled, one OpenMP/MKL thread;
- strengths exposed by Forma: 800, 1000, 1200, 1400, 1600, 1800, 2000,
  2200 and 2400. Other values are rejected at both the API and worker boundary so
  equivalent requests share the same rating-conditioned policy cache.

The optional Docker target is `maia-production`. The default final target
remains the lean service image, so API, ingestion and Stockfish cold starts do
not pay for Python or PyTorch. `cloudbuild.maia3.yaml` builds only the Maia target.

The container sets:

```text
MAIA3_PYTHON_PATH=/opt/maia3-venv/bin/python
MAIA3_BRIDGE_PATH=/app/maia3/bridge.py
MAIA3_CHECKPOINT_PATH=/opt/forma/maia3/maia3-5m.pt
OMP_NUM_THREADS=1
MKL_NUM_THREADS=1
```

The bridge is a long-lived JSON-lines subprocess. It loads the checkpoint once
and returns the complete legal-move policy. Node serializes calls to the process
because its board state is mutable.

## API and work flow

`POST /v1/positions/continuations` requires authentication and an
`Idempotency-Key`:

```json
{
  "fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  "rating": 1600,
  "turnKey": "session_a1b2_turn_0001"
}
```

A cached policy returns HTTP 200 with `moveUci` and the five most likely moves.
A cache miss returns HTTP 202 with a workflow. Poll the normal workflow endpoint
and submit the position again with a fresh HTTP idempotency key after it
succeeds. Keep `turnKey` unchanged: it is the stable seed that guarantees a
retry cannot choose a different move.

The cache identity contains the promoted model component and content hashes,
canonical core position, rating context and retention contract. The stored
inference is anonymous and reusable. The turn key is not stored. At most one
model job is scheduled for a cache identity even when several players ask at
once.

Positions are legal standard chess only. Terminal positions are refused. This
first contract is position-conditioned and records `hasMoveHistory=false`; move
history must not be added later without a new input contract and cache key.

`POST /v1/play/moves` is the product-facing opponent boundary. Stockfish is
answered synchronously; a Maia family request delegates to this continuation
workflow, waits for its workflow when necessary, and retries with the same
`turnKey` so the completed policy is sampled once. Maia therefore remains on
`forma-maia`; the public API does not carry Python, PyTorch or checkpoint files.

## Cost controls

- Cloud Run remains scale-to-zero (`minScale=0`).
- The API allows at most 20 continuation commands per actor per minute.
- Interactive model work uses the dedicated `maia-play` queue and private
  `forma-maia` service, initially capped at two single-concurrency instances.
- Offline analysis and onboarding stay on `forma-analysis`; a player burst
  cannot consume their worker slots.
- One cached policy serves every player asking about the same model, position
  and rating.
- The model process is kept warm only for the lifetime of its Cloud Run instance.

Do not set a minimum instance until measured cold-start latency justifies the
standing idle cost. Do not enable instance-based billing for this request-bound
inference path.

## Promotion gate

The image carrying a checkpoint is not enough to serve it. The API resolves
only a Maia-3 model profile whose licence review is cleared and whose latest
lifecycle event is `production`.

Run the frozen holdout with the CPU adapter:

```bash
npm run models:benchmark -- \
  --adapter=maia3 \
  --corpus=holdout.jsonl \
  --engine=/opt/maia3-venv/bin/python \
  --bridge=maia3/bridge.py \
  --checkpoint=/opt/forma/maia3/maia3-5m.pt \
  --training-window-end=2025-08-01T00:00:00Z \
  --out=maia3-5m-benchmark.json

npm run models:promote -- \
  --report=maia3-5m-benchmark.json \
  --version=maia3-5m \
  --corpus=holdout.jsonl \
  --apply
```

Promotion records a new model identity and new calibration evidence. Maia-1's
old benchmark cannot license a Maia-3 claim.

## Licence and rollback

Maia-3 declares AGPL-3.0 and the model card points to the repository for the
code/weights licence. The exact upstream revision is recorded above, its licence
is included at `/opt/forma/licenses/maia3/LICENSE`, and Forma's bridge source is
in this repository.

Rollback has two independent levers:

1. move `forma-maia` traffic back to its previous image revision;
2. append a non-production lifecycle event for the Maia-3 component.

The second immediately makes new continuation requests unavailable without
deleting cached inference or rewriting old evidence.
