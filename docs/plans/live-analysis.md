# Plan — lichess-kibitzer live analysis (stacked PRs)

## Context

Implement `~/documents/lichess-kibitzer/live-analysis/PRD.md` (terms: `GLOSSARY.md`, ADRs 0001/0002 alongside). Repo is empty bar `README.md`. Ship as a `gh stack` of ~500-added-LOC PRs (rule from node-tlcv `stacked-prs` memory). Service not live → PRs need not be deploy-safe, but each is a concrete, green, testable chunk.

## Stack / conventions

- Mirror node-tlcv (`~/projects/node-tlcv`): Node ≥20.19, TS strict ESM (`.js` import suffixes), Express, Vite + Svelte 5 SPA in `web/`, `shared/` types, Prettier 120/single-quote, ESLint flat config. No code shared (ADR 0001); copy config files as starting point (`tsconfig.*.json`, `eslint.config.js`, `.prettierrc`, `vite.config.ts`, `.github/workflows/nodejs.yml`).
- New vs node-tlcv: **Vitest** (PRD needs tests); **chessground** (board, free piece movement); chess.js (PGN/SAN); Chart.js (eval graph). No socket.io — SSE.
- Gate per PR: `npm run lint && npm run check && npm test && npm run build`.
- Branches `feat/la-<n>-<slug>`, worktrees `~/projects/lichess-kibitzer-wt/<slug>`, remote `origin`. Conventional commits. PR body: `Stack n/11, on #X` + one scope line.
- Stack mechanics: `gh stack init --base main feat/la-1-scaffold`, then per layer commit → `gh stack add feat/la-<n>-<slug>`; finally `gh stack submit --auto --open`, then fix titles/bodies via `gh api -X PATCH …/pulls/N` (`gh pr edit` is broken). User merges.

## Lichess API (probed 2026-11-25, unauthenticated)

- `GET /api/broadcast/{tourId}` → `tour`, `rounds[] {id,name,ongoing,startsAt}`. tourId = last path segment of Event link.
- `GET /api/broadcast/-/-/{roundId}` → `games[] {id,name,fen,players[{name,title,rating,clock}],lastMove,status}`.
- `GET /api/stream/broadcast/round/{roundId}.pgn` → streaming PGN, whole game re-sent on update; all Boards in the Round, filter to Featured game (match tag to game id; confirm exact tag in PR 4 from a recorded fixture). Clocks from `{[%clk]}` comments.

## PRs

