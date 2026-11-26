export const SWAP_LEAD_MS = 10 * 60_000;

/** Structural subset of src/lichess/api.ts RoundSummary (shared/ does not import src/). */
export interface RoundRef {
  id: string;
  ongoing: boolean;
  finished: boolean;
  startsAt?: number;
}

export interface Rollover<R extends RoundRef> {
  current: R | null;
  next: R | null;
  swapAt: number | null;
}

/** startsAt − SWAP_LEAD_MS; null without startsAt (then the swap waits for `ongoing`). */
export function swapAt(r: RoundRef): number | null {
  return r.startsAt === undefined ? null : r.startsAt - SWAP_LEAD_MS;
}

/** ongoing || finished || (startsAt defined && now >= startsAt − SWAP_LEAD_MS). */
export function isDue(r: RoundRef, now: number): boolean {
  const at = swapAt(r);
  return r.ongoing || r.finished || (at !== null && now >= at);
}

/**
 * Which Round is current, and which comes next. Array order is Lichess order. Never goes backwards from currentId;
 * a currentId missing from `rounds` keeps it (all null).
 */
export function rollover<R extends RoundRef>(rounds: readonly R[], currentId: string | null, now: number): Rollover<R> {
  const lastDue = (from: number) => rounds.findLastIndex((r, i) => i > from && isDue(r, now));
  let i: number;
  if (currentId === null) {
    const due = lastDue(-1);
    i = due >= 0 ? due : rounds.length ? 0 : -1;
  } else {
    const at = rounds.findIndex((r) => r.id === currentId);
    if (at < 0) return { current: null, next: null, swapAt: null };
    const due = lastDue(at);
    i = due > at ? due : at;
  }
  const next = i >= 0 ? (rounds[i + 1] ?? null) : null;
  return { current: rounds[i] ?? null, next, swapAt: next && swapAt(next) };
}
