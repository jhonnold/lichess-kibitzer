export type Role = 'q' | 'r' | 'b' | 'n' | 'p';

export const PIECE_VALUE: Record<Role, number> = { q: 9, r: 5, b: 3, n: 3, p: 1 };
export const PIECE_GLYPH: Record<Role, string> = { q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
const ROLES: Role[] = ['q', 'r', 'b', 'n', 'p'];

/** pieces: the roles this side has more of than the other (q r b n p order, once per extra piece); diff: this
 *  side's point lead, else 0. */
export interface MaterialSide {
  pieces: Role[];
  diff: number;
}

/** From the FEN's placement field only (a promoted piece counts as what it became; kings are ignored). */
export function material(fen: string): { white: MaterialSide; black: MaterialSide } {
  const count = { white: {} as Record<string, number>, black: {} as Record<string, number> };
  for (const ch of fen.split(' ')[0]) {
    const role = ch.toLowerCase();
    if (!(role in PIECE_VALUE)) continue;
    const side = count[ch === role ? 'black' : 'white'];
    side[role] = (side[role] ?? 0) + 1;
  }
  const side = (mine: Record<string, number>, theirs: Record<string, number>): MaterialSide => {
    const pieces = ROLES.flatMap((r) => Array<Role>(Math.max(0, (mine[r] ?? 0) - (theirs[r] ?? 0))).fill(r));
    const total = (c: Record<string, number>) => ROLES.reduce((s, r) => s + (c[r] ?? 0) * PIECE_VALUE[r], 0);
    return { pieces, diff: Math.max(0, total(mine) - total(theirs)) };
  };
  return { white: side(count.white, count.black), black: side(count.black, count.white) };
}
