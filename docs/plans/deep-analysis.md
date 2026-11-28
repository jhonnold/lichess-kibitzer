# Plan: import whole Events, on-demand deep analysis (stacked PRs)

## Context

Today an added Event stores one Round only (`rollover` picks the last due one). Earlier Rounds never reach the Archive. `tracked` means both "shown" and "analysed", so untracked Boards are recorded but never served. Pass 3 (100 s) is queued automatically for every Tracked ply, and a full Pass 3 rarely finishes before the next Round. Archived Rounds can't be analysed at all: Jobs route only to an Event's Current Round, and `place()` needs `latest`.

Goal: adding an Event loads every Round and every Board, with no analysis. An Admin asks for **deep analysis** (Pass 3 on every ply) of any Board, whether current, concluded or archived, and even one that is already analysed (for example after an engine change). Pass 3 is never queued automatically.

The plan lands as `docs/plans/deep-analysis.md`. Glossary deltas go in `~/documents/lichess-kibitzer/deep-analysis/GLOSSARY.md`: Tracked board = analysed automatically; new terms Import and Deep analysis.

Decisions (from Q&A):
- Deep runs only while nothing is live: keep the `maxPass` gate.
- Admin only (cookie).
- Every Board is shown, both live and in the Archive. Tracked Boards come first, and the rest read "Not analysed".
- An Event added when all its Rounds are finished goes entirely to the Archive, with no Current Round.

## Design

**Import**
- `api.ts`: `fetchRoundPgn(roundId)` → `GET /api/broadcast/round/{id}.pgn`. It uses the same lane and 429 pause as `getJson`, through a text variant. Confirmed in the Lichess OpenAPI spec: clocks are on by default and there is a GameURL tag.
  - The spec lists the `study:read` scope. That scope is assumed optional for public broadcasts, as with the JSON calls used today; curl it in PR 1.
- "Finished" = `finished || finishedAt !== undefined`: the spec deprecates `finished`, so map both in `fetchEvent`.
- Parsing: `pgnSplitter` + `parseGame`, appending `\n\n` at the end of the body so the last game isn't dropped.
- `src/round-import.ts`: a pure `importRound(info, games, eventName, startsAt)` that returns a `Round`.
  - Every Board is untracked, and its plies have `at: null` and no evals.
  - It reuses `newBoard` (exported from `round-state.ts`) and the `syncMoves` prefix logic, or a small pure equivalent.
- Follower, after `apply`: one background chain, not inside `serial`, so polls aren't blocked. It is skipped while one is already running.
  - It imports every Round strictly before the Current Round's index (every Round when there is none).
  - It skips Rounds whose file exists (`listRounds` / `loadRound`) and any Round in `site.currents`.
  - One Round at a time (`fetchRound` + `fetchRoundPgn` → `store.saveRound`).
  - The `openRound` trap: a future or current Round is never pre-written, so its tracked set still comes from topN.
- `rollover` with `currentId === null` (an Event just added, or one still waiting for its next Round):
  - the current Round is the last due **unfinished** Round;
  - with none due, current stays null until the next Round is due (`SWAP_LEAD_MS`, 10 min before it starts), and then it becomes current through the normal path;
  - when every Round is finished, current is null.
  - Import while current is null: every finished Round.
  - With a `currentId`, behaviour is unchanged (never goes backwards). Existing Events are untouched.
- `FollowerOpts.store` gains `saveRound`/`listRounds`, and `LichessClient` gains `fetchRoundPgn`.
- Demo: `--past N` synthesizes N finished Rounds for the import.

**Every Board shown, Tracked = analysed**
- `RoundState`:
  - `snapshot()` sends every Board.
  - The `if (b.tracked)` emit guards go, for ply, result, opening and board.
  - `setTracked` emits `board` (an upsert with the flag) both ways.
  - The SSE `untrack` type and its `applyEvent` case are dropped.
- Archive: `roundMeta` boards and outcomes count every Board. `/api/archive/:t/:r` serves every Board with `Cache-Control: no-cache`, because deep results change it.
- Web:
  - Overview: a Tracked section, then "Other boards".
  - BoardStrip: every Board, Tracked first and the others dimmed, even in big Rounds (100+).
  - Every Board is saved in its Round file, as the Current Round already does; imported Rounds save every Board too. Only topN or the selected Boards are analysed automatically.
  - The Viewer's "Board N is not tracked" fallback banner goes.
  - `statusLine` gets a new `Not analysed` state (untracked, no eval, no deep request) and a `Deep · k/n` state.
  - Header copy "N tracked boards" becomes "N boards · M tracked".
