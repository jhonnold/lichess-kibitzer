# AGENTS.md

Lichess Kibitzer: full-screen live engine analysis of a Lichess broadcast Event, followed Round by Round: the top N Boards of each Round are Tracked, one UCI engine works through a Queue of Jobs, Viewers step a Cursor through the game, and finished Rounds stay in an Archive. Plan: [docs/plans/live-analysis.md](./docs/plans/live-analysis.md). v2 plan: [docs/plans/v2.md](./docs/plans/v2.md).

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
| Pages | `web/src/pages/` (Viewer, Overview, Archive, Admin) |
| Viewer SSE state (pure reducer, EventSource store) | `shared/live.ts`, `web/src/lib/live.svelte.ts` |
| Viewer pure helpers (replay/PV end, legal dests, eval graph series, ticking clocks, Lichess link) | `shared/viewer.ts` |
| Material difference | `shared/material.ts` |
| Engine arrows (best/good/inaccuracy, labels) | `shared/arrows.ts` |
| Round overview (tile view-model, page, tile) | `shared/overview.ts`, `web/src/pages/Overview.svelte`, `web/src/components/BoardTile.svelte` |
| Cursor (step/jump/own moves/follow-live, pure) | `shared/cursor.ts` |
| Archive (list + Round routes, store listing; page, client store, shared types) | `src/routes/archive.ts`, `src/store.ts`, `shared/archive.ts`, `web/src/pages/Archive.svelte`, `web/src/lib/archive.svelte.ts` |
| Viewer components, tokens | `web/src/components/`, `web/src/styles/tokens.css` |
| Admin page (API helper, UCI options form helpers) | `web/src/pages/Admin.svelte`, `web/src/lib/admin-api.ts`, `shared/engine-form.ts` |
| Shared pure logic (accuracy, marks) | `shared/` |
| Job queue (two tiers, Dead-letter queue) | `shared/queue.ts` |
| UCI engine | `src/engine/` (parser, Engine), `test/fixtures/fake-uci.mjs` |
| Lichess API | `src/lichess/api.ts` |
| Lichess stream | `src/lichess/stream.ts` |
| Site state, persistence, wire types | `src/round-state.ts`, `src/store.ts`, `shared/types.ts` |
| Prometheus metrics (`GET /api/admin/metrics`, basic auth) | `src/metrics.ts` |
| Admin status timing (Job duration spread) and panel | `shared/timing.ts`, `web/src/components/StatusPanel.svelte` |
| Opening name (PGN tags, explorer fallback) | `src/opening.ts`, `src/lichess/api.ts` (`fetchOpening`) |
| Orchestrator (Queue + Jobs over RoundState); derived accuracy/marks | `src/scheduler.ts`, `src/round-state.ts`, `src/pv.ts`, `shared/analysis.ts` |
| Event following (poll, Round rollover) | `src/follower.ts`, `shared/rollover.ts` |
| Job time benchmark and the default job time | `scripts/bench-jobtime.mjs`, `docs/jobtime.md` |
| Demo server (`npm run demo`; fake engine, synthesized Round; flags in file header) | `scripts/demo.ts` |
| Hash router (routes, deep links to a move, streaming layout params) | `shared/route.ts` |
| Tests | `test/` |
| Build config | `vite.config.ts`, `vitest.config.ts`, `tsconfig.backend.json`, `web/svelte.config.js`, `web/tsconfig.json` |
| Lint / format | `eslint.config.js`, `.prettierrc`, `.editorconfig` |
| CI | `.github/workflows/nodejs.yml` |
