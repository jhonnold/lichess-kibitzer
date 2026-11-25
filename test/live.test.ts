import { describe, expect, it } from 'vitest';
import { applyEvent } from '../shared/live.js';
import type { LiveInfo, Ply, Snapshot } from '../shared/types.js';

const ref = { tourId: 't', roundId: 'r', id: 'g', white: { name: 'W' }, black: { name: 'B' } };
const move = (uci: string): Ply => ({ move: { uci, san: uci, clock: null }, eval: null });
const evald: Ply = { move: null, eval: { score: { cp: 20 }, depth: 10, kind: 'final', bestmove: 'e2e4' } };
const info = (ply: number): LiveInfo => ({ ply, engine: 'E', depth: 5, nps: 1, lines: [] });
const live = (): Snapshot => ({
  site: 'live',
  game: { ...ref, result: '*', plies: [{ move: null, eval: null }, move('e2e4')] },
  live: info(1),
  stream: 'connected',
});

describe('applyEvent', () => {
  it('snapshot replaces everything, even before the first one', () => {
    const s = live();
    expect(applyEvent(null, { type: 'snapshot', snapshot: s })).toBe(s);
    const idle: Snapshot = { site: 'idle', game: null, live: null, stream: null };
    expect(applyEvent(s, { type: 'snapshot', snapshot: idle })).toBe(idle);
  });

  it('ignores patches with no snapshot or no game', () => {
    expect(applyEvent(null, { type: 'info', live: info(0) })).toBeNull();
    const idle: Snapshot = { site: 'idle', game: null, live: null, stream: null };
    expect(applyEvent(idle, { type: 'ply', index: 0, ply: evald })).toBe(idle);
  });

  it('ply replaces an eval in place and keeps the Live info', () => {
    const s = live();
    const next = applyEvent(s, { type: 'ply', index: 0, ply: evald })!;
    expect(next.game!.plies).toEqual([evald, move('e2e4')]);
    expect(next.live).toBe(s.live);
    expect(s.game!.plies[0]).toEqual({ move: null, eval: null }); // not mutated
  });

  it('ply appends a new move and drops the now-stale info', () => {
    const next = applyEvent(live(), { type: 'ply', index: 2, ply: move('e7e5') })!;
    expect(next.game!.plies.map((p) => p.move?.uci)).toEqual([undefined, 'e2e4', 'e7e5']);
    expect(next.live).toBeNull();
    expect(applyEvent(live(), { type: 'ply', index: 5, ply: move('x') })).toEqual(live()); // gap: ignored
  });

  it('info is kept only for the Live position; null clears it', () => {
    const s = live();
    expect(applyEvent(s, { type: 'info', live: info(0) })).toBe(s);
    expect(applyEvent(s, { type: 'info', live: info(1) })!.live).toEqual(info(1));
    expect(applyEvent(s, { type: 'info', live: null })!.live).toBeNull();
  });

  it('stream-status updates the stream', () => {
    expect(applyEvent(live(), { type: 'stream-status', status: 'reconnecting' })!.stream).toBe('reconnecting');
  });
});
