import { describe, expect, it } from 'vitest';
import { archiveIndex, isLichessId, roundMeta, type RoundMeta } from '../shared/archive.js';
import type { Round } from '../shared/types.js';

describe('isLichessId', () => {
  it('accepts exactly 8 alphanumerics', () => {
    expect(isLichessId('L3MX2oE3')).toBe(true);
    for (const bad of ['abcdefg', 'abcdefghi', '..', '........', 'a-b_cdef', 'abcdefg/', 'ABCDEFGé', 'abcdefg\n', ''])
      expect(isLichessId(bad)).toBe(false);
  });
});

describe('roundMeta', () => {
  it('counts Tracked boards only', () => {
    const r = {
      tourId: 'T',
      roundId: 'R',
      name: 'Round 1',
      eventName: 'E',
      startsAt: 3,
      boards: [{ tracked: true }, { tracked: false }, { tracked: true }],
    } as Round;
    expect(roundMeta(r)).toEqual({
      tourId: 'T',
      roundId: 'R',
      name: 'Round 1',
      eventName: 'E',
      startsAt: 3,
      boards: 2,
    });
  });
});

describe('archiveIndex', () => {
  const m = (tourId: string, roundId: string, name: string, startsAt: number | null, eventName = 'Ev'): RoundMeta => ({
    tourId,
    roundId,
    name,
    eventName,
    startsAt,
    boards: 4,
  });

  it('drops the Current Round and groups the rest by Event', () => {
    const out = archiveIndex([m('T', 'R1', 'Round 1', 1), m('T', 'R2', 'Round 2', 2), m('T', 'R3', 'Round 3', 3)], {
      tourId: 'T',
      roundId: 'R3',
    });
    expect(out).toEqual([
      {
        tourId: 'T',
        name: 'Ev',
        rounds: [
          { tourId: 'T', roundId: 'R1', name: 'Round 1', startsAt: 1, boards: 4 },
          { tourId: 'T', roundId: 'R2', name: 'Round 2', startsAt: 2, boards: 4 },
        ],
      },
    ]);
  });

  it('orders Rounds by start (null last), then numerically by name', () => {
    const [e] = archiveIndex(
      [m('T', 'a', 'Round 10', 5), m('T', 'b', 'Round 2', 5), m('T', 'c', 'X', null), m('T', 'd', 'Y', 1)],
      null,
    );
    expect(e.rounds.map((r) => r.roundId)).toEqual(['d', 'b', 'a', 'c']);
  });

  it('orders Events newest first (null last), naming them from the last Round, else the tourId', () => {
    const out = archiveIndex(
      [
        m('A', 'a1', 'R', 10, 'Old'),
        m('B', 'b1', 'R', 20, ''),
        m('B', 'b2', 'R', 30, 'New'),
        m('C', 'c1', 'R', null, ''),
      ],
      null,
    );
    expect(out.map((e) => [e.tourId, e.name])).toEqual([
      ['B', 'New'],
      ['A', 'Old'],
      ['C', 'C'],
    ]);
  });

  it('omits an Event whose only Round is current', () => {
    expect(archiveIndex([m('T', 'R', 'Round 1', 1)], { tourId: 'T', roundId: 'R' })).toEqual([]);
  });
});
