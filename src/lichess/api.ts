import { LICHESS_ID } from '../../shared/archive.js';
import { openingLookups, rateLimited } from '../metrics.js';

export const USER_AGENT = 'lichess-kibitzer';
const BASE = 'https://lichess.org';
export const EXPLORER = 'https://explorer.lichess.org';
export const RATE_LIMIT_MS = 60_000;
export const EXPLORER_TIMEOUT_MS = 5_000;
export type Fetch = typeof fetch;
export type Result = '1-0' | '0-1' | '1/2-1/2' | '*';
export interface Player {
  name: string;
  title?: string;
  rating?: number;
}
export interface RoundSummary {
  id: string;
  name: string;
  ongoing: boolean;
  finished: boolean;
  startsAt?: number;
}
export interface EventInfo {
  id: string;
  name: string;
  rounds: RoundSummary[];
  defaultRoundId?: string;
}
export interface Board {
  id: string;
  name: string;
  white: Player;
  black: Player;
  whiteClockMs?: number;
  blackClockMs?: number;
  result: Result;
}
export interface RoundInfo {
  id: string;
  name: string;
  tourId: string;
  boards: Board[];
}
export type EventRef = { kind: 'tour' | 'round'; id: string };
export class LichessError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface TourJson {
  tour: { id: string; name: string };
  rounds: { id: string; name: string; ongoing?: boolean; finished?: boolean; startsAt?: number }[];
  defaultRoundId?: string;
}
interface RoundJson {
  round: { id: string; name: string };
  tour: { id: string };
  games: {
    id: string;
    name: string;
    status: string;
    players: { name: string; title?: string; rating?: number; clock?: number }[];
  }[];
}

export function parseEventLink(link: string): EventRef {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    throw new Error('Not a URL');
  }
  const seg = url.pathname.split('/').filter(Boolean);
  if (url.hostname !== 'lichess.org' || seg[0] !== 'broadcast') throw new Error('Not a lichess.org/broadcast link');
  // /broadcast/<slug>/<tourId> | /broadcast/<slug>/<roundSlug>/<roundId>[/<gameId>]
  const ref: EventRef | undefined =
    seg.length === 3
      ? { kind: 'tour', id: seg[2] }
      : seg.length === 4 || seg.length === 5
        ? { kind: 'round', id: seg[3] }
        : undefined;
  if (!ref || !LICHESS_ID.test(ref.id)) throw new Error('Unrecognised broadcast link');
  return ref;
}

// Lichess etiquette: one request at a time; after a 429 wait a full minute. The long-lived round stream is NOT routed
// through here (it would block admin calls forever); it handles 429 itself.
// Explorer lookups have their own serial lane (and a timeout) so a hung one cannot delay the event/round calls; the
// 429 pause is shared.
const queues = { api: Promise.resolve() as Promise<unknown>, explorer: Promise.resolve() as Promise<unknown> };
let pausedUntil = 0;
function getJson<T>(url: string, f: Fetch, lane: keyof typeof queues = 'api', timeoutMs?: number): Promise<T> {
  const run = async () => {
    if (Date.now() < pausedUntil) throw new LichessError(429, 'Lichess rate limit; retry in a minute');
    const res = await f(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 429) {
      rateLimited.inc({ source: 'api' });
      pausedUntil = Date.now() + RATE_LIMIT_MS;
    }
    if (!res.ok) throw new LichessError(res.status, `Lichess ${new URL(url).pathname} → HTTP ${res.status}`);
    return (await res.json()) as T;
  };
  const p = queues[lane].then(run, run);
  queues[lane] = p.catch(() => undefined);
  return p;
}

export async function fetchEvent(link: string, f: Fetch = fetch): Promise<EventInfo> {
  const ref = parseEventLink(link);
  let tourId = ref.id;
  if (ref.kind === 'round') {
    const r = await getJson<RoundJson>(`${BASE}/api/broadcast/-/-/${ref.id}`, f);
    tourId = r.tour.id;
  }
  const t = await getJson<TourJson>(`${BASE}/api/broadcast/${tourId}`, f);
  return {
    id: t.tour.id,
    name: t.tour.name,
    rounds: t.rounds.map((r) => ({
      id: r.id,
      name: r.name,
      ongoing: !!r.ongoing,
      finished: !!r.finished,
      startsAt: r.startsAt,
    })),
    defaultRoundId: ref.kind === 'round' ? ref.id : t.defaultRoundId,
  };
}

const player = (p: RoundJson['games'][number]['players'][number]): Player => ({
  name: p.name,
  title: p.title,
  rating: p.rating,
});

export async function fetchRound(roundId: string, f: Fetch = fetch): Promise<RoundInfo> {
  const r = await getJson<RoundJson>(`${BASE}/api/broadcast/-/-/${roundId}`, f);
  return {
    id: r.round.id,
    name: r.round.name,
    tourId: r.tour.id,
    boards: r.games.map((g) => ({
      id: g.id,
      name: g.name,
      white: player(g.players[0]),
      black: player(g.players[1]),
      whiteClockMs: g.players[0].clock === undefined ? undefined : g.players[0].clock * 10,
      blackClockMs: g.players[1].clock === undefined ? undefined : g.players[1].clock * 10,
      result: g.status === '½-½' ? '1/2-1/2' : (g.status as Result),
    })),
  };
}

/** Masters explorer name of the position after `uci` ("C20 King's Pawn Game"), or null. Throws on HTTP errors and on a timeout. */
export async function fetchOpening(
  uci: readonly string[],
  f: Fetch = fetch,
  timeoutMs = EXPLORER_TIMEOUT_MS,
): Promise<string | null> {
  openingLookups.inc(); // counts lookups, a locally paused one (which throws without a request) included
  const r = await getJson<{ opening?: { eco: string; name: string } | null }>(
    `${EXPLORER}/masters?play=${uci.join(',')}`,
    f,
    'explorer',
    timeoutMs,
  );
  return r.opening ? `${r.opening.eco} ${r.opening.name}` : null;
}

export function _resetForTests() {
  pausedUntil = 0;
}
