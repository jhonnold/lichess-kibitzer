import { moveMark, type Color } from './accuracy.js';
import type { PvLine } from './types.js';
import { formatScore } from './viewer.js';

/** best: the main line (else line 1); good: an alternative with no mark; inaccuracy: an inaccuracy-level alternative
 *  (drawn faintest). */
export type ArrowStrength = 'best' | 'good' | 'inaccuracy';
export interface ArrowSpec {
  from: string;
  to: string; // castling e1g1 → g1 (the king's square), promotion e7e8q → e8
  label: string; // the line's eval formatted like the engine panel: '+0.31', '-1.20', '0.00', '#3'
  rank: number; // index in [main, ...lines] (without a main line, in lines): 0 = the best arrow
  strength: ArrowStrength;
}

/**
 * One arrow per line's first move: `main`'s (the main copy's line) as best, then `lines` in order; without a usable
 * `main`, line 1 is best. Alternatives are judged against line 1 of `lines`, the same search. Skipped: lines with empty
 * `san` (first move illegal here or unknown), `move.length < 4`, and a first move already drawn by a better line.
 * Hidden: a line whose first move played instead of line 1's would be marked a mistake or blunder. If the best line
 * has no `san`, nothing is drawn.
 */
export function arrows(lines: readonly PvLine[], turn: Color, main: PvLine | null = null): ArrowSpec[] {
  const all = main?.san.length ? [main, ...lines] : lines;
  if (!all[0]?.san.length) return [];
  const ref = (lines[0] ?? all[0]).score;
  const seen = new Set<string>();
  const out: ArrowSpec[] = [];
  all.forEach((line, rank) => {
    const squares = line.move.slice(0, 4);
    if (!line.san.length || squares.length < 4 || seen.has(squares)) return;
    const mark = rank === 0 ? null : moveMark(ref, line.score, turn);
    if (mark === 'mistake' || mark === 'blunder') return;
    seen.add(squares);
    out.push({
      from: squares.slice(0, 2),
      to: squares.slice(2),
      label: formatScore(line.score),
      rank,
      strength: rank === 0 ? 'best' : (mark ?? 'good'),
    });
  });
  return out;
}
