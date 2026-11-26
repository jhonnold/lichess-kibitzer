import type { Board, Round, Snapshot } from './types.js';

/** Lichess game, round and tournament ids. Checked before an id from a URL reaches a file path. */
export const LICHESS_ID = /^[A-Za-z0-9]{8}$/;
export const isLichessId = (s: string): boolean => LICHESS_ID.test(s);

/** How a Tracked Board ended up in the Archive: a result, moves but no result, or no moves. */
export interface Outcomes {
  finished: number;
  unfinished: number;
  notPlayed: number;
}
export const outcomeOf = (b: Pick<Board, 'result' | 'plies'>): keyof Outcomes =>
  b.result !== '*' ? 'finished' : b.plies.length > 1 ? 'unfinished' : 'notPlayed';

/** One archived Round, without its Boards. boards = Tracked board count; outcomes split them. */
export interface ArchiveRound {
  tourId: string;
  roundId: string;
  name: string;
  startsAt: number | null;
  boards: number;
  outcomes: Outcomes;
}
export interface ArchiveEvent {
  tourId: string;
  name: string;
  rounds: ArchiveRound[];
}
export type RoundMeta = ArchiveRound & { eventName: string };

export function roundMeta(r: Round): RoundMeta {
  const tracked = r.boards.filter((b) => b.tracked);
  const outcomes: Outcomes = { finished: 0, unfinished: 0, notPlayed: 0 };
  for (const b of tracked) outcomes[outcomeOf(b)]++;
  return {
    tourId: r.tourId,
    roundId: r.roundId,
    name: r.name,
    eventName: r.eventName,
    startsAt: r.startsAt,
    boards: tracked.length,
    outcomes,
  };
}

const byStart = (a: number | null, b: number | null) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a - b);
const collate = new Intl.Collator('en', { numeric: true });

/**
 * Group by tourId, dropping `current`. Rounds: startsAt ascending (null last), then name (numeric collation).
 * Events: by their latest Round's startsAt, newest first (null last). Event name = the last Round's non-empty
 * eventName, else tourId. An Event left with no Rounds is omitted.
 */
export function archiveIndex(
  metas: readonly RoundMeta[],
  current: { tourId: string; roundId: string } | null,
): ArchiveEvent[] {
  const tours = new Map<string, RoundMeta[]>();
  for (const m of metas) {
    if (m.tourId === current?.tourId && m.roundId === current.roundId) continue;
    tours.set(m.tourId, [...(tours.get(m.tourId) ?? []), m]);
  }
  const events = [...tours].map(([tourId, ms]) => {
    ms.sort((a, b) => byStart(a.startsAt, b.startsAt) || collate.compare(a.name, b.name));
    const name = ms.findLast((m) => m.eventName)?.eventName ?? tourId;
    const rounds = ms.map(({ eventName: _, ...r }) => r);
    return { tourId, name, rounds, latest: ms.at(-1)!.startsAt };
  });
  events.sort((a, b) =>
    a.latest === b.latest ? 0 : a.latest === null ? 1 : b.latest === null ? -1 : b.latest - a.latest,
  );
  return events.map(({ latest: _, ...e }) => e);
}

/** Which archived Round the Viewer and overview are showing; their live-only UI is off when set. */
export interface ArchiveCtx {
  tourId: string;
  roundId: string;
}

/** A Snapshot for the Viewer/overview from an archived Round (Tracked boards only, as the API serves it). */
export function archiveSnapshot(r: Round): Snapshot {
  return {
    event: { tourId: r.tourId, name: r.eventName || r.tourId, link: '' },
    round: r,
    search: null,
    queue: { current: [], backfill: 0 },
    stream: null,
  };
}
