import { describe, expect, it } from 'vitest';
import { isDue, rollover, swapAt, SWAP_LEAD_MS, type RoundRef } from '../shared/rollover.js';

const NOW = 1_000_000_000;
const MIN = 60_000;
const r = (id: string, over: Partial<RoundRef> = {}): RoundRef => ({ id, ongoing: false, finished: false, ...over });
const ids = (x: ReturnType<typeof rollover>) => [x.current?.id ?? null, x.next?.id ?? null];

describe('swapAt / isDue', () => {
  it('swaps 10 minutes before startsAt; null without it', () => {
    expect(swapAt(r('a', { startsAt: 5_000_000 }))).toBe(5_000_000 - 600_000);
    expect(swapAt(r('a'))).toBeNull();
    expect(SWAP_LEAD_MS).toBe(600_000);
  });

  it('is due when ongoing, finished or inside the lead window', () => {
    expect(isDue(r('a', { ongoing: true }), NOW)).toBe(true);
    expect(isDue(r('a', { finished: true }), NOW)).toBe(true);
    expect(isDue(r('a', { startsAt: NOW + 10 * MIN }), NOW)).toBe(true);
    expect(isDue(r('a', { startsAt: NOW + 10 * MIN + 1 }), NOW)).toBe(false);
    expect(isDue(r('a'), NOW)).toBe(false);
  });
});

describe('rollover', () => {
  it.each([
    ['no Rounds', [], null, [null, null]],
    [
      'registration: ongoing R2 of 3',
      [r('R1', { finished: true }), r('R2', { ongoing: true }), r('R3')],
      null,
      ['R2', 'R3'],
    ],
    [
      'registration: all finished → the last',
      [r('R1', { finished: true }), r('R2', { finished: true })],
      null,
      ['R2', null],
    ],
    ['registration: nothing due → the first', [r('R1', { startsAt: NOW + 99 * MIN }), r('R2')], null, ['R1', 'R2']],
    [
      'registration: R1 ongoing and R2 due by time → R2',
      [r('R1', { ongoing: true }), r('R2', { startsAt: NOW })],
      null,
      ['R2', null],
    ],
    ['R2 at startsAt − 10 min − 1: stays R1', [r('R1'), r('R2', { startsAt: NOW + 10 * MIN + 1 })], 'R1', ['R1', 'R2']],
    ['R2 at startsAt − 10 min: swaps', [r('R1'), r('R2', { startsAt: NOW + 10 * MIN })], 'R1', ['R2', null]],
    ['R2 without startsAt, not ongoing: stays R1', [r('R1', { ongoing: true }), r('R2')], 'R1', ['R1', 'R2']],
    ['R2 without startsAt, ongoing: swaps', [r('R1'), r('R2', { ongoing: true })], 'R1', ['R2', null]],
    ['never backwards: R1 ongoing again while R2 current', [r('R1', { ongoing: true }), r('R2')], 'R2', ['R2', null]],
    [
      'missed two Rounds: R3 is due',
      [r('R1'), r('R2', { finished: true }), r('R3', { ongoing: true })],
      'R1',
      ['R3', null],
    ],
    ['current id removed on Lichess: keep it', [r('R1', { ongoing: true })], 'gone', [null, null]],
    ['last Round current: itself, nothing next', [r('R1'), r('R2', { finished: true })], 'R2', ['R2', null]],
  ] as [string, RoundRef[], string | null, (string | null)[]][])('%s', (_name, rounds, cur, want) => {
    expect(ids(rollover(rounds, cur, NOW))).toEqual(want);
  });

  it('reports when the next Round is swapped in, from array order not startsAt', () => {
    const rounds = [r('R1'), r('R2', { startsAt: NOW + 3_600_000 }), r('R3', { startsAt: NOW + 3_000_000 })];
    expect(rollover(rounds, 'R1', NOW).swapAt).toBe(NOW + 3_600_000 - 600_000);
    expect(rollover([r('R1'), r('R2')], 'R1', NOW).swapAt).toBeNull();
    expect(rollover([r('R1')], 'R1', NOW).swapAt).toBeNull();
  });
});
