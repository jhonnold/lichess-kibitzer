import { latestMark } from './analysis.js';
import type { Color, Mark } from './accuracy.js';
import { boardHash } from './route.js';
import type { Board, Player } from './types.js';
import { boardState, clockOf, formatResult, positionAt, type BoardState, type Position } from './viewer.js';

/** What an overview tile shows of one Board's plies. Score and Queue dot come from `search`/`queue` (see barScore,
 *  statusLine), so a search event does not replay the game. */
export interface TileView {
  id: string;
  board: number;
  href: string;
  white: Player;
  black: Player;
  state: BoardState;
  result: string | null; // Finished only
  clocks: { white: number | null; black: number | null };
  toMove: Color | null; // Live only
  position: Position; // latest
  mark: Mark | null; // of the latest move
}

export function tileView(b: Board): TileView {
  const state = boardState(b);
  const position = positionAt(b.plies, b.plies.length - 1);
  return {
    id: b.id,
    board: b.board,
    href: boardHash(b.board),
    white: b.white,
    black: b.black,
    state,
    result: state === 'finished' ? formatResult(b.result) : null,
    clocks: { white: clockOf(b.plies, 'white') ?? b.clocks.white, black: clockOf(b.plies, 'black') ?? b.clocks.black },
    toMove: state === 'live' ? position.turn : null,
    position,
    mark: latestMark(b.plies),
  };
}
