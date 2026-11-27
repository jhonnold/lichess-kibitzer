import type { Snapshot, SseEvent } from './types.js';

/** The SSE URL for an Event; null = the Primary (the server's default). */
export const eventsUrl = (tour: string | null): string =>
  tour === null ? '/api/events' : `/api/events?tour=${encodeURIComponent(tour)}`;

/**
 * A Viewer's copy of the site state, from the SSE stream. `snapshot` replaces it; the rest patch the Current Round's
 * Tracked boards. Pure: never mutates `s`; a patch that changes nothing (no snapshot yet, no Round, unknown Board,
 * a gap in the plies) returns `s` itself. `search` is kept as sent: the Viewer decides if it is relevant.
 */
export function applyEvent(s: Snapshot | null, e: SseEvent): Snapshot | null {
  if (e.type === 'snapshot') return e.snapshot;
  if (!s) return s;
  switch (e.type) {
    case 'search':
      return { ...s, search: e.search };
    case 'queue':
      return { ...s, queue: e.queue };
    case 'stream-status':
      return { ...s, stream: e.status };
    case 'events':
      return { ...s, events: e.events };
  }
  const round = s.round;
  if (!round) return s;
  const withBoards = (boards: typeof round.boards): Snapshot => ({ ...s, round: { ...round, boards } });
  switch (e.type) {
    case 'board': {
      const i = round.boards.findIndex((b) => b.id === e.board.id);
      if (i >= 0) return withBoards(round.boards.map((b, j) => (j === i ? e.board : b)));
      return withBoards([...round.boards, e.board].sort((a, b) => a.board - b.board));
    }
    case 'untrack':
      return round.boards.some((b) => b.id === e.boardId)
        ? withBoards(round.boards.filter((b) => b.id !== e.boardId))
        : s;
    case 'ply': {
      const b = round.boards.find((x) => x.id === e.boardId);
      if (!b || e.index < 0 || e.index > b.plies.length) return s;
      const plies = [...b.plies];
      plies[e.index] = e.ply;
      return withBoards(round.boards.map((x) => (x === b ? { ...b, plies } : x)));
    }
    case 'result':
      if (!round.boards.some((b) => b.id === e.boardId)) return s;
      return withBoards(round.boards.map((b) => (b.id === e.boardId ? { ...b, result: e.result } : b)));
  }
}
