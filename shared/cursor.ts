import { Chess } from 'chess.js';
import type { Ply } from './types.js';
import { play, positionAt, uciMove, type Position } from './viewer.js';

/**
 * The position one Viewer's board shows: a ply of the Selected board's game plus the Viewer's own moves from there.
 * ply null = live: the latest ply, following new moves (branch is then always empty).
 * boardId: the Board it belongs to; a Cursor of another Board reads as live (Selected board changed / Round swap).
 */
export interface Cursor {
  boardId: string;
  ply: number | null;
  branch: string[]; // own moves from `ply`, UCI 'e2e4' (promotion is always to a queen, as in v1)
}

export const liveCursor = (boardId: string): Cursor => ({ boardId, ply: null, branch: [] }); // not `live`: Viewer has a `live` const

/** The board a Cursor is read against. */
export type CursorGame = { id: string; plies: readonly Ply[] };

export interface CursorView {
  cursor: Cursor; // normalised (see cursorView); the operations below take this one
  ply: number; // game ply the Cursor is on (latest when live)
  latest: number; // plies.length - 1
  live: boolean; // following new moves: on the latest ply, no branch
  inBranch: boolean; // branch.length > 0
  evalPly: number | null; // ply whose eval, lines, status apply; null in a branch (own moves get no engine output)
  position: Position; // what the board shows; lastMove = last own move, else the game move into `ply` (none at 0)
  behind: number; // latest - ply: plies the live game is ahead of the Cursor's game ply
}

const ownMove = (uci: string) => ({ ...uciMove(uci), promotion: uci[4] ?? 'q' });

/** The leading own moves that are legal from `fen`. */
function legalPrefix(fen: string, branch: readonly string[]): string[] {
  const chess = new Chess(fen);
  const kept: string[] = [];
  for (const uci of branch) {
    try {
      chess.move(ownMove(uci));
    } catch {
      break;
    }
    kept.push(uci);
  }
  return kept;
}

/**
 * Normalises and derives the view, in this order:
 *  1. c.boardId !== game.id → liveCursor(game.id).
 *  2. ply > latest (game retracted/corrected below the Cursor) → live (branch dropped: its base position is gone).
 *  3. branch moves are played from positionAt(ply) until the first illegal one; that one and the rest are dropped
 *     (a correction that kept the length but changed a move below the Cursor).
 *  4. ply === latest and branch empty → live (the follow rule: on the latest ply the Cursor follows).
 * Returns `cursor: c` (the same object) when no rule fires, so the Viewer can persist `view.cursor !== c` without a
 * loop; a normalised Cursor must be persisted (retract-then-append would otherwise drop the Viewer off live).
 */
export function cursorView(c: Cursor, game: CursorGame): CursorView {
  const latest = game.plies.length - 1;
  let cursor = c;
  if (c.boardId !== game.id || (c.ply !== null && c.ply > latest)) cursor = liveCursor(game.id);
  const ply = cursor.ply ?? latest;
  const base = positionAt(game.plies, ply);
  if (cursor.branch.length) {
    const kept = legalPrefix(base.fen, cursor.branch);
    if (kept.length < cursor.branch.length) cursor = { ...cursor, branch: kept };
  }
  if (ply === latest && !cursor.branch.length && cursor.ply !== null) cursor = liveCursor(game.id);
  const live = cursor.ply === null;
  const inBranch = cursor.branch.length > 0;
  return {
    cursor,
    ply,
    latest,
    live,
    inBranch,
    evalPly: inBranch ? null : ply,
    position: inBranch ? play(base.fen, cursor.branch.map(ownMove)) : base,
    behind: latest - ply,
  };
}

// Operations: `c` is CursorView.cursor (normalised), `latest` = CursorView.latest. Every result goes through rule 4
// (lands on latest with no branch → live), so stepping forward onto the latest ply resumes following.
const settle = (c: Cursor, latest: number): Cursor =>
  c.ply === latest && !c.branch.length ? liveCursor(c.boardId) : c;

/** In a branch: undo the last own move. Else one ply back (live → latest - 1); at ply 0 unchanged. */
export function back(c: Cursor, latest: number): Cursor {
  if (c.branch.length) return settle({ ...c, branch: c.branch.slice(0, -1) }, latest);
  const ply = c.ply ?? latest;
  return ply === 0 ? c : settle({ ...c, ply: ply - 1 }, latest);
}

/** One ply forward. No-op when live (already latest) or in a branch (own moves have no redo). */
export function forward(c: Cursor, latest: number): Cursor {
  return c.ply === null || c.branch.length ? c : settle({ ...c, ply: Math.min(c.ply + 1, latest) }, latest);
}

/** Jump to game ply n (move-list click, graph click, Home = jump(c, 0, latest)). Clears the branch; n clamped. */
export const jump = (c: Cursor, n: number, latest: number): Cursor =>
  settle({ boardId: c.boardId, ply: Math.max(0, Math.min(n, latest)), branch: [] }, latest);

/** End and "Back to live" are the same: liveCursor(c.boardId). */
export const toLive = (c: Cursor): Cursor => liveCursor(c.boardId);

/** Own move from the Cursor position: branches at (ply ?? latest); a second own move extends the branch. */
export const playOwn = (c: Cursor, uci: string, latest: number): Cursor => ({
  boardId: c.boardId,
  ply: c.ply ?? latest,
  branch: [...c.branch, uci],
});

/** 'Start' for 0; odd ply p → `${(p + 1) / 2}.`; even p → `${p / 2}…` (12… = Black's 12th move). */
export const moveNumber = (ply: number): string =>
  ply === 0 ? 'Start' : ply % 2 ? `${(ply + 1) / 2}.` : `${ply / 2}…`;

/**
 * Text beside the "Back to live" control; null when live.
 * In a branch: 'Your moves · no engine'. Else `Move ${moveNumber(ply)} ${san}` ('Move 12… Nf6'), or
 * 'Start position' at ply 0. Suffix when behind > 0 (not for an archived game, which never grows): ` · live is ${behind} ${behind === 1 ? 'ply' : 'plies'} ahead`.
 */
export function cursorNote(v: CursorView, plies: readonly Ply[], archived = false): string | null {
  if (v.live) return null;
  const head = v.inBranch
    ? 'Your moves · no engine'
    : v.ply === 0
      ? 'Start position'
      : `Move ${moveNumber(v.ply)} ${plies[v.ply].move!.san}`;
  return v.behind > 0 && !archived ? `${head} · live is ${v.behind} ${v.behind === 1 ? 'ply' : 'plies'} ahead` : head;
}
