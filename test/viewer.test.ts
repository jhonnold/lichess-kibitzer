import { DEFAULT_POSITION } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { winPercent } from '../shared/accuracy.js';
import type { Ply } from '../shared/types.js';
import { evalSeries, legalDests, play } from '../shared/viewer.js';

describe('play', () => {
  it('plays a SAN line (PV) to its end position', () => {
    expect(play(DEFAULT_POSITION, ['e4', 'e5', 'Nf3'])).toEqual({
      fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2',
      turn: 'black',
      check: false,
      lastMove: ['g1', 'f3'],
    });
  });

  it('plays board moves by squares, promoting, and reports check', () => {
    const p = play('7k/P7/8/8/8/8/8/K7 w - - 0 1', [{ from: 'a7', to: 'a8', promotion: 'q' }]);
    expect(p).toMatchObject({
      fen: 'Q6k/8/8/8/8/8/8/K7 b - - 0 1',
      turn: 'black',
      check: true,
      lastMove: ['a7', 'a8'],
    });
  });

  it('an empty line is the position itself', () => {
    expect(play(DEFAULT_POSITION, [])).toMatchObject({ fen: DEFAULT_POSITION, turn: 'white', lastMove: undefined });
  });

  it('throws on an illegal move', () => {
    expect(() => play(DEFAULT_POSITION, ['Nf6'])).toThrow();
  });
});

describe('legalDests', () => {
  it('maps each movable piece of the side to move to its targets', () => {
    const d = legalDests(DEFAULT_POSITION);
    expect(d.size).toBe(10);
    expect(d.get('g1')).toEqual(['f3', 'h3']);
    expect(d.get('e2')).toEqual(['e3', 'e4']);
    expect(d.has('e7')).toBe(false);
  });

  it('is empty when mated', () => {
    expect(legalDests('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3').size).toBe(0);
  });
});

describe('evalSeries', () => {
  const ply = (cp: number | null, kind: 'backfill' | 'final' = 'final'): Ply => ({
    move: null,
    eval: cp === null ? null : { score: { cp }, depth: 1, kind, bestmove: null },
  });

  it('White win % per ply, gaps for no eval, Backfill flagged', () => {
    const s = evalSeries([ply(0, 'backfill'), ply(100), ply(null)], null);
    expect(s.win).toEqual([50, winPercent({ cp: 100 }), null]);
    expect(s.backfill).toEqual([true, false, false]);
  });

  it('the Live score stands in for the current position', () => {
    expect(evalSeries([ply(0), ply(null)], { mate: -3 }).win).toEqual([50, winPercent({ mate: -3 })]);
  });
});
