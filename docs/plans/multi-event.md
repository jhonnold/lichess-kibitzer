# Plan — multiple Events at once (stacked PRs)

## Context

Today the site follows exactly one registered Event: `Settings.event` is singular, `RoundState` holds one Current Round, `Follower.register` of a new tourId stops the Scheduler and replaces the Event, and Viewers get one SSE snapshot. Goal: Admin registers several Events; each follows its own Rounds; one engine pair works one global Queue over every Event's Tracked boards; Viewers pick an Event. Lands as `docs/plans/multi-event.md`; glossary/PRD deltas (Event, Current Round, Idle become per-Event; new: Primary Event) in `~/documents/lichess-kibitzer/multi-event/`.

Decisions (from Q&A): shared Queue + one engine pair; per-Event topN only (no global budget, no Event cap), a new Event defaulting to 8 ÷ live Events; old URLs kept → Primary Event, new `#/e/<tourId>/…`; `#/` = Events list (≤1 Event → Viewer as today).

## Findings that shape the plan

- Game ids are globally unique → Queue keys `boardId:ply` stay unique; Jobs only need `tourId` to route back to the owning Event.
- Capacity: 8 Boards @ 15 s ≈ 68% busy (v2.md As built). 2×8 ≈ 136% (linear estimate) → Admin must lower topN per Event; status page shows total Tracked + utilisation.
- Singletons that break silently (each a named step below): `Follower.register`/`clear` call `scheduler.stop()`; `Scheduler.startRound` does `halt('drop')` + `queue.clear()` + `openings.clear()`; `store.load` throws on non-v2; `archiveIndex(metas, current)` + `/api/archive/:t/:r` 404 one Round only; `bindMetrics` reads `state.settings.event`/`state.dead`; admin `/topn`, `/tracked`, `/clear` are Event-less.
- Viewer already filters `snap.search` by `boardId` (`Viewer.svelte:108-118`); `QueueView.current` is looked up by boardId → a global QueueView works unchanged for per-Event Viewers (positions stay global = honest wait).
- One shared 429 pause in `src/lichess/api.ts` now covers N streams + N polls. Noted, not fixed.

## Design

