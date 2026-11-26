import { Chess } from 'chess.js';
import type { Score } from '../shared/accuracy.js';
import type { UciScore } from './engine/uci-parser.js';

/** UCI score (side to move at position `ply`) → White POV. Mate 0 = no eval (mated / stalemated). */
export function toScore(s: UciScore, ply: number): Score | null {
  const sign = ply % 2 === 0 ? 1 : -1;
  if (s.unit === 'mate') return s.value === 0 ? null : { mate: sign * s.value };
  return { cp: sign * s.value };
}

/** PV in UCI → SAN from `fen`; stops at the first illegal move. */
export function pvToSan(fen: string, pv: string[]): string[] {
  const chess = new Chess(fen);
  const san: string[] = [];
  for (const m of pv) {
    try {
      san.push(chess.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] }).san);
    } catch {
      break;
    }
  }
  return san;
}
