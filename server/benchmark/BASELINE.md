# Stockfish 18 local baseline

Measured on 2026-07-16 with the official Windows x86-64 AVX2 Stockfish 18
release, one engine thread, 64 MB hash, and the complete 120-game credential-free
corpus. This validates the engine contract and provides a development baseline;
it is not a Cloud Run capacity measurement.

| Profile | Limit | MultiPV | Warm P50 | Warm P95 | Cold P50 | Cold P95 | Best-move agreement | Judgment stability |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| screening | 50,000 nodes | 1 | 58 ms | 77 ms | 549 ms | 611 ms | 75.0% | 95.8% |
| deep | 500,000 nodes | 3 | 554 ms | 711 ms | 1,208 ms | 1,242 ms | reference | reference |

The screening profile meets the initial gates of at least 75% best-move
agreement and at least 85% stable evaluation judgment relative to the deep
profile. The best-move result sits exactly at the initial threshold, so future
corpus additions or engine upgrades must be treated as a potential reason to
revisit the 50,000-node budget.

## Illustrative compute forecast

Using the benchmark assumptions of 60 screened positions per game, 12% selected
for deep analysis, one vCPU, one GiB of memory, and the published cost constants
embedded in the runner:

| Games | P50 | P95 |
|---:|---:|---:|
| 30 | $0.0045 | $0.0058 |
| 100 | $0.0149 | $0.0195 |
| 500 | $0.0747 | $0.0974 |

These values exclude database, storage, queue, network, retries, and provider
sync costs. Before production pricing decisions, repeat the benchmark inside the
actual Cloud Run worker image and compare estimated versus billed vCPU-seconds.

## Reproduce

From `server/`, set `STOCKFISH_PATH` to the official binary and run:

```sh
npm run benchmark:stockfish
```
