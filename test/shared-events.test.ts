import { describe, expect, it } from 'vitest';
import { defaultTopN, unknownTour } from '../shared/events.js';
import type { Snapshot } from '../shared/types.js';

describe('defaultTopN', () => {
  it('shares DEFAULT_TOP_N between the registered Events, at least 1', () => {
    expect([1, 2, 3, 8, 9].map(defaultTopN)).toEqual([8, 4, 2, 1, 1]);
    expect(defaultTopN(0)).toBe(8);
  });
});

describe('unknownTour', () => {
  const snap = { events: [{ tourId: 'abcdefgh' }] } as unknown as Snapshot;
  it('is false before a snapshot and for the Primary route', () => {
    expect(unknownTour(null, 'abcdefgh')).toBe(false);
    expect(unknownTour(snap, null)).toBe(false);
  });
  it('is true only for an Event the snapshot does not list', () => {
    expect(unknownTour(snap, 'abcdefgh')).toBe(false);
    expect(unknownTour(snap, 'zzzzzzzz')).toBe(true);
  });
});
