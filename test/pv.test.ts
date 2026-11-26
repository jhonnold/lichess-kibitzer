import { describe, expect, it } from 'vitest';
import { pvToSan, toScore } from '../src/pv.js';

describe('pv', () => {
  it('maps scores to White POV and PVs to SAN', () => {
    expect([toScore({ unit: 'cp', value: 50 }, 1), toScore({ unit: 'mate', value: 3 }, 1)]).toEqual([
      { cp: -50 },
      { mate: -3 },
    ]);
    expect(toScore({ unit: 'mate', value: 0 }, 4)).toBeNull();
    expect(pvToSan('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', ['g1f3', 'g8f6', 'e1e8'])).toEqual([
      'Nf3',
      'Nf6',
    ]);
  });
});
