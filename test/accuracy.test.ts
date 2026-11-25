import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { gameAccuracy, moveAccuracy, moveMark, winPercent, type Score } from '../shared/accuracy.js';

interface Ply {
  eval?: number;
  mate?: number;
  best?: string;
  judgment?: string;
}
const fixture = JSON.parse(readFileSync(new URL('./fixtures/lichess-sTbk79vJ.json', import.meta.url), 'utf8')) as {
  initialEval: Score;
  accuracy: { white: number; black: number };
  analysis: Ply[];
};
const evals: Score[] = [
  fixture.initialEval,
  ...fixture.analysis.map((p): Score => (p.mate !== undefined ? { mate: p.mate } : { cp: p.eval as number })),
];

describe('winPercent', () => {
  it('is 50 at 0 cp and symmetric', () => {
    expect(winPercent({ cp: 0 })).toBe(50);
    expect(winPercent({ cp: 100 })).toBeCloseTo(59.1026, 4);
    expect(winPercent({ cp: 300 }) + winPercent({ cp: -300 })).toBeCloseTo(100, 10);
  });

  it('ceils cp at ±1000 and treats mate as ±1000', () => {
    expect(winPercent({ cp: 2000 })).toBe(winPercent({ cp: 1000 }));
    expect(winPercent({ mate: 3 })).toBe(winPercent({ cp: 1000 }));
    expect(winPercent({ mate: -1 })).toBe(winPercent({ cp: -1000 }));
  });
});

describe('moveAccuracy', () => {
  it('is 100 when the mover does not lose win%', () => {
    expect(moveAccuracy({ cp: 0 }, { cp: 50 }, 'white')).toBe(100);
    expect(moveAccuracy({ cp: 0 }, { cp: 0 }, 'black')).toBe(100);
  });

  it('follows the lila curve from the mover side', () => {
    expect(moveAccuracy({ cp: 0 }, { cp: -100 }, 'white')).toBeCloseTo(67.2397, 4);
    expect(moveAccuracy({ cp: 0 }, { cp: 100 }, 'black')).toBeCloseTo(67.2397, 4);
    expect(moveAccuracy({ mate: 2 }, { mate: -2 }, 'white')).toBe(0);
  });
});

describe('gameAccuracy', () => {
  it('reproduces Lichess accuracy for game sTbk79vJ', () => {
    const acc = gameAccuracy(evals, 'white');
    expect(Math.round(acc.white ?? -1)).toBe(fixture.accuracy.white);
    expect(Math.round(acc.black ?? -1)).toBe(fixture.accuracy.black);
  });

  it('scores a slice that starts mid-game', () => {
    const acc = gameAccuracy(evals.slice(20), 'white');
    expect(acc.white).toBeCloseTo(73.6004, 4);
    expect(acc.black).toBeCloseTo(66.2263, 4);
  });

  it('returns null for a colour with no scored move', () => {
    expect(gameAccuracy([], 'white')).toEqual({ white: null, black: null });
    expect(gameAccuracy([{ cp: 0 }], 'white')).toEqual({ white: null, black: null });
  });

  it('skips moves touching a missing eval', () => {
    const e = [{ cp: 0 }, null, { cp: 0 }, { cp: 0 }];
    expect(gameAccuracy(e, 'white')).toEqual({ white: 100, black: null });
    expect(gameAccuracy(e, 'black')).toEqual({ white: null, black: 100 });
  });
});

describe('moveMark', () => {
  it('matches every Lichess judgment in game sTbk79vJ', () => {
    fixture.analysis.forEach((p, i) => {
      if (p.judgment) expect(p.best).toBeDefined();
      if (!p.best) return; // lila does not judge the engine's best move
      const mover = i % 2 === 0 ? 'white' : 'black';
      expect(moveMark(evals[i], evals[i + 1], mover), `ply ${i + 1}`).toBe(p.judgment?.toLowerCase() ?? null);
    });
  });

  it('uses 0.1 / 0.2 / 0.3 winning-chance thresholds', () => {
    expect(moveMark({ cp: 0 }, { cp: -50 }, 'white')).toBeNull();
    expect(moveMark({ cp: 0 }, { cp: -60 }, 'white')).toBe('inaccuracy');
    expect(moveMark({ cp: 0 }, { cp: -120 }, 'white')).toBe('mistake');
    expect(moveMark({ cp: 0 }, { cp: 200 }, 'black')).toBe('blunder');
  });

  it('judges mate created and mate lost by the cp on the other side', () => {
    expect(moveMark({ cp: -1200 }, { mate: -3 }, 'white')).toBe('inaccuracy');
    expect(moveMark({ cp: -800 }, { mate: -3 }, 'white')).toBe('mistake');
    expect(moveMark({ cp: 50 }, { mate: -3 }, 'white')).toBe('blunder');
    expect(moveMark({ mate: 2 }, { cp: 1200 }, 'white')).toBe('inaccuracy');
    expect(moveMark({ mate: -2 }, { cp: -800 }, 'black')).toBe('mistake');
    expect(moveMark({ mate: 2 }, { mate: -4 }, 'white')).toBe('blunder');
  });

  it('does not mark a delayed mate or a found mate', () => {
    expect(moveMark({ mate: 2 }, { mate: 5 }, 'white')).toBeNull();
    expect(moveMark({ cp: 300 }, { mate: 4 }, 'white')).toBeNull();
  });
});
