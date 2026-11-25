# lichess-kibitzer

Full-screen live engine analysis of a Lichess broadcast game. An Admin picks one Board from a Lichess
broadcast and a UCI engine (default Berserk); Viewers see the board, clocks, eval bar and graph, MultiPV
lines, move marks and accuracy, streamed over SSE.

## Development

Requires Node `^20.19.0 || >=22.12.0`.

```bash
npm install
npm run build                       # vite build (web/ → build/public) + tsc (build/src)
ADMIN_PASSWORD=pw npm run dev-server   # backend on :8080, restarts on src/ changes
npm run dev-public                  # rebuild the SPA on web/ changes
npm run lint && npm run check && npm test   # gate (plus npm run build)
```

Environment variables: [`.env.example`](./.env.example). The app does not load `.env`; export them in
your shell or pass them inline.

## Docs

- [Deploying](./docs/deploy.md) — systemd unit, environment, Caddy, updates
- [AGENTS.md](./AGENTS.md) — commands, conventions, code map
- [Plan](./docs/plans/live-analysis.md)
