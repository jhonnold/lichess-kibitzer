import { describe, expect, it } from 'vitest';
import { DEEP_PASS, maxPass, nextPass, passesError } from '../shared/passes.js';
import type { Eval } from '../shared/types.js';

const ev = (kind: Eval['kind'], ms?: number): Eval => ({
  score: { cp: 0 },
  depth: 20,
  kind,
  bestmove: null,
  lines: [],
  ...(ms !== undefined && { ms }),
});

describe('nextPass', () => {
  const passes = [1000, 10_000, 100_000] as const;
  it('is Pass 0 until a Complete eval, then the first automatic Pass it searched less than', () => {
    expect(nextPass(null, 4, [...passes])).toBe(0);
    expect(nextPass(ev('provisional', 50_000), 4, [...passes])).toBe(0);
    expect(nextPass(ev('complete', 1000), 4, [...passes])).toBe(1);
    expect(nextPass(ev('complete', 9999), 4, [...passes])).toBe(1);
    expect(nextPass(ev('complete', 10_000), 4, [...passes])).toBeNull(); // the deep Pass is on demand only
    expect(nextPass(ev('complete', 100_000), 4, [...passes])).toBeNull();
  });

  it('counts a Complete eval recorded before Passes as Pass 0 only', () => {
    expect(nextPass(ev('complete'), 4, [...passes])).toBe(1);
  });

  it('skips a Pass that is off', () => {
    expect(nextPass(ev('complete', 1000), 4, [1000, null, 100_000])).toBeNull();
    expect(nextPass(ev('complete', 1000), 4, [1000, null, null])).toBeNull();
  });

  it('gives the start position Pass 0 only, and only Pass 0 while the Passes are unset', () => {
    expect(nextPass(null, 0, [...passes])).toBe(0);
    expect(nextPass(ev('complete', 1000), 0, [...passes])).toBeNull();
    expect(nextPass(null, 3, null)).toBe(0);
    expect(nextPass(ev('complete', 1000), 3, null)).toBeNull();
  });
});

describe('maxPass', () => {
  it('allows the top Pass only while no Event is live', () => {
    expect([maxPass(false), maxPass(true)]).toEqual([DEEP_PASS, DEEP_PASS - 1]);
  });
});

describe('passesError', () => {
  it('accepts three ascending slots, the last two may be off', () => {
    expect(passesError([1000, 10_000, 100_000], 3600_000)).toBeNull();
    expect(passesError([1000, null, 100_000], 3600_000)).toBeNull();
    expect(passesError([1000, null, null], 3600_000)).toBeNull();
  });
  it.each([
    [null],
    [[1000]],
    [[0, null, null]],
    [[null, 10, null]],
    [[10, 10, null]],
    [[10, null, 5]],
    [[10, 1.5, null]],
    [[4e6, null, null]],
  ])('%j is refused', (x) => expect(passesError(x, 3600_000)).not.toBeNull());
});
