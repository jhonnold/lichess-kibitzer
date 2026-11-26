import type { Color } from '$shared/accuracy';
import type { Position } from '$shared/viewer';
import type { Ply } from '$shared/types';

export type { Position };

/** Clock after each side's latest move (plies[i] for odd i is White's move). */
export function clockOf(plies: Ply[], color: Color): number | null {
  for (let i = plies.length - 1; i > 0; i--) if ((i % 2 === 1) === (color === 'white')) return plies[i].move!.clock;
  return null;
}
