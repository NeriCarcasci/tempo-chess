# Engine benchmark

This benchmark supplies the evidence for issues #4 and #5 without accessing a
player account or private API. `buildBenchmarkCorpus()` deterministically builds
120 legal games across Chess.com/Lichess provenance, all game phases, four time
controls, and quiet/tactical/winning/losing/time-pressure strata.

## Commands

From `server/`:

```sh
npm run benchmark:test
npm run benchmark
STOCKFISH_PATH=/path/to/stockfish npm run benchmark:stockfish
```

`benchmark` uses a deterministic fixture adapter for fast CI and validates the
reporting/regression machinery. Its timings are synthetic and must never be used
for production capacity decisions. `benchmark:stockfish` measures five genuinely
fresh engine sessions per profile for cold P50/P95, then runs the full corpus
through one additional session for warm measurements. It uses the versioned
`screening` and `deep` profiles defined by the engine.

To run a smoke subset or save a report:

```sh
npx tsx src/benchmark/run.ts --adapter=stockfish --limit=12
npx tsx src/benchmark/run.ts --adapter=stockfish --output=benchmark/reports/stockfish.md
```

## Metrics and gates

The final (deepest) profile is the reference. Each shallower profile reports:

- best-move agreement;
- stable evaluation judgment (balanced/edge/winning/mate bands);
- whether its MultiPV candidates contain the reference move;
- cold and warm P50/P95 wall-clock latency;
- per-position cost at the configured one-vCPU/one-GiB rates.

CI fails below 75% best-move agreement or 85% judgment stability. The cost
forecast models 60 analyzed positions per game and deep analysis of 12% of
positions. Those assumptions are printed in every report and should be updated
after the production critical-position detector is measured.

The corpus is generated rather than downloaded so it is immutable, reviewable,
credential-free, and contains no player data. A future sampled production corpus
can implement the same `BenchmarkGame` contract without changing the runner.
