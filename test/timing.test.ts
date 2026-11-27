import { describe, expect, it } from 'vitest';
import { estimatedLoad, jobTiming, percentile, spread, type JobSample } from '../shared/timing.js';

describe('percentile', () => {
  it('is null for no values and the value for one', () => {
    expect(percentile([], 50)).toBeNull();
    expect([percentile([5], 50), percentile([5], 95)]).toEqual([5, 5]);
  });

  it('uses the nearest rank, whatever the input order, without mutating it', () => {
    const asc = Array.from({ length: 100 }, (_, i) => i + 1);
    expect([percentile(asc, 50), percentile(asc, 95)]).toEqual([50, 95]);
    const shuffled = [3, 1, 2];
    expect(percentile(shuffled, 50)).toBe(2);
    expect(shuffled).toEqual([3, 1, 2]);
    expect([percentile([1, 2], 50), percentile([1, 2], 95)]).toEqual([1, 2]);
  });
});

describe('spread', () => {
  it('is null when empty, else p50 and p95', () => {
    expect(spread([])).toBeNull();
    expect(spread([4, 1, 2, 3])).toEqual({ p50: 2, p95: 4 });
  });
});

describe('jobTiming', () => {
  const s = (ms: number, depth: number, kind: JobSample['kind']): JobSample => ({ ms, depth, kind });

  it('spreads Complete Jobs only and counts Provisional ones', () => {
    const t = jobTiming([s(10, 20, 'complete'), s(1, 3, 'provisional'), s(30, 24, 'complete')]);
    expect(t).toEqual({ jobs: 2, provisional: 1, ms: { p50: 10, p95: 30 }, depth: { p50: 20, p95: 24 } });
  });

  it('has no spreads when every Job was Provisional', () => {
    expect(jobTiming([s(1, 3, 'provisional')])).toEqual({ jobs: 0, provisional: 1, ms: null, depth: null });
  });
});

describe('estimatedLoad', () => {
  it('is tracked Boards x job time over one position per Board per 176 s', () => {
    expect(estimatedLoad(8, 15000)).toBeCloseTo(0.68, 2);
    expect(estimatedLoad(16, 15000)).toBeCloseTo(1.36, 2);
    expect(estimatedLoad(0, 15000)).toBe(0);
    expect(estimatedLoad(8, null)).toBeNull();
  });
});
