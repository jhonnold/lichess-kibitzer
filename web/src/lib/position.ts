import { Chess } from 'chess.js';
import type { Key } from 'chessground/types';
import type { Color } from '$shared/accuracy';
import type { Ply } from '$shared/types';

export interface Position {
  fen: string;
  turn: Color;
  check: boolean;
  lastMove: Key[] | undefined;
}

/** Position after the last ply. Plies carry no FEN, so the moves are replayed (games start from the start position). */
export function positionOf(plies: Ply[]): Position {
  const chess = new Chess();
  for (const p of plies.slice(1))
    chess.move({ from: p.move!.uci.slice(0, 2), to: p.move!.uci.slice(2, 4), promotion: p.move!.uci[4] });
  const uci = plies.at(-1)?.move?.uci;
  return {
    fen: chess.fen(),
    turn: chess.turn() === 'w' ? 'white' : 'black',
    check: chess.inCheck(),
    lastMove: uci ? [uci.slice(0, 2) as Key, uci.slice(2, 4) as Key] : undefined,
  };
}

/** Clock after each side's latest move (plies[i] for odd i is White's move). */
export function clockOf(plies: Ply[], color: Color): number | null {
  for (let i = plies.length - 1; i > 0; i--) if ((i % 2 === 1) === (color === 'white')) return plies[i].move!.clock;
  return null;
}
