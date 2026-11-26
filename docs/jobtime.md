# Default job time

Answers the PRD open question "Default job time": how long should one Job (one position, MultiPV 5) search?
The default is **15 000 ms** (`DEFAULT_JOB_TIME_MS` in `shared/types.ts`). It only applies to a fresh state file;
existing state keeps its value (a saved "unset" stays unset). The Admin page changes or unsets it at any time.

## Run it

```bash
run-logged kibitzer-bench --log bench.log -- node scripts/bench-jobtime.mjs -- <engine> [engine args]
```

Options: `--depth 36`, `--movetime 5000,10000,15000,20000` (`''` skips), `--cap-ms 600000`, `--plies 12,24,36,48,60`,
`--pgn test/fixtures/lichess/round-stream.pgn`. Positions are snapshots of the fixture games at the given plies (12 in
all). Settings: Threads 1, Hash 1024, MultiPV 5, `ucinewgame` before each search (cold hash: conservative).

## Machine and caveats

- Host `coder`: AMD Ryzen 9 5950X (16 cores, one search thread, otherwise idle), 2026-11-26.
- Engine: Berserk 20261114 (origin/main `1d2354d`), net `berserk-6fd12bbd95c8.nn`, `make ARCH=native pgo`
  (clang, `bench` 1 949 676 nps).
- Measured on the dev host with a PGO native build, **not the deploy host**: re-run there before trusting the number.
- The fixture games are at most 66 plies: no real endgames. One position (gH77VTmz@60) is an outlier (depth 36 in 2.5 s).
- The arrival estimate (8 Boards, 80 plies over 4 hours, so a new position about every 22 s) is an assumption.

## Time to depth (go depth 36, cap 300 s; medians over positions that reached the depth)

| depth | reached | median s | p95 s |
| ----- | ------- | -------- | ----- |
| 20    | 12/12   | 1.9      | 2.8   |
| 24    | 12/12   | 5.4      | 11.5  |
| 28    | 12/12   | 16.2     | 38.8  |
| 32    | 12/12   | 48.9     | 125.3 |
| 36    | 11/12   | 144.7    | 253.0 |

Capped: 1 of 12 (at7GqSzo@12 reached depth 35; its depth 32 took 125.3 s). Per-position rows are in the script output.

## Depth reached in a fixed time (go movetime)

| T    | median depth | p5 depth |
| ---- | ------------ | -------- |
| 5 s  | 23           | 21       |
| 10 s | 25           | 23       |
| 15 s | 26           | 24       |
| 20 s | 28           | 25       |

## Choice

Planned rule: the largest T in {5, 10, 15, 20} s where every step up still buys at least one ply of median depth.
Every step does (+2, +1, +2), so the rule gives 20 s. We chose 15 s instead:

- Depth 36 is out of reach: its median is 144.7 s.
- At 20 s the engine would be busy 91% of the time (20 / 22 s) on current-tier Jobs for 8 Boards. That leaves almost
  nothing for Backfill and no slack when moves cluster.
- At 15 s the median depth is 26 (p5 24), two plies below 20 s (median 28, p5 25), at 68% utilisation (15 / 22 s)
  and a worst-case wait of 8 x 15 s = 120 s (20 s: 8 x 20 s = 160 s).
