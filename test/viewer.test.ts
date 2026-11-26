import { DEFAULT_POSITION } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { winPercent } from '../shared/accuracy.js';
import type { Board, Eval, Ply, QueueView, Result, SearchInfo, Snapshot } from '../shared/types.js';
import {
  barScore,
  boardState,
  clockOf,
  countdown,
  evalSeries,
  formatScore,
  formatResult,
  legalDests,
  ordinal,
  panelInfo,
  play,
  positionAt,
  selectedBoard,
  shortName,
  statusLine,
  tickingClock,
  turnOf,
  uciMove,
  viewerMessage,
} from '../shared/viewer.js';

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

describe('positionAt / uciMove', () => {
  const ply = (uci: string): Ply => ({ move: { san: '', uci, clock: null }, at: null, eval: null });
  const start: Ply = { move: null, at: null, eval: null };
  const line = [start, ply('e2e4'), ply('e7e5'), ply('g1f3')];

  it('replays plies 1..n from the start position', () => {
    expect(positionAt(line, 0)).toEqual({ fen: DEFAULT_POSITION, turn: 'white', check: false, lastMove: undefined });
    expect(positionAt(line, 2)).toMatchObject({ turn: 'white', lastMove: ['e7', 'e5'] });
    expect(positionAt(line, 3)).toEqual(play(DEFAULT_POSITION, ['e4', 'e5', 'Nf3']));
  });

  it('reports castling by the king squares and applies promotions', () => {
    const castle = [start, ...['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6', 'e1g1'].map(ply)];
    expect(positionAt(castle, 7).lastMove).toEqual(['e1', 'g1']);
    const promo = [start, ...['a2a4', 'b7b5', 'a4b5', 'a7a6', 'b5a6', 'g8f6', 'a6a7', 'h7h6', 'a7b8q'].map(ply)];
    expect(positionAt(promo, 9).fen.split('/')[0]).toBe('rQbqkb1r');
  });

  it('uciMove has a promotion key only for promotions', () => {
    expect(uciMove('e2e4')).toEqual({ from: 'e2', to: 'e4' });
    expect(uciMove('e7e8q')).toEqual({ from: 'e7', to: 'e8', promotion: 'q' });
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

  it('a search on the ply is searching, even with no lines yet', () => {
    expect(panelInfo(board, 2, search('g', 2))).toEqual({
      ply: 2,
      searching: true,
      engine: 'E',
      depth: 3,
      nps: 100,
      lines: [line(1)],
    });
    expect(panelInfo(board, 2, search('g', 2, []))?.lines).toEqual([]);
  });

  it('a search on an earlier ply the Cursor is on is searching', () => {
    expect(panelInfo(board, 1, search('g', 1))).toMatchObject({ ply: 1, searching: true, lines: [line(1)] });
  });

  it("else the ply's stored eval", () => {
    const stored = { ply: 1, searching: false, engine: null, depth: 9, nps: null, lines: [line(7)] };
    expect(panelInfo(board, 1, search('other', 2))).toEqual(stored);
    expect(panelInfo(board, 1, null)).toEqual(stored);
    expect(panelInfo(board, 0, search('g', 2))).toMatchObject({ ply: 0, searching: false, lines: [line(5)] });
  });

  it('no eval at that ply is null, not an earlier ply', () => {
    expect(panelInfo(board, 2, search('other', 2))).toBeNull();
    expect(panelInfo(board, 2, null)).toBeNull();
  });

  it('empty stored lines is null', () => {
    expect(panelInfo({ id: 'g', plies: [withLines(0, [])] } as unknown as Board, 0, null)).toBeNull();
  });

  describe('barScore', () => {
    it('the search score at the ply, else its stored eval, not dim', () => {
      expect(barScore(board, 2, search('g', 2))).toEqual({ score: { cp: 1 }, dim: false });
      expect(barScore(board, 1, search('g', 1, []))).toEqual({ score: { cp: 7 }, dim: false });
      expect(barScore(board, 1, search('g', 2))).toEqual({ score: { cp: 7 }, dim: false });
    });

    it('no eval at the ply: the last one before it, dimmed; none at all: no score', () => {
      expect(barScore(board, 2, null)).toEqual({ score: { cp: 7 }, dim: true });
      const bare = { id: 'g', plies: [{ move: null, at: null, eval: null }] } as unknown as Board;
      expect(barScore(bare, 0, null)).toEqual({ score: null, dim: false });
    });
  });
});

const mk = (n: number, plies: number, result: Result = '*'): Board =>
  ({
    id: `g${n}`,
    board: n,
    result,
    plies: Array.from({ length: plies }, () => ({ move: null, at: null, eval: null })),
  }) as unknown as Board;

describe('selectedBoard', () => {
  const boards = [mk(5, 1), mk(2, 1), mk(9, 1)];
  it('finds the Tracked board by number', () => expect(selectedBoard(boards, 9)?.id).toBe('g9'));
  it('falls back to the lowest-numbered board, whatever the order', () => {
    expect(selectedBoard(boards, 3)?.id).toBe('g2');
    expect(selectedBoard(boards, null)?.id).toBe('g2');
  });
  it('is null with no boards', () => expect(selectedBoard([], 1)).toBeNull());
});

describe('boardState / formatResult / shortName / ordinal', () => {
  it('classifies a Board', () => {
    expect(boardState(mk(1, 1))).toBe('upcoming');
    expect(boardState(mk(1, 4))).toBe('live');
    expect(boardState(mk(1, 4, '0-1'))).toBe('finished');
  });
  it('formats results', () => {
    expect(['1-0', '0-1', '1/2-1/2', '*'].map((r) => formatResult(r as Result))).toEqual(['1-0', '0-1', '½-½', '*']);
  });
  it('shortens names', () => {
    expect(shortName('Hoefelsauer, Thomas')).toBe('Hoefelsauer');
    expect(shortName('Magnus Carlsen')).toBe('Carlsen');
    expect(shortName('  Nepo ')).toBe('Nepo');
  });
  it('writes ordinals', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111].map(ordinal)).toEqual([
      '1st',
      '2nd',
      '3rd',
      '4th',
      '11th',
      '12th',
      '13th',
      '21st',
      '22nd',
      '101st',
      '111th',
    ]);
  });
});

