/** Seconds typed in the Admin form → ms; null when not a positive number. */
export function jobTimeMs(seconds: string): number | null {
  const ms = Math.round(Number(seconds) * 1000);
  return seconds.trim() !== '' && Number.isFinite(ms) && ms > 0 ? ms : null;
}

export const formatJobTime = (ms: number | null): string =>
  ms === null ? 'unset — the Queue is idle' : `${ms / 1000} s`;

/** The part of an Admin Event block these helpers read. */
export type EvBlock = {
  event: { tourId: string; name: string };
  round: { boards: { id: string; board: number; tracked: boolean }[] } | null;
};

/** Ids of the Tracked Boards of the Event's Current Round, in board order. */
export const trackedIds = (ev: EvBlock): string[] => ev.round?.boards.filter((b) => b.tracked).map((b) => b.id) ?? [];

/** boardId → Board number and Event name, over every Event's Current Round (Queue entries carry no tourId). */
export function boardIndex(events: readonly EvBlock[]): Map<string, { board: number; event: string }> {
  const m = new Map<string, { board: number; event: string }>();
  for (const ev of events)
    for (const b of ev.round?.boards ?? []) m.set(b.id, { board: b.board, event: ev.event.name });
  return m;
}

export type EvForms = {
  topN: Record<string, string>;
  checked: Record<string, string[]>;
  rounds: Record<string, string>; // the Current Round id each Event's forms were last filled from
};
type EvForm = EvBlock & { topN: number; round: (NonNullable<EvBlock['round']> & { roundId: string }) | null };

/** The forms after a status read: every Event keeps what was typed, except `acted` (just saved) and an Event whose
 *  Current Round changed, which follow the server. New Events are seeded; removed ones dropped. */
export function mergeForms(prev: EvForms, events: readonly EvForm[], acted?: string): EvForms {
  const next: EvForms = { topN: {}, checked: {}, rounds: {} };
  for (const e of events) {
    const t = e.event.tourId;
    const round = e.round?.roundId ?? '';
    const keep = t in prev.topN && t in prev.checked && t !== acted && prev.rounds[t] === round;
    next.topN[t] = keep ? prev.topN[t] : String(e.topN);
    next.checked[t] = keep ? prev.checked[t] : trackedIds(e);
    next.rounds[t] = round;
  }
  return next;
}
