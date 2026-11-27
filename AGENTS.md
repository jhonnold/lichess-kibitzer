# AGENTS.md

Lichess Kibitzer: full-screen live engine analysis of Lichess broadcast Events (several followed at once, one is the Primary Event), each followed Round by Round: the top N Boards of each Event's Round are Tracked, two copies of one UCI engine (main: MultiPV 1, the eval, accuracy and marks; multi: MultiPV N, the Lines) work through one shared Queue of Jobs together, Viewers step a Cursor through the game, and finished Rounds stay in an Archive. Plan: [docs/plans/live-analysis.md](./docs/plans/live-analysis.md). v2 plan: [docs/plans/v2.md](./docs/plans/v2.md). Multi-Event plan: [docs/plans/multi-event.md](./docs/plans/multi-event.md).

## Commands

```bash
npm install && npm run build    # Install + compile (prebuild runs vite build)
npm run dev-server              # Backend (nodemon, auto-restart on src/ changes)
npm run dev-public              # Frontend (vite build --watch → build/public)
npm run start                   # Production build (port 8080, or $PORT)
npm run lint                    # ESLint + fix (src, shared, test, web)
npm run check                   # svelte-check (web/)
npm run format                  # Prettier
npm test                        # Vitest (test/)
```

Gate before commit: `npm run lint && npm run check && npm test && npm run build`

## Key Conventions

- **ESM**: use `.js` extensions in backend imports (`import foo from './foo.js'`)
- **web/** imports: no file extension; `$lib/…` and `$shared/…` aliases
- **TypeScript**: strict mode, ESNext target
- **Tests**: `test/**/*.test.ts` run by Vitest, not compiled by tsc; covered by ESLint and Vitest only
- **Formatting**: Prettier (120 width, single quotes, trailing commas)
- **Svelte**: Svelte 5 runes; hash router (`#/admin`), no SvelteKit
- **Node `^20.19.0 || >=22.12.0`**, npm
- **Commits**: conventional commits

## Navigation

| Need | Path |
|------|------|
| Entry point, server setup | `src/main.ts`, `src/app.ts` |
| HTTP routes (SSE `/api/events`, `/api/admin/*`), boot wiring | `src/routes/`, `src/app.ts` (createApp), `src/server.ts` (startServer) |
| Top-level test (replay source + fake engine, several Boards, over SSE) | `test/e2e.test.ts` |
| Frontend entry, router | `web/src/main.ts`, `web/src/App.svelte` |
| App shell and navigation (app bar ≥700px, phone tab bar <700px; breakpoints 1100 / 700) | `web/src/App.svelte`, `web/src/components/AppBar.svelte`, `web/src/components/TabBar.svelte`, `navLinks` in `shared/route.ts` |
| Pages | `web/src/pages/` (Viewer, Overview, Archive, Admin, Events) |
| Events page (landing list when several Events are followed), Event switcher | `web/src/pages/Events.svelte`, `web/src/components/AppBar.svelte` |
| Viewer SSE state (pure reducer, EventSource store) | `shared/live.ts`, `web/src/lib/live.svelte.ts` |
| Viewer pure helpers (replay/PV end, legal dests, eval graph series, ticking clocks, Lichess link) | `shared/viewer.ts` |
| Material difference | `shared/material.ts` |
| Engine arrows (best/good/inaccuracy, labels) | `shared/arrows.ts` |
| Round overview (tile view-model, page, tile) | `shared/overview.ts`, `web/src/pages/Overview.svelte`, `web/src/components/BoardTile.svelte` |
| Cursor (step/jump/own moves/follow-live, pure) | `shared/cursor.ts` |
| Archive (list + Round routes, store listing; page, client store, shared types) | `src/routes/archive.ts`, `src/store.ts`, `shared/archive.ts`, `web/src/pages/Archive.svelte`, `web/src/lib/archive.svelte.ts` |
| Viewer components, tokens | `web/src/components/`, `web/src/styles/tokens.css` |
| Admin page (API helper, UCI options form helpers), per-Event section | `web/src/pages/Admin.svelte`, `web/src/components/AdminEvent.svelte`, `web/src/lib/admin-api.ts`, `shared/engine-form.ts` |
| Shared pure logic (accuracy, marks) | `shared/` |
| Job queue (two tiers, Dead-letter queue) | `shared/queue.ts` |
| UCI engine | `src/engine/` (parser, Engine), `test/fixtures/fake-uci.mjs` |
| Lichess API | `src/lichess/api.ts` |
| Lichess stream | `src/lichess/stream.ts` |
| Site (add/remove/primary Events, one Follower each) | `src/site.ts` |
| Feed (per-Event Job source for the Scheduler) | `src/feed.ts` |
| Site state (settings, Primary, one RoundState per Event), persistence, wire types | `src/site-state.ts`, `src/round-state.ts`, `src/store.ts`, `shared/types.ts` |
| Prometheus metrics (`GET /api/admin/metrics`, basic auth; list in `docs/deploy.md`) | `src/metrics.ts`, HTTP middleware in `src/app.ts`, build sha `scripts/rev.mjs` |
| Admin status timing (Job duration spread) and panel | `shared/timing.ts`, `web/src/components/StatusPanel.svelte` |
| Opening name (PGN tags, explorer fallback) | `src/opening.ts`, `src/lichess/api.ts` (`fetchOpening`) |
| Orchestrator (Queue + paired Jobs on both engine copies over RoundState); derived accuracy/marks, `multiOf` | `src/scheduler.ts`, `src/round-state.ts`, `src/pv.ts`, `shared/analysis.ts` |
| Engine config (per-copy Threads/Hash/MultiPV, legacy migration, launch order) | `shared/engine-config.ts` |
| Event following (one Follower per Event: poll, Round rollover) | `src/follower.ts`, `shared/rollover.ts` |
| Event cards, default topN (8 ÷ Events) | `shared/events.ts` |
| Job time benchmark and the default job time | `scripts/bench-jobtime.mjs`, `docs/jobtime.md` |
| Demo server (`npm run demo`; fake engine, synthesized Round, `--events N` for several; flags in file header) | `scripts/demo.ts` |
| Hash router (routes, `#/e/<tourId>/…` forms, deep links to a move, streaming layout params) | `shared/route.ts` |
| Tests | `test/` |
| Build config | `vite.config.ts`, `vitest.config.ts`, `tsconfig.backend.json`, `web/svelte.config.js`, `web/tsconfig.json` |
| Lint / format | `eslint.config.js`, `.prettierrc`, `.editorconfig` |
| CI | `.github/workflows/nodejs.yml` |
