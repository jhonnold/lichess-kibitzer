import { gameAccuracy, moveMark, type Color, type Mark, type Score } from './accuracy.js';
import type { Ply } from './types.js';

export interface Analysis {
  white: number | null; // game accuracy %, unrounded; null = no scored move
  black: number | null;
  scored: number; // moves with a Complete eval before and after them
  total: number; // moves played
  marks: (Mark | null)[]; // marks[i] = mark of the move into plies[i]; marks[0] is always null
}

/** Mover of the move into plies[i] (i ≥ 1). */
const mover = (i: number): Color => (i % 2 === 1 ? 'white' : 'black');

/**
 * Lichess accuracy and marks from Complete evals only (Provisional counts as missing).
 * A move is judged only when the evals before and after it are both Complete, and (lila) only when it
 * differs from the engine's best move in the position before it.
 */
export function analyse(plies: Ply[]): Analysis {
  const done: (Score | null)[] = plies.map((p) => (p.eval?.kind === 'complete' ? p.eval.score : null));
  const marks = plies.map((p, i) => {
    const [before, after] = [done[i - 1], done[i]];
    if (!before || !after || p.move?.uci === plies[i - 1].eval?.bestmove) return null;
    return moveMark(before, after, mover(i));
  });
  const scored = done.filter((s, i) => i > 0 && s && done[i - 1]).length;
  const first = done.findIndex((s, i) => s && done[i + 1]); // position the first scored move is played from
  const total = plies.length - 1;
  if (first < 0) return { white: null, black: null, scored, total, marks };
  return { ...gameAccuracy(done.slice(first), mover(first + 1)), scored, total, marks };
}