describe('statusLine', () => {
  const ev = (kind: Eval['kind'], depth = 12): Eval => ({
    score: { cp: 0 },
    depth,
    kind,
    bestmove: null,
    lines: [],
  });
  const withEval = (b: Board, ply: number, e: Eval): Board => {
    b.plies[ply] = { ...b.plies[ply], eval: e };
    return b;
  };
  const srch = (boardId: string, ply: number, depth: number) => ({ boardId, ply, depth }) as SearchInfo;
  const q = (current: [string, number][] = [], backfill = 0): QueueView => ({
    current: current.map(([boardId, ply]) => ({ boardId, ply })),
    backfill,
  });

  it('a Complete eval is Done, even while a search names the same ply', () => {
    expect(statusLine(withEval(mk(1, 3), 2, ev('complete', 21)), 2, srch('g1', 2, 5), q())).toEqual({
      state: 'done',
      text: 'Done · depth 21',
    });
  });
  it('the running search is Searching; depth 0 has no depth', () => {
    expect(statusLine(mk(1, 3), 2, srch('g1', 2, 21), q())).toEqual({
      state: 'searching',
      text: 'Searching · depth 21',
    });
    expect(statusLine(mk(1, 3), 2, srch('g1', 2, 0), q()).text).toBe('Searching');
  });
  it("another Board's search is ignored", () => {
    expect(statusLine(mk(1, 3), 2, srch('g2', 2, 9), q()).state).toBe('none');
  });
  it('a queued ply shows its position, with a Provisional eval too', () => {
    const queue = q([
      ['g2', 1],
      ['g3', 4],
      ['g1', 2],
    ]);
    expect(statusLine(mk(1, 3), 2, null, queue)).toEqual({ state: 'queued', text: 'Queued · 3rd' });
    expect(statusLine(withEval(mk(1, 3), 2, ev('provisional')), 2, null, queue).text).toBe('Queued · 3rd');
  });
  it('an earlier ply waits in the backfill tier, or just waits when it is empty', () => {
    expect(statusLine(mk(1, 3), 1, null, q([], 2))).toEqual({ state: 'queued', text: 'Queued · backfill' });
    expect(statusLine(mk(1, 3), 1, null, q()).text).toBe('Waiting');
  });
  it('a finished Board with no eval at its latest ply is Game over', () => {
    expect(statusLine(mk(1, 3, '1-0'), 2, null, q())).toEqual({ state: 'none', text: 'Game over' });
  });
  it('a Provisional eval that is not queued says so; nothing at all is Waiting', () => {
    expect(statusLine(withEval(mk(1, 3), 2, ev('provisional', 7)), 2, null, q())).toEqual({
      state: 'none',
      text: 'Provisional · depth 7',
    });
    expect(statusLine(mk(1, 3), 2, null, q()).text).toBe('Waiting');
  });
  it('an Upcoming Board queued at ply 0', () => {
    expect(
      statusLine(
        mk(1, 1),
        0,
        null,
        q([
          ['g4', 0],
          ['g5', 0],
          ['g6', 0],
          ['g1', 0],
        ]),
      ),
    ).toEqual({
      state: 'queued',
      text: 'Queued · 4th',
    });
  });
});