- Events card for an Event with no Current Round: "Next: <Round> · <date>" (from the Follower's `next`) or "Finished", with a link to `#/archive`.

**Pass 3 on demand only**
- `nextPass` stops at Pass 2 (loop `k < DEEP_PASS`; `QUIET_PASS` is renamed `DEEP_PASS`).
  - That one change covers `enqueue`, the post-Job requeue, `setPasses`→`repass` and `requeueDead`, because deep Jobs live outside the regular Job map (below).
- `maxPass` is unchanged, so it now gates deep Jobs only.
- Admin label: "Pass 3 (deep, on demand)". A null slot 3 means deep requests get 409.

**Deep analysis**
- `DeepRequest { tourId, roundId, boardId, board, at, left: number[] }`.
  - `left` holds plies 0..latest, minus a final position with no legal moves.
  - It is persisted in the state file, now version 5 (`deep: DeepRequest[]`). `store.load` migrates version 4 to 5 (`deep: []`).
  - It is updated on each recorded ply, about one state write per 100 s.
- Queue: a separate FIFO `deep` map (key `boardId:ply`, plies ascending within a request), with `Job.deep: true`, `pass: DEEP_PASS` and `Job.roundId`.
  - `next(maxPass)`: regular Jobs first; deep only when `maxPass ≥ DEEP_PASS` and no regular Job is eligible.
  - `preempt`: a deep Job gets `upgrade` when any regular Job waits or when the Pass is gated.
  - `addDeep`, `cancelDeep(boardId)`, `deepView()`.
  - `removeEvent`, `clear`, `setLatest`, `removeBoard` and `repass` never touch it.
  - A deep Job that crashes `MAX_CRASHES` times is dropped from `left` (and logged), not dead-lettered.
- Eval target: an `EvalTarget` interface `{ board, epoch, setEval }`, implemented by `RoundState` and by a new `src/archive-rounds.ts` `ArchiveRounds`.
  - `ArchiveRounds` is owned by SiteState. It loads a Round file on demand, keeps it while it has deep work, gives epochs from `nextEpoch`, and saves through `store.saveRound`.
  - The Scheduler resolves `target(job)`: when `site.event(tourId).round.roundId === roundId`, that RoundState; else ArchiveRounds.
  - Single writer: `site.saved()` also awaits ArchiveRounds' writes. Follower.apply calls `site.release(tourId, roundId)` (flush + drop) before `loadRound` of a Round about to become current. ArchiveRounds loads a Round only after `site.saved()`.
- Recording:
  - A deep Complete eval always replaces the old one (forced: it bypasses `prev.ms <= record.ms`).
  - An interrupted deep search is discarded and requeued at the front (no keep-if-deeper).
  - A stale epoch is refused and requeued.
- `runJob` exit path for deep Jobs: every lookup goes through `target(job)`, never the `rs` taken at the start.
  - Drop (the Event-match check), halt (`startRound`/`removeEvent` of the same tourId) and interrupt all requeue the Job at the front of the deep map while its request exists. The post-Job `nextPass` requeue never applies to deep Jobs.
  - `startRound`/`removeEvent` halt a running deep Job only when its target is that Round.
  - A crash counts against the request (`left`), never the Dead-letter queue.
- Scheduler: `wanted` = some Event has a Round **or** deep requests are pending. Boot restores requests into the Queue. Removing an Event keeps its requests, since the Archive keeps the Rounds. A request whose Round file is missing is dropped.
- Admin API:
  - `POST /api/admin/deep { tourId, roundId, boardId }`. A repeat request restarts `left`. The response is 404 for an unknown Board and 409 when Pass 3 is off.
  - `DELETE /api/admin/deep/:boardId`.
  - `GET /api/admin/session` (200/401) so the Viewer knows to show the button.
  - `/status` gets `deep[]`.
- `QueueView.deep: { boardId, left, total }[]` is site-wide on every stream.
- Web:
  - The Viewer shows a "Deep analysis" / "Cancel" button for an Admin, both live and in the Archive.
  - The Archive store refetches every 15 s while `queue.deep` holds a Board of the shown Round, plus once after it drains.
  - StatusPanel lists deep requests with progress and Cancel, and says why they're held ("held: <Event> live").
  - The Archive refetch can read `queue.deep`: App keeps the EventSource open on Archive routes (sticky `tour`).
- Metrics: a `kibitzer_deep_plies_left` gauge (the `pass="2"` labels already exist).

## PRs

Branches are `feat/da-<n>-<slug>`, and each one passes the gate.

1. `import`: `fetchRoundPgn`, `importRound`, the Follower import chain, the `rollover` add rule, demo `--past`, and this plan doc.
   - Tests: last-game flush; import skips existing files, currents and future Rounds; an all-finished Event gets current null; a mid-Event add with the next Round days away gets current null, and that Round becomes current at startsAt − 10 min; the import doesn't delay polls.
2. `all-boards`: emits and snapshots of every Board, the `untrack` removal, Archive meta and route, the web Overview/BoardStrip/Viewer/`statusLine` "Not analysed", and the Events card for a finished Event.
   - Tests: round-state emits, `applyEvent`, `roundMeta`, `statusLine`, and `e2e` (an untracked Board on SSE).
3. `deep-off`: `nextPass` caps at Pass 2, `DEEP_PASS` rename, Admin label.
   - Tests: passes; scheduler (nothing queues Pass 3 while quiet).
4. `deep-core`: the Queue `deep` map, state version 5 and migration, `ArchiveRounds` + `EvalTarget`, Scheduler routing, forced replace, `wanted`, release on reopen.
   - Tests: Queue order, gate and preempt; deep on an archived Board writes its file; `startRound` of the same Event while a deep Job of its archived Round is mid-search (the ply is requeued, not lost); deep on a Current-Round Board while it is Tracked; a Round swap mid-deep (the target moves, nothing lost); restart resumes `left`; cancel; v4→v5.
5. `deep-api-ui`: admin routes, `QueueView.deep`, the Viewer button and pill, Archive refetch, StatusPanel, gauge.
   - Extend `e2e.test.ts`: import a finished Event → Archive lists every Round and Board → POST deep → plies fill → Archive GET shows them.
6. `docs`: AGENTS.md nav (import, ArchiveRounds, deep), README, `docs/deploy.md` (gauge, routes), the plan's "As built" section, and the glossary in `~/documents`.

Orchestration: one layer at a time, an implementer subagent, then review; `gh stack`.

## Verification

- Every PR: `npm run lint && npm run check && npm test && npm run build`.
- After 1–2: `npm run demo -- --events 2 --past 3`. Playwright at 1280×720 and phone width shows the Archive with 3 Rounds × every Board and no evals, and the Current Round Overview with Tracked boards plus Other boards.
- After 5:
  - Demo: log in as Admin, request deep on an archived Board, and confirm with nothing live that plies fill at Pass 3 (StatusPanel `Deep k/n`, Archive Viewer updating).
  - Restart mid-way: it resumes.
  - Cancel: it stops.
  - A live game starting stops the deep Job (`upgrade`).
- Real: on a dev server with the fake engine, add a finished real broadcast. Every Round is in the Archive, the Queue is empty, and Lichess requests are serial with no 429.

## Known gaps (accepted)

- A game left at `*` keeps its Event live forever, so deep analysis never runs. This used to block only the automatic Pass 3; now it is the only way to get deep analysis, a result of the live-gate choice. The fix stays manual: untrack the Board, or remove the Event.
- Huge Rounds send every Board over SSE (snapshot size, ply frames).

## Unresolved questions

None.

## As built

How the stack differs from the plan above (source: the layer reports and reviews).

- **Rollover of a new Event** only looks after the last finished Round: current = the last due Round after it, else none until the next one is due. A Round stuck unfinished before a finished one is never made current; the import picks it up once it finishes.
- **Import** checks for existing files with `listRounds` (it also counts a save still being written). The first error ends that pass, goes to the follow status, and the next poll retries. Every Event already followed imports its earlier Rounds on its first poll after deploy.
- **Every Board shown:** `addBoards` also emits a `board` frame. The Viewer banner stays, reworded, for a Board number the Round lacks. `EventSummary` gains `next` and `finished` (pushed by the Follower), so an Event with no Current Round reads "Next: …" or "Finished". The AppBar LIVE pill counts Tracked Boards only.
- **Deep core:**
  - Deep Jobs are `tier: 'backfill'`, `pass: 2` in metrics; there is no new tier label.
  - `runDeep` is its own method, sharing `search()` with `runJob`. There is no `force` flag on `setEval`: the keep-the-longer rule lives only in the Scheduler.
  - `startRound` also releases ArchiveRounds and opens its held copy, and it halts a deep Job of the Round being opened.
  - After the Round file read, a deep Job re-checks `preempt` and the Pass 3 time. A Round released during the read is requeued, not cancelled.
  - A failed read counts as a crash of that ply; after 3, the request ends.
  - `parseV5` rejects a malformed request (non-integer or negative plies).
- **Deep API and UI:**
  - `/status` has `deep[]` plus `deepHeld` (`live` with the Event, `pass 3 off`, or `busy`).
  - The deep state is read from `search.pass === DEEP_PASS`; there is no `SearchInfo.deep`.
  - ArchiveStore merges `queue.deep` and the running deep search into an archived Round (`withDeep`), and refetches every 15 s while `deepInRound`.
  - The archive route awaits `archive.saved()` before reading.
  - New `--deep` colour token.

Known gaps (not fixed):

- An archived Round's live depth and Lines show only while the stream is bound to the request's Event, because SSE nulls other Events' searches. Otherwise the pill reads `Deep · k/n` without depth.
- StatusPanel labels archived Rounds `Round <roundId>`, because requests carry no Round name.
- "Past Rounds in the Archive →" shows even when the Archive has nothing for that Event. The Archive has no per-Event filter.
- An Event followed through its last Round keeps that Round as current, so its card never reads "Finished".
- Import errors share `status.error` with polls, so the error flips while a retry keeps failing.
