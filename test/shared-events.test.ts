import { describe, expect, it } from 'vitest';
import { defaultTopN } from '../shared/events.js';

describe('defaultTopN', () => {
  it('shares DEFAULT_TOP_N between the registered Events, at least 1', () => {
    expect([1, 2, 3, 8, 9].map(defaultTopN)).toEqual([8, 4, 2, 1, 1]);
    expect(defaultTopN(0)).toBe(8);
  });
});
