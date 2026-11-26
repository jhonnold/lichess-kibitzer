import { describe, expect, it } from 'vitest';
import { formatJobTime, jobTimeMs } from '../shared/admin-form.js';

describe('jobTimeMs', () => {
  it('converts seconds to ms', () => {
    expect(jobTimeMs('7.5')).toBe(7500);
    expect(jobTimeMs('1')).toBe(1000);
    expect(jobTimeMs('0.1')).toBe(100);
  });
  it.each(['', ' ', '0', '0.0004', '-1', 'x', 'Infinity'])('%j is invalid', (s) => expect(jobTimeMs(s)).toBeNull());
});

describe('formatJobTime', () => {
  it('shows unset, and seconds', () => {
    expect(formatJobTime(null)).toBe('unset — the Queue is idle');
    expect(formatJobTime(7500)).toBe('7.5 s');
    expect(formatJobTime(20000)).toBe('20 s');
  });
});
