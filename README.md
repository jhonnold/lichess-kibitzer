# lichess-kibitzer

Full-screen live engine analysis of a Lichess broadcast. An Admin registers one or more Events (the first is the Primary Event); the app follows each Round by
Round, Tracks the top N Boards of each Round, and one UCI engine (default Berserk) works through a Queue of Jobs
(newest positions first, Backfill for the rest). Viewers get ticking clocks, eval bar and graph, MultiPV lines with
engine arrows, move marks, accuracy and the opening name, streamed over SSE. A Cursor steps through the game and
branches into own moves; an overview shows every Tracked Board; finished Rounds stay in the Archive.

## Viewer URLs

| URL | Page |
|-----|------|
| `#/` | The Events page when several Events are followed, else the Primary Event's lowest-numbered Tracked Board |
| `#/e/<tourId>` | That Event's lowest-numbered Tracked Board |
| `#/e/<tourId>/board/n[/ply]` | Board n of that Event; `ply` opens with the Cursor on that ply |
| `#/e/<tourId>/round` | Overview of that Event's Tracked Boards |
| `#/board/n[/ply]`, `#/round` | The same for the Primary Event (old links keep working) |
| `#/archive` | Archived Rounds |
| `#/archive/T/R[/board/n[/ply]]` | Archived Round R of Event T: overview, or a Board (and ply) |
| `#/admin` | Admin (password) |

Several Events can be registered on the Admin page; the Primary Event is the first one, or the one the Admin chooses. The
Tracked boards default to 8 shared by the registered Events.

The Cursor updates the address bar without adding history entries, so the URL is always a link to the move on
screen; following live keeps it clean. Keys: `←` `→` step, `Home` first position, `End` back to live, `a` arrows,
`f` flip the board, `o` overview.

Streaming layout, as `?` params after the route (for example an OBS browser source,
`https://host/#/board/1?chrome=0&bg=transparent`). They are kept by Cursor URL updates and Board links.

| Param | Effect |
|-------|--------|
| `chrome=0` | Hide the Board strip, links, banners and warnings, Cursor note and accuracy line (overview: its header) |
| `panel=0` | Hide the side panel: eval bar, player bars and a larger board remain |
| `arrows=0` / `arrows=1` | Hide / show engine arrows for this page, whatever the stored `a` preference |
| `flip=1` / `flip=0` | Black / White at the bottom for this page, whatever the stored `f` preference |
| `bg=transparent` | Transparent page background |

## Demo

`npm run build && npm run demo -- --boards 3 --interval 2000` serves a synthesized Round with a fake engine on
`:18457` (Admin password `demo`; flags in the header of `scripts/demo.ts`). It never contacts Lichess.

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
- [Plan](./docs/plans/live-analysis.md), [v2 plan](./docs/plans/v2.md), [multi-Event plan](./docs/plans/multi-event.md) (each with an *As built* section)
- [Default job time](./docs/jobtime.md)
