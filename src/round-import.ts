import type * as T from '../shared/types.js';
import type { RoundInfo } from './lichess/api.js';
import type { GameUpdate } from './lichess/stream.js';
import { newBoard } from './round-state.js';

/**
 * A past Round as a Round file: every Board of `info` in Lichess order, untracked, with the moves of its game in
 * `games` (at null: played before the import; no evals). Result and opening come from the game; a Board without a
 * game, or whose game reads '*', keeps the result `info` gives. Games without a Board are ignored.
 */
export function importRound(
  info: RoundInfo,
  games: readonly GameUpdate[],
  eventName: string,
  startsAt: number | null,
): T.Round {
  const byId = new Map(games.map((g) => [g.gameId, g]));
  return {
    tourId: info.tourId,
    roundId: info.id,
    name: info.name,
    eventName,
    startsAt,
    boards: info.boards.map((b, i) => {
      const board = newBoard(b, i, false);
      const g = byId.get(b.id);
      if (!g) return board;
      if (g.result !== '*') board.result = g.result;
      board.opening = g.opening;
      for (const [k, uci] of g.uci.entries()) {
        board.plies.push({ move: { uci, san: g.san[k], clock: g.clocks[k] }, at: null, eval: null });
      }
      return board;
    }),
  };
}
