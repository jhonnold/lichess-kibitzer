import { readFileSync } from 'node:fs';
import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { analyse } from '../shared/analysis.js';
import type { Score } from '../shared/accuracy.js';
import type { EvalKind, Ply } from '../shared/types.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/lichess-sTbk79vJ.json', import.meta.url), 'utf8')) as {
  moves: string;
  initialEval: Score;
  accuracy: { white: number; black: number };
  analysis: { eval?: number; mate?: number; best?: string; judgment?: string }[];
};
const chess = new Chess();
const uci = fixture.moves.split(' ').map((san) => chess.move(san).lan);
const scores: Score[] = [
  fixture.initialEval,
  ...fixture.analysis.map((p): Score => (p.mate !== undefined ? { mate: p.mate } : { cp: p.eval! })),
];
/** Plies of game sTbk79vJ; positions before `pick` are Provisional. Played move = best unless lila gives `best`. */
const plies = (pick = 0): Ply[] => [
  ...scores.map((score, i): Ply => {
    const kind: EvalKind = i < pick ? 'provisional' : 'complete';
    const move = i ? { uci: uci[i - 1], san: '', clock: null } : null;
    const bestmove = fixture.analysis[i]?.best ?? uci[i] ?? null;
    return { move, at: null, eval: { score, depth: 20, kind, bestmove, lines: [] } };
  }),
  { move: { uci: uci.at(-1)!, san: '', clock: null }, at: null, eval: null }, // checkmate: no eval
];

describe('analyse', () => {
  it('reproduces Lichess accuracy and every judgment for game sTbk79vJ', () => {
    const a = analyse(plies());
    expect([Math.round(a.white!), Math.round(a.black!)]).toEqual([82, 71]);
    expect([a.scored, a.total]).toEqual([plies().length - 2, plies().length - 1]); // the move into mate has no eval
    expect(a.marks).toEqual([null, ...fixture.analysis.map((p) => p.judgment?.toLowerCase() ?? null), null]);
  });

  it('scores only moves between Complete evals, from the first pair', () => {
    const a = analyse(plies(20));
    expect(a.white).toBeCloseTo(73.6004, 4); // = gameAccuracy(evals.slice(20), 'white') in accuracy.test
    expect(a.black).toBeCloseTo(66.2263, 4);
    expect(a.scored).toBe(a.total - 21);
    expect(a.marks.slice(0, 21).every((m) => m === null)).toBe(true);
  });

  it('a Provisional ply mid-game drops the two moves touching it', () => {
    const p = plies();
    p[30] = { ...p[30], eval: { ...p[30].eval!, kind: 'provisional' } };
    expect(analyse(p).scored).toBe(analyse(plies()).scored - 2);
  });

  it('skips the engine best move and returns nulls with no Complete pair', () => {
    const p = (bestmove: string): Ply[] => [
      { move: null, at: null, eval: { score: { cp: 0 }, depth: 1, kind: 'complete', bestmove, lines: [] } },
      {
        move: { uci: 'f2f3', san: 'f3', clock: null },
        at: null,
        eval: { score: { cp: -300 }, depth: 1, kind: 'complete', bestmove: null, lines: [] },
      },
    ];
    expect(analyse(p('f2f3')).marks[1]).toBeNull();
    expect(analyse(p('e2e4')).marks[1]).toBe('blunder');
    expect(analyse([{ move: null, at: null, eval: null }])).toEqual({
      white: null,
      black: null,
      scored: 0,
      total: 0,
      marks: [null],
    });
  });
});
