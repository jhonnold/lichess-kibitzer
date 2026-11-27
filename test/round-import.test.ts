import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { RoundInfo } from '../src/lichess/api.js';
import { parsePgn } from '../src/lichess/stream.js';
import { importRound } from '../src/round-import.js';

const GAMES = parsePgn(readFileSync('test/fixtures/lichess/round-stream.pgn', 'utf8'));
const last = (id: string) => GAMES.findLast((g) => g.gameId === id)!;
const board = (id: string, result: RoundInfo['boards'][number]['result'] = '*') => ({
  id,
  name: id,
  white: { name: `W ${id}` },
  black: { name: `B ${id}` },
  whiteClockMs: 1000,
  result,
});
const INFO: RoundInfo = {
  id: 'L3MX2oE3',
  name: 'Round 1',
  tourId: 'IjDgZVUR',
  boards: [board('qbPxmdQ2'), board('nogame00', '1-0'), board('at7GqSzo', '0-1')],
};

describe('importRound', () => {
  const r = importRound(INFO, GAMES, 'Bundesliga', 1_700_000_000_000);

  it('keeps the Round and every Board, untracked, in fetchRound order', () => {
    expect(r).toMatchObject({
      tourId: 'IjDgZVUR',
      roundId: 'L3MX2oE3',
      name: 'Round 1',
      eventName: 'Bundesliga',
      startsAt: 1_700_000_000_000,
    });
    expect(r.boards.map((b) => [b.id, b.board, b.tracked])).toEqual([
      ['qbPxmdQ2', 1, false],
      ['nogame00', 2, false],
      ['at7GqSzo', 3, false],
    ]);
    expect(r.boards[0]).toMatchObject({ white: { name: 'W qbPxmdQ2' }, clocks: { white: 1000, black: null } });
  });

  it("builds the plies from the Board's last game update: no times, no evals", () => {
    const g = last('qbPxmdQ2');
    const b = r.boards[0];
    expect(b.plies).toHaveLength(g.uci.length + 1);
    expect(b.plies[0]).toEqual({ move: null, at: null, eval: null });
    expect(b.plies[1]).toEqual({ move: { uci: g.uci[0], san: g.san[0], clock: g.clocks[0] }, at: null, eval: null });
    expect(b.plies.every((p) => p.at === null && p.eval === null)).toBe(true);
    expect(b.result).toBe(g.result);
    expect(b.opening).toBe(g.opening);
  });

  it("a Board without a game keeps fetchRound's result and no moves; a '*' game keeps it too", () => {
    expect(r.boards[1]).toMatchObject({ result: '1-0', opening: null, plies: [{ move: null }] });
    expect(last('at7GqSzo').result).toBe('*');
    expect(r.boards[2].result).toBe('0-1');
  });

  it('ignores games without a Board', () => {
    expect(GAMES.some((g) => g.gameId === 'gH77VTmz')).toBe(true);
    expect(r.boards.some((b) => b.id === 'gH77VTmz')).toBe(false);
  });
});