- **State split.** New `src/site-state.ts` `SiteState`: engine config, jobTimeMs, primary tourId, `Map<tourId, RoundState>`, transient `search`/`queue`, owns `state.json` writes. `RoundState` becomes per-Event: event, topN, round, dead, stream, epochs/synced/unknown; asks SiteState to save on event/topN/current/dead change. Round files unchanged (`data/rounds/<tourId>/<roundId>.json`).
- **Persisted v3** (`shared/types.ts`): `{ version: 3, settings: { engine, jobTimeMs }, primary, events: [{ event, topN, current, dead }] }`. `store.load` migrates v2 → v3 (event → one entry + primary; Idle → `events: []`); v1 still discarded.
- **Queue** (`shared/queue.ts`): `Job`/`DeadJob` gain `tourId`; `removeEvent(tourId)`; ordering unchanged (live of any Event beats any backfill; cross-Event tie → `since` then `board`).
- **Scheduler**: keeps engines, Queue, run loop, evictions, timing. Source/onGame/openings move to per-Event `src/feed.ts` `Feed` (one `RoundStream`, one `OpeningFallback`). Every `state.board/epoch/setEval/syncMoves` routes via `job.tourId`. Per-Event API: `startRound(tourId, …)` (halt only if running Job is that Event's, `queue.removeEvent`, that Feed restarted), `removeEvent(tourId)`, `setTracked(tourId, ids)`. `wanted` = any Event has a Round → engines quit when the last Event goes (Idle). `stop()` stays global (shutdown).
- **Follower** per Event (logic as is, minus the stop/setEvent): `register` of same tourId → tick only. New `src/site.ts` `Site`: `add(link)`, `remove(tourId)`, `setPrimary`, `resume()`, `stop()`; owns Followers. First added = Primary; removing Primary → next oldest.
- **SSE**: `GET /api/events?tour=<id>` (absent → Primary). Snapshot as today for that Event (`search` null unless the running Job is this Event's) + `events: EventSummary[]` (tourId, name, round name, startsAt, live/upcoming, tracked count, primary). New `{ type: 'events' }` SseEvent on add/remove/round swap/primary change. `applyEvent` gains that case only.
- **Default topN of a new Event**: `max(1, floor(DEFAULT_TOP_N / live Events))`, live Events counting the new one (pure helper in `shared/`, tested). `POST /event { link, topN? }` uses it when topN is absent; the Admin add form pre-fills it. Existing Events' topN unchanged.
- **Admin API**: `POST /event` (add; 409 never, re-add = tick), `DELETE /event/:tourId`, `PUT /event/:tourId/topn`, `PUT /event/:tourId/tracked`, `PUT /primary`; drop `/clear`, `/topn`, `/tracked`. Dead requeue/discard keep boardId (unique). `/status` → site block (engine, copies, timing, jobTimeMs, running + tourId, global queue, evictions, total tracked) + `events[]` (event, topN, round, stream, dead, follow, primary).
- **Archive**: `archiveIndex(metas, currents[])`; `:t/:r` 404 for any Current Round.
- **Metrics**: `kibitzer_following` = registered Event count; dead-letter size = sum; follower last-success + polls get `event` label (tourId; low cardinality). Doc in `docs/deploy.md`.
- **Web**: `shared/route.ts` adds `{ page: 'events' }`, `tourId: string | null` on viewer/round routes, `#/e/<tourId>/board/n[/ply]`, `#/e/<tourId>/round`; old `#/board/n`, `#/round` → Primary; hash builders take tourId (null → old form). `LiveStore.connect(tour)`; `App.svelte` reconnects when route tourId changes (still one EventSource). New `web/src/pages/Events.svelte` (landing list); AppBar Event switcher when >1 Event; Admin page Events section (add, remove, primary, per-Event topN + tracked + follow status); StatusPanel shows the running Job's Event.

## PRs

Branches `feat/me-<n>-<slug>`; each green on the gate.

1. `queue-tour` — Job/DeadJob `tourId`, `Queue.removeEvent`; tests. This plan as `docs/plans/multi-event.md`.
2. `store-v3` — v3 types, v2→v3 migration in `store.load`; tests: v2 with Event, v2 Idle, v3 round-trip, v1 discard, corrupt throws.
3. `site-state` — `SiteState` + per-Event `RoundState`; app still wired for ≤1 Event via Primary. Tests: round-state split, save coalescing across Events, per-Event snapshot with filtered search.
4. `feed-scheduler` — `Feed`, Scheduler routing by tourId, per-Event startRound/removeEvent/setTracked. Tests (fake engine + replay): two Events; A's swap keeps B's running Job; removing A halts only A's Job; B's live evicts A's backfill; last Event removed → engines quit.
5. `site` — `Site` + per-Event Followers; `server.ts` wiring; boot resumes every Event; default topN helper (8 ÷ live Events). Tests (fake clock, 2 Events × 2 Rounds): clearing A leaves B polling; swaps independent; Primary reassignment; second Event added while one is live gets topN 4.
6. `routes` — SSE `?tour=`, `events` event; admin routes + status shape; archive excludes all Current Rounds; metrics. Rewrite/extend `test/e2e.test.ts`: two Events over SSE, each stream sees only its Boards, Archive hides both Current Rounds.
7. `web-routes` — `route.ts` hashes, LiveStore/App per-Event connect, tourId through `navLinks`, `BoardStrip`, `BoardTile`, Overview links; `test/route.test.ts` (old links → Primary, new parse/build round-trip).
8. `events-page` — Events landing + AppBar switcher + TabBar; `applyEvent` `events` case tests.
9. `admin-events` — Admin Events section, StatusPanel per-Event + total tracked/utilisation.
10. `demo-docs` — `scripts/demo.ts --events N` (second synthesized Event, distinct 8-char ids); AGENTS.md nav, `docs/deploy.md`, README URLs; glossary in `~/documents/lichess-kibitzer/multi-event/`.

Orchestration as v2.md (worktree per layer, planner general-purpose opus → scratchpad, implementer, code-review), `gh stack`.

## Verification

- Every PR: `npm run lint && npm run check && npm test && npm run build`.
- After 6: dev server + fake engine with two replay Events; `curl -N '/api/events?tour=A'` vs `?tour=B` show disjoint Boards; `/api/admin/status` lists both; metrics `kibitzer_following 2`.
- After 7–9: `npm run demo -- --events 2`, Playwright at 1280×720 and phone width: Events list → Event A overview → Board → switch to B; old `#/board/1?chrome=0` shows Primary; Admin add/remove/primary; screenshots reviewed.
- Boot migration: copy a real v2 `data/state.json` into the demo data dir, boot, confirm Event + engine config + Dead-letter queue survive as v3.
- Final: two real ongoing broadcasts (if live) with local Berserk, topN 4 each; watch utilisation and first-look latency on the status page.

## Out of scope

- Cross-Event fairness beyond the Queue's `since` ordering (weights per Event).
- Pausing an Event (registered but not analysed).
- Global Tracked-board budget; Event count cap; fixing the shared 429 pause.

## Unresolved questions

None.
