import { describe, expect, it } from 'vitest';
import type { Score } from '../shared/accuracy.js';
import { arrows } from '../shared/arrows.js';
import type { PvLine } from '../shared/types.js';

const line = (s: number | Score, move: string, san: string[] = ['x']): PvLine => ({
  score: typeof s === 'number' ? { cp: s } : s,
  depth: 20,
  move,
  san,
});
const MOVES = ['e2e4', 'd2d4', 'g1f3', 'c2c4', 'b1c3'];
const table = (cps: number[]) => cps.map((cp, i) => line(cp, MOVES[i]));

describe('arrows', () => {
  it('draws line 1 best, then good and inaccuracy alternatives; hides mistakes and blunders', () => {
    const a = arrows(table([70, 60, 10, -70, -270]), 'white');
    expect(a.map((x) => [x.rank, x.strength, x.label, x.from, x.to])).toEqual([
      [0, 'best', '+0.70', 'e2', 'e4'],
      [1, 'good', '+0.60', 'd2', 'd4'],
      [2, 'inaccuracy', '+0.10', 'g1', 'f3'],
    ]);
  });

  it('judges alternatives from the side to move (scores are White POV)', () => {
    const a = arrows(table([-70, -60, -10, 70, 270]), 'black');
    expect(a.map((x) => [x.rank, x.strength, x.label])).toEqual([
      [0, 'best', '-0.70'],
      [1, 'good', '-0.60'],
      [2, 'inaccuracy', '-0.10'],
    ]);
  });

  it('handles mates', () => {
    const lost = arrows([line({ mate: 3 }, 'e2e4'), line(500, 'd2d4')], 'white');
    expect(lost.map((x) => x.label)).toEqual(['#3']);
    const delayed = arrows([line({ mate: -2 }, 'e7e5'), line({ mate: -4 }, 'd7d5')], 'black');
    expect(delayed.map((x) => x.label)).toEqual(['#-2', '#-4']);
    const blackLost = arrows([line({ mate: -3 }, 'e7e5'), line(-500, 'd7d5'), line({ mate: 3 }, 'g8f6')], 'black');
    expect(blackLost.map((x) => x.label)).toEqual(['#-3']);
  });

  it('keeps an alternative better than line 1', () => {
    const a = arrows([line(10, 'e2e4'), line(50, 'd2d4')], 'white');
    expect(a.map((x) => x.strength)).toEqual(['best', 'good']);
  });

  it('skips lines without a legal first move', () => {
    expect(arrows([line(10, 'e2e4'), line(5, 'e2e4', []), line(0, '', [])], 'white')).toHaveLength(1);
    expect(arrows([line(10, 'e2e4', []), line(5, 'd2d4')], 'white')).toEqual([]);
  });

  it('draws one arrow per first move, to the king square for castling and the pawn square for promotion', () => {
    const dup = arrows([line(10, 'e2e4'), line(9, 'd2d4'), line(8, 'e2e4')], 'white');
    expect(dup.map((x) => x.rank)).toEqual([0, 1]);
    const promo = arrows([line(10, 'e7e8q'), line(9, 'e7e8n')], 'white');
    expect(promo.map((x) => [x.from, x.to])).toEqual([['e7', 'e8']]);
    expect(arrows([line(10, 'e1g1')], 'white')[0]).toMatchObject({ from: 'e1', to: 'g1' });
  });

  it('draws nothing without lines and one best arrow for one line', () => {
    expect(arrows([], 'white')).toEqual([]);
    expect(arrows([line(10, 'e2e4')], 'white')).toMatchObject([{ rank: 0, strength: 'best' }]);
  });

  describe('with the main line', () => {
    it('draws it best, then the Lines judged against their own line 1, skipping its move', () => {
      const a = arrows(table([40, 30, -20, -100]), 'white', line(25, 'd2d4'));
      expect(a.map((x) => [x.rank, x.strength, x.label, x.from])).toEqual([
        [0, 'best', '+0.25', 'd2'],
        [1, 'good', '+0.40', 'e2'],
        [3, 'inaccuracy', '-0.20', 'g1'],
      ]);
    });

    it('without a usable main line, line 1 is best', () => {
      expect(arrows(table([40, 30]), 'white', line(25, 'd2d4', []))[0]).toMatchObject({ rank: 0, from: 'e2' });
      expect(arrows(table([40]), 'white', null)[0]).toMatchObject({ rank: 0, strength: 'best' });
    });

    it('draws it alone when there are no Lines', () => {
      expect(arrows([], 'white', line(25, 'd2d4')).map((x) => x.strength)).toEqual(['best']);
    });
  });
});
