import { DEFAULT_POSITION } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { winPercent } from '../shared/accuracy.js';
import type { Board, Ply, SearchInfo } from '../shared/types.js';
import { evalSeries, legalDests, panelInfo, play } from '../shared/viewer.js';

describe('play', () => {
  it('plays a SAN line (PV) to its end position', () => {
    expect(play(DEFAULT_POSITION, ['e4', 'e5', 'Nf3'])).toEqual({
      fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2',
      turn: 'black',
      check: false,
      lastMove: ['g1', 'f3'],
    });
  });

  it('plays board moves by squares, promoting, and reports check', () => {
    const p = play('7k/P7/8/8/8/8/8/K7 w - - 0 1', [{ from: 'a7', to: 'a8', promotion: 'q' }]);
    expect(p).toMatchObject({
      fen: 'Q6k/8/8/8/8/8/8/K7 b - - 0 1',
      turn: 'black',
      check: true,
      lastMove: ['a7', 'a8'],
    });
  });

  it('an empty line is the position itself', () => {
    expect(play(DEFAULT_POSITION, [])).toMatchObject({ fen: DEFAULT_POSITION, turn: 'white', lastMove: undefined });
  });

  it('throws on an illegal move', () => {
    expect(() => play(DEFAULT_POSITION, ['Nf6'])).toThrow();
  });
});

describe('legalDests', () => {
  it('maps each movable piece of the side to move to its targets', () => {
    const d = legalDests(DEFAULT_POSITION);
    expect(d.size).toBe(10);
    expect(d.get('g1')).toEqual(['f3', 'h3']);
    expect(d.get('e2')).toEqual(['e3', 'e4']);
    expect(d.has('e7')).toBe(false);
  });

  it('is empty when mated', () => {
    expect(legalDests('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3').size).toBe(0);
  });
});

describe('evalSeries', () => {
  const ply = (cp: number | null, kind: 'provisional' | 'complete' = 'complete'): Ply => ({
    move: null,
    at: null,
    eval: cp === null ? null : { score: { cp }, depth: 1, kind, bestmove: null, lines: [] },
  });

  it('White win % per ply, gaps for no eval, Provisional flagged', () => {
    const s = evalSeries([ply(0, 'provisional'), ply(100), ply(null)], null);
    expect(s.win).toEqual([50, winPercent({ cp: 100 }), null]);
    expect(s.provisional).toEqual([true, false, false]);
  });

  it('the Live score stands in for the current position', () => {
    expect(evalSeries([ply(0), ply(null)], { mate: -3 }).win).toEqual([50, winPercent({ mate: -3 })]);
  });
});

describe('panelInfo', () => {
  const line = (cp: number) => ({ score: { cp }, depth: 9, move: 'e2e4', san: ['e4'] });
  const withLines = (cp: number, lines = [line(cp)]): Ply => ({
    move: null,
    at: null,
    eval: { score: { cp }, depth: 9, kind: 'complete', bestmove: null, lines },
  });
  const board = {
    id: 'g',
    plies: [withLines(5), withLines(7), { move: null, at: null, eval: null }],
  } as unknown as Board;
  const search = (boardId: string, ply: number, lines = [line(1)]): SearchInfo => ({
    boardId,
    ply,
    engine: 'E',
    depth: 3,
    nps: 100,
    lines,
    startedAt: 0,
  });

  it('a search on the latest ply is searching, even with no lines yet', () => {
    expect(panelInfo(board, search('g', 2))).toEqual({
      ply: 2,
      searching: true,
      engine: 'E',
      depth: 3,
      nps: 100,
      lines: [line(1)],
    });
    expect(panelInfo(board, search('g', 2, []))?.lines).toEqual([]);
  });

  it('another Board or an earlier ply falls back to the latest stored lines', () => {
    const stored = { ply: 1, searching: false, engine: null, depth: 9, nps: null, lines: [line(7)] };
    expect(panelInfo(board, search('other', 2))).toEqual(stored);
    expect(panelInfo(board, search('g', 0))).toEqual(stored);
    expect(panelInfo(board, null)).toEqual(stored);
  });

  it('no search and no stored lines is null', () => {
    expect(panelInfo({ id: 'g', plies: [withLines(0, [])] } as unknown as Board, null)).toBeNull();
  });
});