1. **`la-1-scaffold`** — package.json, TS/ESLint/Prettier/Vitest/Vite configs, CI workflow, `src/main.ts` + `src/app.ts` (Express, serves SPA, `/healthz`), empty Svelte shell (`web/src/App.svelte`, hash router: `/`, `/admin`), `AGENTS.md`, this plan as `docs/plans/live-analysis.md`.
2. **`la-2-accuracy`** — `shared/accuracy.ts`: pure `winPercent(cp|mate)`, `moveAccuracy`, `gameAccuracy`, `markFor` (inaccuracy/mistake/blunder). Port constants from lila (`AccuracyPercent.scala`, `WinPercent.scala`, `Advice.scala`). Tests vs values from known Lichess games.
3. **`la-3-uci-engine`** — `src/engine/uci-parser.ts` (`option`, `info` multipv/score/depth/nps/pv, `bestmove`), `src/engine/engine.ts` (spawn, `uci`→`uciok` w/ timeout = UCI check, `setoption`, `position`/`go`/`stop` serialised so `stop` awaits `bestmove`, kill). `test/fixtures/fake-uci.mjs` (scripted output, records received commands). Tests.
4. **`la-4-lichess-source`** — `src/lichess/api.ts` (link parse, tour, round), `src/lichess/stream.ts` (PGN stream → `{moves[], clocks, players, result}` for one Board; backoff 1s→60s cap; `connected|reconnecting` events). `Source` interface + file-replay fake. Recorded fixture `test/fixtures/round.pgn`. Tests incl. reconnect.
5. **`la-5-state-store`** — `shared/types.ts` (state `idle|live|finished`, per-ply `{eval, depth, source: backfill|final}`, config, SSE event union), `src/store.ts` (JSON load/atomic save, path from `DATA_FILE`), `src/state.ts` (transitions, snapshot). Tests.
6. **`la-6-kibitzer`** — `src/kibitzer.ts` orchestrator: pick → spawn + apply options → Backfill (`go movetime 100` per prior position) → Live loop (`stop` → record Final eval → `position` → `go infinite`); game end → stop, Finished; clear → kill, Idle; boot resume from store (positions missed while down → Backfill, no accuracy). Accuracy/marks only where both adjacent evals are Final; expose "from move N". PV UCI→SAN server-side. Tests with fake source + fake engine.
7. **`la-7-http-sse`** — `src/routes/events.ts` (SSE: snapshot on connect, then `state`/`move`/`info` (throttled ~4/s)/`stream-status`), `src/routes/admin.ts` (login w/ `ADMIN_PASSWORD` → HMAC cookie; list rounds/boards; probe engine path → options; set options; pick; clear; status). Top-level test per PRD: Backfill excluded from accuracy, `stop`/`position`/`go infinite` order, engine stops at game end, Idle has no process, reconnection.
8. **`la-8-viewer-core`** — `web/src/lib/live.svelte.ts` (EventSource store), Viewer page: board, players/ratings/clocks, eval bar, MultiPV lines, engine stats, move list w/ marks, accuracy % + "from move N", Idle/Finished/reconnecting states. Full-screen layout.
9. **`la-9-viewer-extras`** — eval graph (Chart.js), PV hover → end-position preview board, local piece moves (chessground free mode, no engine) + "back to live".
10. **`la-10-admin-page`** — login, Event link → Round → Board pickers, engine path + probe, form generated from UCI options (spin/check/combo/string/button), defaults (Berserk path, Threads=1, Hash=1024), clear, stream status.
11. **`la-11-deploy`** — `deploy/lichess-kibitzer.service` (systemd), `.env.example` (`PORT`, `ADMIN_PASSWORD`, `DATA_FILE`, `DEFAULT_ENGINE`), `docs/deploy.md`, README. Host/proxy/DNS/Berserk build = separate homelab (Gitea) work, not this stack.

## Verification

- Each PR: gate above green locally + CI.
- After PR 7: `npm run dev`, `curl -N localhost:PORT/api/events` against a real ongoing Round with a local Berserk.
- After PR 10: Playwright pass — admin login → pick live Board → viewer shows board/PVs/graph; hover PV; move piece + back to live; clear → "nothing live", `pgrep` shows no engine.

## Resolved (2026-11-25)

- Plan committed at `docs/plans/live-analysis.md` in PR 1.
- Downtime positions → Backfill, no accuracy.
- Svelte 5 + chessground + Chart.js.
- PR 11 ships a systemd service file, no Docker.
- Deployment (host, sizing, proxy, DNS, Berserk build) managed separately; out of this stack.

## Unresolved questions

None.

## Orchestration (per feature-trunk-orchestration + stacked-prs memories)

Per layer n, in worktree `~/projects/lichess-kibitzer-wt/la-<n>` on branch `feat/la-<n>-<slug>` cut from layer n-1:
1. planner subagent (opus) → layer plan in `docs/plans/la-<n>.md`? no — plan returned to orchestrator, kept in scratch.
2. plan-reviewer (opus); loop on feedback.
3. implementer (haiku) builds + runs gate + commits.
4. simplify/code-review (opus); loop on feedback via haiku.
Orchestrator never codes. After layer 11: `gh stack init --base main <all branches>` → `gh stack submit --auto --open` → patch bodies via `gh api`.
Notes: lila constants via WebFetch (no recall); accuracy fixture from `lichess.org/game/export/{id}?evals=true&accuracy=true`; record real round stream fixture; fake engine spawned via `process.execPath`; no node_modules/repo copies in scratchpad.
