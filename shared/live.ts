import type { Snapshot, SseEvent } from './types.js';

/**
 * A Viewer's copy of the site state, from the SSE stream. `snapshot` replaces it; `ply` upserts a position;
 * `info` is kept only for the Live position, so stale PV lines never show after a move. Pure: never mutates `s`.
 */
export function applyEvent(s: Snapshot | null, e: SseEvent): Snapshot | null {
  if (e.type === 'snapshot') return e.snapshot;
  if (!s?.game) return s; // the server sends a snapshot first; with no game only a new snapshot changes anything
  switch (e.type) {
    case 'ply': {
      if (e.index < 0 || e.index > s.game.plies.length) return s;
      const plies = [...s.game.plies];
      plies[e.index] = e.ply;
      return { ...s, game: { ...s.game, plies }, live: s.live?.ply === plies.length - 1 ? s.live : null };
    }
    case 'info':
      return e.live && e.live.ply !== s.game.plies.length - 1 ? s : { ...s, live: e.live };
    case 'stream-status':
      return { ...s, stream: e.status };
  }
}
