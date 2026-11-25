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
/** Plies of game sTbk79vJ; positions before `pick` are Backfill. Played move = best unless lila gives `best`. */
const plies = (pick = 0): Ply[] => [
  ...scores.map((score, i): Ply => {
    const kind: EvalKind = i < pick ? 'backfill' : 'final';
    const move = i ? { uci: uci[i - 1], san: '', clock: null } : null;
    return { move, eval: { score, depth: 20, kind, bestmove: fixture.analysis[i]?.best ?? uci[i] ?? null } };
  }),
  { move: { uci: uci.at(-1)!, san: '', clock: null }, eval: null }, // checkmate: no eval
];

describe('analyse', () => {
  it('reproduces Lichess accuracy and every judgment for game sTbk79vJ', () => {
    const a = analyse(plies());
    expect([Math.round(a.white!), Math.round(a.black!), a.fromMove]).toEqual([82, 71, 1]);
    expect(a.marks).toEqual([null, ...fixture.analysis.map((p) => p.judgment?.toLowerCase() ?? null), null]);
  });

  it('scores only moves between Final evals, from the pick', () => {
    const a = analyse(plies(20));
    expect(a.white).toBeCloseTo(73.6004, 4); // = gameAccuracy(evals.slice(20), 'white') in accuracy.test
    expect(a.black).toBeCloseTo(66.2263, 4);
    expect(a.fromMove).toBe(11);
    expect(a.marks.slice(0, 21).every((m) => m === null)).toBe(true);
  });

  it('skips the engine best move and returns nulls with no Final pair', () => {
    const p = (bestmove: string): Ply[] => [
      { move: null, eval: { score: { cp: 0 }, depth: 1, kind: 'final', bestmove } },
      {
        move: { uci: 'f2f3', san: 'f3', clock: null },
        eval: { score: { cp: -300 }, depth: 1, kind: 'final', bestmove: null },
      },
    ];
    expect(analyse(p('f2f3')).marks[1]).toBeNull();
    expect(analyse(p('e2e4')).marks[1]).toBe('blunder');
    expect(analyse([{ move: null, eval: null }])).toEqual({ white: null, black: null, fromMove: null, marks: [null] });
  });
});
