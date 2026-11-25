import { gameAccuracy, moveMark, type Color, type Mark, type Score } from './accuracy.js';
import type { Ply } from './types.js';

export interface Analysis {
  white: number | null; // game accuracy %, unrounded; null = no scored move
  black: number | null;
  fromMove: number | null; // full-move number of the first scored move ("from move 21"); null = none
  marks: (Mark | null)[]; // marks[i] = mark of the move into plies[i]; marks[0] is always null
}

/** Mover of the move into plies[i] (i ≥ 1). */
const mover = (i: number): Color => (i % 2 === 1 ? 'white' : 'black');

/**
 * Lichess accuracy and marks from Final evals only (Backfill counts as missing).
 * A move is judged only when the evals before and after it are both Final, and (lila) only when it
 * differs from the engine's best move in the position before it.
 */
export function analyse(plies: Ply[]): Analysis {
  const finals: (Score | null)[] = plies.map((p) => (p.eval?.kind === 'final' ? p.eval.score : null));
  const marks = plies.map((p, i) => {
    const [before, after] = [finals[i - 1], finals[i]];
    if (!before || !after || p.move?.uci === plies[i - 1].eval?.bestmove) return null;
    return moveMark(before, after, mover(i));
  });
  const first = finals.findIndex((s, i) => s && finals[i + 1]); // position the first scored move is played from
  if (first < 0) return { white: null, black: null, fromMove: null, marks };
  const acc = gameAccuracy(finals.slice(first), mover(first + 1));
  return { ...acc, fromMove: Math.floor(first / 2) + 1, marks };
}
