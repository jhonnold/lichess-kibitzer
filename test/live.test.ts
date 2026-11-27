import { describe, expect, it } from 'vitest';
import { applyEvent } from '../shared/live.js';
import type { Board, Ply, SearchInfo, Snapshot } from '../shared/types.js';

const ply = (uci?: string): Ply => ({ move: uci ? { uci, san: uci, clock: null } : null, at: null, eval: null });
const board = (id: string, n: number, plies = [ply()]): Board => ({
  id,
  board: n,
  white: { name: 'W' },
  black: { name: 'B' },
  result: '*',
  tracked: true,
  opening: null,
  clocks: { white: null, black: null },
  plies,
});
const snap = (): Snapshot => ({
  events: [],
  event: null,
  round: {
    tourId: 't',
    roundId: 'r',
    name: 'R1',
    eventName: 'E',
    startsAt: null,
    boards: [board('a', 1, [ply(), ply('e2e4')]), board('c', 3)],
  },
  search: null,
  queue: { current: [], backfill: 0, deferred: [] },
  stream: null,
});
const idle = (): Snapshot => ({ ...snap(), round: null });
const search: SearchInfo = { boardId: 'a', ply: 1, engine: 'E', depth: 5, nps: 1, lines: [], startedAt: 0 };
const ids = (s: Snapshot | null) => s?.round?.boards.map((b) => b.id);

describe('applyEvent', () => {
  it('snapshot replaces everything, even before the first one', () => {
    const s = snap();
    expect(applyEvent(null, { type: 'snapshot', snapshot: s })).toBe(s);
    const i = idle();
    expect(applyEvent(s, { type: 'snapshot', snapshot: i })).toBe(i);
  });

  it('returns the same reference for patches before a snapshot or with no Round', () => {
    const i = idle();
    expect(applyEvent(null, { type: 'search', search })).toBeNull();
    expect(applyEvent(i, { type: 'ply', boardId: 'a', index: 0, ply: ply() })).toBe(i);
    expect(applyEvent(i, { type: 'untrack', boardId: 'a' })).toBe(i);
    expect(applyEvent(i, { type: 'board', board: board('a', 1) })).toBe(i);
    expect(applyEvent(i, { type: 'result', boardId: 'a', result: '1-0' })).toBe(i);
  });

  it('board replaces by id, else inserts in board order', () => {
    const replaced = applyEvent(snap(), { type: 'board', board: board('a', 1, [ply()]) });
    expect(replaced?.round?.boards[0].plies).toHaveLength(1);
    expect(ids(applyEvent(snap(), { type: 'board', board: board('b', 2) }))).toEqual(['a', 'b', 'c']);
    expect(ids(applyEvent(snap(), { type: 'board', board: board('z', 0) }))).toEqual(['z', 'a', 'c']);
  });

  it('untrack removes a Board; an unknown id changes nothing', () => {
    expect(ids(applyEvent(snap(), { type: 'untrack', boardId: 'a' }))).toEqual(['c']);
    const s = snap();
    expect(applyEvent(s, { type: 'untrack', boardId: 'x' })).toBe(s);
  });

  it('ply appends at the end, replaces below it, ignores a gap or an unknown Board', () => {
    const appended = applyEvent(snap(), { type: 'ply', boardId: 'a', index: 2, ply: ply('e7e5') });
    expect(appended?.round?.boards[0].plies.map((p) => p.move?.uci)).toEqual([undefined, 'e2e4', 'e7e5']);
    const eval1: Ply = {
      ...ply('e2e4'),
      eval: { score: { cp: 1 }, depth: 1, kind: 'complete', bestmove: null, lines: [] },
    };
    const replaced = applyEvent(snap(), { type: 'ply', boardId: 'a', index: 1, ply: eval1 });
    expect(replaced?.round?.boards[0].plies).toEqual([ply(), eval1]);
    const s = snap();
    expect(applyEvent(s, { type: 'ply', boardId: 'a', index: 5, ply: ply('x') })).toBe(s);
    expect(applyEvent(s, { type: 'ply', boardId: 'x', index: 0, ply: ply() })).toBe(s);
  });

  it('result sets the result of that Board only', () => {
    const next = applyEvent(snap(), { type: 'result', boardId: 'a', result: '1-0' });
    expect(next?.round?.boards.map((b) => b.result)).toEqual(['1-0', '*']);
    const s = snap();
    expect(applyEvent(s, { type: 'result', boardId: 'x', result: '1-0' })).toBe(s);
  });

  it('events replaces the summaries and keeps the rest; before a snapshot it is a no-op', () => {
    const events = [{ tourId: 'x', name: 'X', primary: true, round: null, live: false, tracked: 0 }];
    const s = snap();
    expect(applyEvent(s, { type: 'events', events })).toEqual({ ...s, events });
    expect(applyEvent(null, { type: 'events', events })).toBeNull();
  });

  it('search, queue and stream-status are set as sent', () => {
    expect(applyEvent(snap(), { type: 'search', search })?.search).toBe(search);
    expect(
      applyEvent(snap(), { type: 'queue', queue: { current: [], backfill: 4, deferred: [] } })?.queue.backfill,
    ).toBe(4);
    expect(applyEvent(snap(), { type: 'stream-status', status: 'reconnecting' })?.stream).toBe('reconnecting');
  });

  it('never mutates its input', () => {
    const s = snap();
    const before = structuredClone(s);
    applyEvent(s, { type: 'ply', boardId: 'a', index: 2, ply: ply('e7e5') });
    applyEvent(s, { type: 'board', board: board('b', 2) });
    applyEvent(s, { type: 'untrack', boardId: 'a' });
    applyEvent(s, { type: 'result', boardId: 'a', result: '0-1' });
    expect(s).toEqual(before);
  });
});
