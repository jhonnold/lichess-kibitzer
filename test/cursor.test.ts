import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import {
  back,
  cursorNote,
  cursorView,
  forward,
  jump,
  liveCursor,
  moveNumber,
  playOwn,
  toLive,
  type Cursor,
} from '../shared/cursor.js';
import type { Ply } from '../shared/types.js';
import { positionAt } from '../shared/viewer.js';

/** A game's plies from SAN moves (ply 0 = start). */
function plies(san: string[], fen?: string): Ply[] {
  const chess = new Chess(fen);
  const out: Ply[] = [{ move: null, at: null, eval: null }];
  for (const s of san) {
    const m = chess.move(s);
    out.push({ move: { san: m.san, uci: m.from + m.to + (m.promotion ?? ''), clock: null }, at: null, eval: null });
  }
  return out;
}
const mk = (id: string, san: string[]) => ({ id, plies: plies(san) });
const LINE = ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4'];
const g5 = mk('a', LINE.slice(0, 5)); // latest 5
const g6 = mk('a', LINE.slice(0, 6));

describe('Cursor', () => {
  it('live follows the latest ply', () => {
    const v = cursorView(liveCursor('a'), g5);
    expect(v).toMatchObject({ ply: 5, latest: 5, live: true, inBranch: false, evalPly: 5, behind: 0 });
    expect(v.position).toEqual(positionAt(g5.plies, 5));
  });

  it('back steps to earlier plies and stops at 0', () => {
    let c = liveCursor('a');
    c = back(c, 5);
    expect(cursorView(c, g5)).toMatchObject({ ply: 4, live: false, evalPly: 4, behind: 1 });
    for (let i = 0; i < 4; i++) c = back(c, 5);
    expect(c.ply).toBe(0);
    expect(back(c, 5)).toBe(c);
  });

  it('forward steps; onto the latest ply it is live again; live stays', () => {
    const at3: Cursor = { boardId: 'a', ply: 3, branch: [] };
    expect(forward(at3, 5).ply).toBe(4);
    expect(forward(forward(at3, 5), 5)).toEqual(liveCursor('a'));
    const live = liveCursor('a');
    expect(forward(live, 5)).toBe(live);
  });

  it('jump clamps; the latest ply or an Upcoming board is live', () => {
    const c = liveCursor('a');
    expect(jump(c, 2, 5).ply).toBe(2);
    expect(jump(c, 5, 5)).toEqual(liveCursor('a'));
    expect(jump(c, 99, 5)).toEqual(liveCursor('a'));
    expect(jump(c, -1, 5).ply).toBe(0);
    expect(jump(c, 0, 0)).toEqual(liveCursor('a'));
  });

  it('follow rule: live follows growth, off-live stays', () => {
    expect(cursorView(liveCursor('a'), g6)).toMatchObject({ ply: 6, live: true });
    const off: Cursor = { boardId: 'a', ply: 3, branch: [] };
    expect(cursorView(off, g5)).toMatchObject({ ply: 3, behind: 2 });
    expect(cursorView(off, g6)).toMatchObject({ ply: 3, behind: 3, live: false });
  });

  it('own moves branch from the latest ply and extend; the game growing does not move the board', () => {
    const c = playOwn(liveCursor('a'), 'a7a6', 5);
    const v = cursorView(c, g5);
    expect(v).toMatchObject({ ply: 5, live: false, inBranch: true, evalPly: null });
    expect(v.position.lastMove).toEqual(['a7', 'a6']);
    const c2 = playOwn(c, 'a2a3', 5);
    expect(cursorView(c2, g5).position.lastMove).toEqual(['a2', 'a3']);
    expect(cursorView(c2, g5).cursor).toBe(c2);
    const grown = cursorView(c, g6);
    expect(grown.position.fen).toBe(cursorView(c, g5).position.fen);
    expect(grown.behind).toBe(1);
  });

  it('back undoes own moves, then steps back', () => {
    let c = playOwn(playOwn(liveCursor('a'), 'a7a6', 5), 'a2a3', 5);
    c = back(c, 5);
    expect(c.branch).toEqual(['a7a6']);
    expect(back(c, 5)).toEqual(liveCursor('a'));
    const from3 = playOwn({ boardId: 'a', ply: 3, branch: [] }, 'd7d6', 5);
    const undone = back(from3, 5);
    expect(undone).toEqual({ boardId: 'a', ply: 3, branch: [] });
    expect(back(undone, 5).ply).toBe(2);
  });

  it('forward does nothing in a branch; jump and toLive clear it', () => {
    const c = playOwn({ boardId: 'a', ply: 3, branch: [] }, 'd7d6', 5);
    expect(forward(c, 5)).toBe(c);
    expect(jump(c, 2, 5)).toEqual({ boardId: 'a', ply: 2, branch: [] });
    expect(toLive(c)).toEqual(liveCursor('a'));
  });

  it('own moves promote to a queen', () => {
    const g = mk('p', ['a4', 'b5', 'axb5', 'a6', 'bxa6', 'Nf6', 'a7', 'h6']);
    const v = cursorView(playOwn(liveCursor('p'), 'a7b8', 8), g);
    expect(v.position.fen.split('/')[0]).toBe('rQbqkb1r');
  });

  it('a Cursor above a retracted game is live; at the new latest it is live', () => {
    const at5: Cursor = { boardId: 'a', ply: 5, branch: [] };
    const short = mk('a', LINE.slice(0, 2));
    expect(cursorView(at5, short)).toMatchObject({ ply: 2, live: true });
    const withBranch = playOwn(at5, 'a7a6', 5);
    expect(cursorView(withBranch, short)).toMatchObject({ ply: 2, live: true, inBranch: false });
    const at2: Cursor = { boardId: 'a', ply: 2, branch: [] };
    expect(cursorView(at2, short).live).toBe(true);
  });

  it('a correction that makes an own move illegal truncates the branch there', () => {
    const changed = mk('a', ['d4', 'd5', 'Nf3', 'Nc6']);
    const at = (branch: string[]): Cursor => ({ boardId: 'a', ply: 2, branch });
    const v = cursorView(at(['d2d4', 'g8f6']), changed); // d4 is already played
    expect(v.cursor.branch).toEqual([]);
    expect(v.position).toEqual(positionAt(changed.plies, 2));
    const v2 = cursorView(at(['g1f3', 'g1f3']), changed); // the knight has moved on
    expect(v2.cursor.branch).toEqual(['g1f3']);
    expect(v2.position.lastMove).toEqual(['g1', 'f3']);
  });

  it('a Cursor of another Board reads as live there', () => {
    expect(cursorView({ boardId: 'a', ply: 2, branch: [] }, mk('b', LINE)).cursor).toEqual(liveCursor('b'));
  });

  it('returns the same Cursor when nothing needs normalising; a persisted normalisation keeps following', () => {
    const live = liveCursor('a');
    expect(cursorView(live, g5).cursor).toBe(live);
    const off: Cursor = { boardId: 'a', ply: 4, branch: [] };
    expect(cursorView(off, g5).cursor).toBe(off);
    const g3 = mk('a', LINE.slice(0, 3));
    const norm = cursorView(off, g3).cursor;
    expect(norm).toEqual(liveCursor('a'));
    expect(cursorView(norm, g5)).toMatchObject({ ply: 5, live: true });
  });

  it('numbers moves', () => {
    expect([0, 1, 2, 23, 24].map(moveNumber)).toEqual(['Start', '1.', '1…', '12.', '12…']);
  });

  it('drops "live is N ahead" for an archived game', () => {
    const g = mk('a', LINE);
    const v = cursorView({ boardId: 'a', ply: 4, branch: [] }, g);
    expect(cursorNote(v, g.plies, true)).toBe('Move 2… Nc6');
    expect(cursorNote(v, g.plies)).toBe('Move 2… Nc6 · live is 3 plies ahead');
  });

  it('describes the Cursor beside "Back to live"', () => {
    const g = mk('a', LINE);
    const v = (c: Cursor, game = g) => cursorNote(cursorView(c, game), game.plies);
    expect(v(liveCursor('a'))).toBeNull();
    expect(v({ boardId: 'a', ply: 6, branch: [] })).toBe('Move 3… a6 · live is 1 ply ahead');
    expect(v({ boardId: 'a', ply: 4, branch: [] })).toBe('Move 2… Nc6 · live is 3 plies ahead');
    expect(v({ boardId: 'a', ply: 0, branch: [] })).toBe('Start position · live is 7 plies ahead');
    expect(v(playOwn(liveCursor('a'), 'h7h6', 7))).toBe('Your moves · no engine');
    expect(v(playOwn({ boardId: 'a', ply: 3, branch: [] }, 'd7d6', 7))).toBe(
      'Your moves · no engine · live is 4 plies ahead',
    );
  });
});
