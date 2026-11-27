import { describe, expect, it } from 'vitest';
import { defaultTopN, eventCards, unknownTour } from '../shared/events.js';
import type { EventSummary, Snapshot } from '../shared/types.js';

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

describe('eventCards', () => {
  const ev = (tourId: string, over: Partial<EventSummary>): EventSummary => ({
    tourId,
    name: `Event ${tourId}`,
    primary: false,
    round: null,
    live: false,
    tracked: 0,
    ...over,
  });
  const round = { roundId: 'rrrrrrr1', name: 'Round 3', startsAt: 5000 };
  it('live, upcoming (with startsAt) and idle, in registration order', () => {
    const cards = eventCards([
      ev('bbbbbbbb', { round, live: true, tracked: 4, primary: true }),
      ev('aaaaaaaa', { round, tracked: 2 }),
      ev('cccccccc', {}),
    ]);
    expect(cards.map((c) => [c.tourId, c.state, c.round, c.startsAt, c.tracked, c.primary])).toEqual([
      ['bbbbbbbb', 'live', 'Round 3', null, 4, true],
      ['aaaaaaaa', 'upcoming', 'Round 3', 5000, 2, false],
      ['cccccccc', 'idle', null, null, 0, false],
    ]);
    expect(cards[0].href).toBe('#/e/bbbbbbbb/round');
  });
  it('no Current Round: next or finished link to the Archive; no Rounds or not polled yet is idle', () => {
    const next = { name: 'Round 4', startsAt: 9000 };
    const cards = eventCards([
      ev('aaaaaaaa', { next, finished: false }),
      ev('bbbbbbbb', { next: null, finished: true }),
      ev('cccccccc', { next: null, finished: false }),
      ev('dddddddd', {}),
      ev('eeeeeeee', { round, next, finished: false }), // a Current Round wins
    ]);
    expect(cards.map((c) => [c.state, c.href, c.next, c.polled])).toEqual([
      ['next', '#/archive', next, true],
      ['finished', '#/archive', null, true],
      ['idle', '#/e/cccccccc/round', null, true],
      ['idle', '#/e/dddddddd/round', null, false],
      ['upcoming', '#/e/eeeeeeee/round', null, true],
    ]);
  });
});
