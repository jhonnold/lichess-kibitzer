# AGENTS.md

Lichess Kibitzer: full-screen live engine analysis of a Lichess broadcast game. Plan: [docs/plans/live-analysis.md](./docs/plans/live-analysis.md). v2 plan: [docs/plans/v2.md](./docs/plans/v2.md).

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
| Top-level test (replay source + fake engine over SSE) | `test/e2e.test.ts` |
| Frontend entry, router | `web/src/main.ts`, `web/src/App.svelte` |
| Pages | `web/src/pages/` (Viewer, Admin) |
| Viewer SSE state (pure reducer, EventSource store) | `shared/live.ts`, `web/src/lib/live.svelte.ts` |
| Viewer pure helpers (replay/PV end, legal dests, eval graph series) | `shared/viewer.ts` |
| Viewer components, tokens | `web/src/components/`, `web/src/styles/tokens.css` |
| Admin page (API helper, UCI options form helpers) | `web/src/pages/Admin.svelte`, `web/src/lib/admin-api.ts`, `shared/engine-form.ts` |
| Shared pure logic (accuracy, marks) | `shared/` |
| Job queue (two tiers, Dead-letter queue) | `shared/queue.ts` |
| UCI engine | `src/engine/` (parser, Engine), `test/fixtures/fake-uci.mjs` |
| Lichess API | `src/lichess/api.ts` |
| Lichess stream | `src/lichess/stream.ts` |
| Site state, persistence, wire types | `src/state.ts`, `src/round-state.ts`, `src/store.ts`, `shared/types.ts`, `shared/types-v2.ts` |
| Orchestrator (pick, Backfill, Live loop, resume); derived accuracy/marks | `src/kibitzer.ts`, `shared/analysis.ts` |
| Scheduler (v2 orchestrator: Queue + Jobs over RoundState) | `src/scheduler.ts`, `src/pv.ts` |
| Tests | `test/` |
| Build config | `vite.config.ts`, `vitest.config.ts`, `tsconfig.backend.json`, `web/svelte.config.js`, `web/tsconfig.json` |
| Lint / format | `eslint.config.js`, `.prettierrc`, `.editorconfig` |
| CI | `.github/workflows/nodejs.yml` |
