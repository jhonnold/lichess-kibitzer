import { describe, expect, it } from 'vitest';
import { archiveIndex, archiveSnapshot, isLichessId, roundMeta, type RoundMeta } from '../shared/archive.js';
import type { Board, Round } from '../shared/types.js';
import { archivedResult, viewerMessage } from '../shared/viewer.js';

describe('isLichessId', () => {
  it('accepts exactly 8 alphanumerics', () => {
    expect(isLichessId('L3MX2oE3')).toBe(true);
    for (const bad of ['abcdefg', 'abcdefghi', '..', '........', 'a-b_cdef', 'abcdefg/', 'ABCDEFGé', 'abcdefg\n', ''])
      expect(isLichessId(bad)).toBe(false);
  });
});

describe('roundMeta', () => {
  it('counts Tracked boards only, split by outcome', () => {
    const r = {
      tourId: 'T',
      roundId: 'R',
      name: 'Round 1',
      eventName: 'E',
      startsAt: 3,
      boards: [
        { tracked: true, result: '1-0', plies: [{}, {}] },
        { tracked: false, result: '*', plies: [{}] },
        { tracked: true, result: '*', plies: [{}, {}] },
        { tracked: true, result: '*', plies: [{}] },
      ],
    } as Round;
    expect(roundMeta(r)).toEqual({
      tourId: 'T',
      roundId: 'R',
      name: 'Round 1',
      eventName: 'E',
      startsAt: 3,
      boards: 3,
      outcomes: { finished: 1, unfinished: 1, notPlayed: 1 },
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
    outcomes: { finished: 4, unfinished: 0, notPlayed: 0 },
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
          { tourId: 'T', roundId: 'R1', name: 'Round 1', startsAt: 1, boards: 4, outcomes: m('', '', '', 0).outcomes },
          { tourId: 'T', roundId: 'R2', name: 'Round 2', startsAt: 2, boards: 4, outcomes: m('', '', '', 0).outcomes },
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

describe('archiveSnapshot', () => {
  const round = (boards: Board[]): Round => ({
    tourId: 'T',
    roundId: 'R',
    name: 'Round 1',
    eventName: 'Event',
    startsAt: 1,
    boards,
  });
  const b = (result: Board['result'], moves: number): Board =>
    ({ result, plies: Array.from({ length: moves + 1 }, () => ({ move: null, at: null, eval: null })) }) as Board;

  it('wraps the Round with no live state', () => {
    const r = round([b('1-0', 3)]);
    expect(archiveSnapshot(r)).toEqual({
      event: { tourId: 'T', name: 'Event', link: '' },
      round: r,
      search: null,
      queue: { current: [], backfill: 0 },
      stream: null,
    });
    expect(archiveSnapshot({ ...r, eventName: '' }).event?.name).toBe('T');
  });

  it('feeds viewerMessage: null with Boards, "no pairings yet" without', () => {
    expect(viewerMessage(archiveSnapshot(round([b('*', 2)])))).toBeNull();
    expect(viewerMessage(archiveSnapshot(round([])))).toBe('Event · Round 1 · no pairings yet');
  });

  it('archivedResult: result, unfinished, or not played', () => {
    expect(archivedResult(b('1/2-1/2', 30))).toBe('½-½');
    expect(archivedResult(b('*', 12))).toBe('unfinished');
    expect(archivedResult(b('*', 0))).toBe('not played');
  });
});
