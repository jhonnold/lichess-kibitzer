import { describe, expect, it } from 'vitest';
import { boardIndex, formatJobTime, jobTimeMs, mergeForms, trackedIds, type EvBlock } from '../shared/admin-form.js';

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

const ev = (tourId: string, boards: [string, number, boolean][] | null): EvBlock => ({
  event: { tourId, name: `Event ${tourId}` },
  round: boards && { boards: boards.map(([id, board, tracked]) => ({ id, board, tracked })) },
});

describe('trackedIds', () => {
  it('lists the Tracked Boards in board order, and nothing without a Round', () => {
    expect(
      trackedIds(
        ev('A', [
          ['a1', 1, true],
          ['a2', 2, false],
          ['a3', 3, true],
        ]),
      ),
    ).toEqual(['a1', 'a3']);
    expect(trackedIds(ev('A', null))).toEqual([]);
  });
});

describe('boardIndex', () => {
  it('maps every Event`s Boards to a number and the Event name; an Event without a Round adds none', () => {
    const idx = boardIndex([
      ev('A', [
        ['a1', 1, true],
        ['a2', 2, false],
      ]),
      ev('B', [['b1', 1, true]]),
      ev('C', null),
    ]);
    expect([...idx]).toEqual([
      ['a1', { board: 1, event: 'Event A' }],
      ['a2', { board: 2, event: 'Event A' }],
      ['b1', { board: 1, event: 'Event B' }],
    ]);
  });
});

describe('mergeForms', () => {
  const e = (t: string, roundId: string | null, topN: number) => ({
    ...ev(t, roundId ? [['x' + t, 1, true]] : null),
    topN,
    round: roundId ? { roundId, boards: [{ id: 'x' + t, board: 1, tracked: true }] } : null,
  });
  const prev = {
    topN: { A: '9', B: '3' },
    checked: { A: ['q'], B: [] as string[] },
    rounds: { A: 'r1', B: 'r1' },
  };
  it('keeps other Events` typed input, resets the acted one, a swapped Round, seeds new, drops removed', () => {
    const m = mergeForms(prev, [e('A', 'r1', 4), e('B', 'r2', 5), e('C', 'r1', 6)], 'A');
    expect(m.topN).toEqual({ A: '4', B: '5', C: '6' });
    expect(m.checked).toEqual({ A: ['xA'], B: ['xB'], C: ['xC'] });
    const k = mergeForms(prev, [e('A', 'r1', 4), e('B', 'r1', 5)], 'C');
    expect(k.topN).toEqual({ A: '9', B: '3' });
    expect(k.checked.A).toEqual(['q']);
    expect(mergeForms(prev, [e('B', 'r1', 5)]).topN).toEqual({ B: '3' });
  });
});
