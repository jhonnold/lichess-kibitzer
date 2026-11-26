import { describe, expect, it } from 'vitest';
import { tileView } from '../shared/overview.js';
import { positionAt } from '../shared/viewer.js';
import type { Board, Ply, Result } from '../shared/types.js';

const mv = (uci: string, clock: number | null): Ply => ({ move: { uci, san: uci, clock }, at: null, eval: null });
const start: Ply = { move: null, at: null, eval: null };
const board = (plies: Ply[], result: Result = '*'): Board => ({
  id: 'g3',
  board: 3,
  white: { name: 'White, A' },
  black: { name: 'Black, B' },
  result,
  tracked: true,
  opening: null,
  clocks: { white: 5000, black: 6000 },
  plies,
});

describe('tileView', () => {
  const live = board([start, mv('e2e4', 4000), mv('e7e5', 3000), mv('g1f3', 2000)]);

  it('Live: to move, clocks from the plies, latest position, href', () => {
    const t = tileView(live);
    expect(t).toMatchObject({ href: '#/board/3', state: 'live', result: null, toMove: 'black', mark: null });
    expect(t.clocks).toEqual({ white: 2000, black: 3000 });
    expect(t.position.fen).toBe(positionAt(live.plies, 3).fen);
    expect(t.position.lastMove).toEqual(['g1', 'f3']);
  });

  it('clocks fall back to the Board clocks before a side has moved', () => {
    expect(tileView(board([start, mv('e2e4', 4000)])).clocks).toEqual({ white: 4000, black: 6000 });
    expect(tileView(board([start])).clocks).toEqual({ white: 5000, black: 6000 });
  });

  it('Finished: result, nobody to move', () => {
    expect(tileView(board(live.plies, '1/2-1/2'))).toMatchObject({ state: 'finished', result: '½-½', toMove: null });
  });

  it('Upcoming: start position, no mark', () => {
    const t = tileView(board([start]));
    expect(t).toMatchObject({ state: 'upcoming', mark: null, toMove: null });
    expect(t.position.fen).toBe(positionAt([start], 0).fen);
  });

  it('passes the latest mark through', () => {
    const p = board([
      { ...start, eval: { score: { cp: 0 }, depth: 1, kind: 'complete', bestmove: 'e2e4', lines: [] } },
      { ...mv('f2f3', 4000), eval: { score: { cp: -300 }, depth: 1, kind: 'complete', bestmove: null, lines: [] } },
    ]);
    expect(tileView(p).mark).toBe('blunder');
  });
});
