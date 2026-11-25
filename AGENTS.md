# AGENTS.md

Lichess Kibitzer: full-screen live engine analysis of a Lichess broadcast game. Plan: [docs/plans/live-analysis.md](./docs/plans/live-analysis.md).

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
| Frontend entry, router | `web/src/main.ts`, `web/src/App.svelte` |
| Pages | `web/src/pages/` (Viewer, Admin) |
| Shared pure logic (accuracy, marks) | `shared/` |
| UCI engine | `src/engine/` (parser, Engine), `test/fixtures/fake-uci.mjs` |
| Tests | `test/` |
| Build config | `vite.config.ts`, `vitest.config.ts`, `tsconfig.backend.json`, `web/svelte.config.js`, `web/tsconfig.json` |
| Lint / format | `eslint.config.js`, `.prettierrc`, `.editorconfig` |
| CI | `.github/workflows/nodejs.yml` |
