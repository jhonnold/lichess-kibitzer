# Plan: search Passes (multi-tier search)

## Context

Every Job used to be one `go movetime jobTimeMs` search (15 s by default). Under load, positions waited; when it was quiet, the engine sat idle and the evals stayed shallow. Now each position gets up to three **Passes**:

- Pass 1 (e.g. 1 s) runs right away.
- Pass 2 (10 s) runs in the free time during live play.
- Pass 3 (100 s) runs only while no Event is live.

As the load drops, positions get deeper.

Decisions:

- The top Pass is gated site-wide (there is one engine pair): it runs only while no Tracked Board of any Event is being played.
- A waiting Pass 1 Job evicts a running deepening Job at once. A stopped deepening search is kept only if it got deeper than the eval it would replace.
- Accuracy and marks keep using the best Complete eval of any Pass (`shared/analysis.ts` unchanged).
- Only Current Rounds are deepened, never the Archive.
- The start position (ply 0) gets Pass 1 only.
- A state file that had a job time migrates to the default Passes. An unset job time stays unset.

Naming: in code, `pass` is 0-based; the UI shows Pass 1-3. `Tier` (`current` | `backfill`) stays as it was, and Pass is a second, outer ordering.

## Design

- **Settings**: `SiteSettings.passesMs: [number, number | null, number | null] | null`.
  - A null slot is off; the whole value null means the Queue idles.
  - Non-null values are strictly ascending (`passesError` in `shared/passes.ts`).
  - The default is `DEFAULT_PASSES_MS = [1000, 10000, 100000]`.
  - The state file is now version 4. `store.load` migrates version 2 and 3.
- **Eval.ms**: how long the search ran (the Pass's time; for a kept interrupted search, its elapsed time).
  - `nextPass(eval, ply, passes)`: Pass 0 until a Complete eval; then the first enabled Pass whose time is above `ms`; null when done.
  - An eval recorded before Passes (no `ms`) counts as Pass 0 only.
- **Queue**:
  - `Job.pass`. Order: Pass, then today's tier order. Latest plies come first within a deepening Pass.
  - `next(maxPass)` holds back the gated Pass.
  - `preempt(…, maxPass)` evicts a running deepening Job with reason `upgrade` when a lower Pass waits, or when its Pass is no longer allowed.
  - `current()`, `deferred()` and `backfillCount()` are Pass 0 only, so the Viewer's queue positions are unchanged.
  - `passCounts()`.
  - `repass(fn)` moves waiting Jobs to their new Pass and keeps their place.
- **Scheduler**:
  - `enqueue` queues each ply's next Pass.
  - After a Complete eval, the ply's next Pass is requeued.
  - `maxPass` = 2 while no Tracked Board is live (`boardState`), else 1.
  - `setPasses` saves, repasses, re-enqueues every Event, then wakes.
  - Replace rule: a Complete eval never replaces one with a greater `ms`, except a kept deepening search.
- **Surfaces**:
  - `SearchInfo.pass` and `.ms`.
  - Admin status: `passesMs`, `passCounts`, and `timing` per Pass.
  - `PUT /api/admin/passes { ms }` replaces `/jobtime`.
  - Admin form with three fields (blank Pass 2/3 = off).
  - StatusPanel: Pass chip, progress against the Pass's time, waiting per Pass, timing per Pass.
  - Viewer `statusLine`: `Done · depth N · 10 s`, `Deepening · depth N · 100 s`.
  - Demo `--passes 300,1500,6000`.
- **Metrics**:
  - A `pass` label on `kibitzer_jobs_total`, `kibitzer_job_duration_seconds`, `kibitzer_job_depth` and `kibitzer_job_nps`.
  - New outcome `discarded`; new eviction reason `upgrade`.
  - New gauge `kibitzer_queue_pass_depth{pass}`.

## Verification

- Gate: `npm run lint && npm run check && npm test && npm run build`.
- `test/passes.test.ts`: `nextPass`, `maxPass`, `passesError`.
- `test/queue.test.ts`: Pass-major order, `next(maxPass)`, `upgrade` evictions, `repass`, requeue keeps the Pass.
- `test/scheduler.test.ts` ("Scheduler Passes"):
  - Passes in order, with the top Pass held while live.
  - A no-deeper upgrade is discarded; a deeper one is kept and searched again.
  - `setPasses` adds and drops Jobs.
  - A second Event going live stops a top-Pass Job.
- Store migration tests.
- Demo `npm run demo -- --events 2 --passes 200,1000,5000`: Pass 0 drained at about 207 ms per Job, then Pass 1 ran at about 1011 ms with Pass 2 waiting.

## As built

- No `rebuild()`: `setPasses` uses `Queue.repass`, so a Pass change keeps the waiting order.
- Pass counts are not in the SSE `QueueView`, only in the Admin status and the new gauge.
- `kibitzer_evictions_total` has no `pass` label. The `upgrade` reason identifies deepening Jobs.
- A kept interrupted deepening search is recorded as Complete, but counts as `provisional` in the timing samples and the histograms' `kind`, so the per-Pass time spreads stay clean.
- The Admin timing window is 200 Jobs per Pass, not 200 in all.

Known gaps:

- A game left at `*` forever keeps its Event live, so the top Pass never runs. The demo shows this: its unfinished games stop at `*`.
- Marks can compare evals of different Passes across a move; they settle as the higher Passes fill in.
- A full top Pass (8 Boards × 80 plies × 100 s ≈ 18 h, assuming 80 plies a game) usually won't finish before the swap 10 min ahead of the next Round.