describe('countdown', () => {
  const S = 1000;
  const [M, H] = [60 * S, 3600 * S];
  it.each([
    [null, null],
    [-5 * S, 'starting'],
    [0, 'starting'],
    [59 * S, '0:59'],
    [9 * M + 5 * S, '9:05'],
    [59 * M + 59 * S, '59:59'],
    [H + 5 * M, '1h 05m'],
    [23 * H + 59 * M, '23h 59m'],
    [50 * H, '2d 2h'],
  ])('%j ms ahead is %j', (ahead, text) => {
    expect(countdown(ahead === null ? null : 1_000_000 + ahead, 1_000_000)).toBe(text);
  });
});

describe('viewerMessage', () => {
  const event = { tourId: 't', name: 'Event', link: 'x' };
  const round = (boards: Board[]) => ({
    tourId: 't',
    roundId: 'r',
    name: 'Round 2',
    eventName: 'Event',
    startsAt: null,
    boards,
  });
  const snap = (e: Snapshot['event'], r: Snapshot['round']): Snapshot => ({
    event: e,
    round: r,
    search: null,
    queue: { current: [], backfill: 0 },
    stream: null,
  });
  it('explains why there is nothing to show', () => {
    expect(viewerMessage(snap(null, null))).toBe('Nothing live right now');
    expect(viewerMessage(snap(event, null))).toBe('Event · waiting for the first Round');
    expect(viewerMessage(snap(event, round([])))).toBe('Event · Round 2 · no pairings yet');
  });
  it('is null while a Board can be shown', () => {
    expect(viewerMessage(snap(event, round([mk(1, 0)])))).toBeNull();
  });
});

describe('formatScore', () => {
  it('formats White POV scores', () => {
    expect([{ cp: 35 }, { cp: -120 }, { cp: 0 }, { mate: 3 }, { mate: -2 }].map(formatScore)).toEqual([
      '+0.35',
      '-1.20',
      '0.00',
      '#3',
      '#-2',
    ]);
  });
});

describe('clockOf', () => {
  const ply = (clock: number): Ply => ({ move: { san: 'x', uci: 'a1a2', clock }, at: null, eval: null });
  const plies = [{ move: null, at: null, eval: null }, ply(100), ply(90), ply(80)] as Ply[];
  it('is the latest clock of that side', () => {
    expect(clockOf(plies, 'white')).toBe(80);
    expect(clockOf(plies, 'black')).toBe(90);
  });
  it('is null when that side has not moved', () => {
    expect(clockOf(plies.slice(0, 2), 'black')).toBeNull();
    expect(clockOf(plies.slice(0, 1), 'white')).toBeNull();
  });
});

describe('turnOf', () => {
  it('is White after an even number of moves', () => {
    expect(turnOf([{ move: null, at: null, eval: null }])).toBe('white');
    expect(
      turnOf([
        { move: null, at: null, eval: null },
        { move: null, at: 1, eval: null },
      ]),
    ).toBe('black');
  });
});

describe('tickingClock', () => {
  const mv = (clock: number, at: number | null): Ply => ({ move: { san: 'x', uci: 'a1a2', clock }, at, eval: null });
  const start: Ply = { move: null, at: null, eval: null };
  const b = (plies: Ply[]) => ({ plies, clocks: { white: 90000, black: 80000 } });
  const game = b([start, mv(60000, 500), mv(50000, 1000)]); // White to move

  it('counts down the side to move; the other clock stays', () => {
    expect(tickingClock(game, 'white', true, 6000)).toBe(55000);
    expect(tickingClock(game, 'black', true, 6000)).toBe(50000);
  });

  it('is static when not ticking or the latest ply has no arrival time', () => {
    expect(tickingClock(game, 'white', false, 6000)).toBe(60000);
    expect(tickingClock(b([start, mv(60000, 500), mv(50000, null)]), 'white', true, 6000)).toBe(60000);
  });

  it('never goes below 0, nor up when server time is before the arrival', () => {
    expect(tickingClock(game, 'white', true, 1e9)).toBe(0);
    expect(tickingClock(game, 'white', true, 10)).toBe(60000);
  });

  it('falls back to the Board clock when the mover has not moved yet', () => {
    expect(tickingClock(b([start, mv(60000, 500)]), 'black', true, 9000)).toBe(80000);
  });

  it('upcoming: the Board clocks', () => {
    expect(tickingClock(b([start]), 'white', true, 9000)).toBe(90000);
    expect(tickingClock(b([start]), 'black', true, 9000)).toBe(80000);
  });
});
