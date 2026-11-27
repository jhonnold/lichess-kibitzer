import { LICHESS_ID } from '../../shared/archive.js';
import { lichessDuration, lichessRequests, openingLookups, rateLimited } from '../metrics.js';

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
  // `finished` is deprecated in favour of `finishedAt`
  rounds: { id: string; name: string; ongoing?: boolean; finished?: boolean; finishedAt?: number; startsAt?: number }[];
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
export type Endpoint = 'event' | 'round' | 'pgn' | 'explorer';
export type Outcome = 'ok' | 'http_error' | 'rate_limited' | 'timeout' | 'network' | 'paused';
function get<T>(
  url: string,
  f: Fetch,
  endpoint: Endpoint,
  accept: string,
  read: (res: Response) => Promise<T>,
  lane: keyof typeof queues = 'api',
  timeoutMs?: number,
): Promise<T> {
  const run = async () => {
    const count = (outcome: Outcome) => lichessRequests.inc({ endpoint, outcome });
    if (Date.now() < pausedUntil) {
      count('paused');
      throw new LichessError(429, 'Lichess rate limit; retry in a minute');
    }
    const end = lichessDuration.startTimer({ endpoint }); // after the lane wait: latency, not queueing
    let res: Response;
    try {
      res = await f(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: accept },
        signal: timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      count((err as Error | undefined)?.name === 'TimeoutError' ? 'timeout' : 'network');
      throw err;
    }
    if (res.status === 429) {
      rateLimited.inc({ source: 'api' });
      pausedUntil = Date.now() + RATE_LIMIT_MS;
    }
    if (!res.ok) {
      end();
      count(res.status === 429 ? 'rate_limited' : 'http_error');
      throw new LichessError(res.status, `Lichess ${new URL(url).pathname} → HTTP ${res.status}`);
    }
    try {
      const body = await read(res);
      end();
      count('ok');
      return body;
    } catch (err) {
      // The body broke off (or timed out) mid-read, or is not JSON (JSON calls).
      count((err as Error | undefined)?.name === 'TimeoutError' ? 'timeout' : 'network');
      throw err;
    }
  };
  const p = queues[lane].then(run, run);
  queues[lane] = p.catch(() => undefined);
  return p;
}

const getJson = <T>(url: string, f: Fetch, endpoint: Endpoint, lane?: keyof typeof queues, timeoutMs?: number) =>
  get(url, f, endpoint, 'application/json', (res) => res.json() as Promise<T>, lane, timeoutMs);

export async function fetchEvent(link: string, f: Fetch = fetch): Promise<EventInfo> {
  const ref = parseEventLink(link);
  let tourId = ref.id;
  if (ref.kind === 'round') {
    const r = await getJson<RoundJson>(`${BASE}/api/broadcast/-/-/${ref.id}`, f, 'round');
    tourId = r.tour.id;
  }
  const t = await getJson<TourJson>(`${BASE}/api/broadcast/${tourId}`, f, 'event');
  return {
    id: t.tour.id,
    name: t.tour.name,
    rounds: t.rounds.map((r) => ({
      id: r.id,
      name: r.name,
      ongoing: !!r.ongoing,
      finished: !!r.finished || r.finishedAt !== undefined,
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
  const r = await getJson<RoundJson>(`${BASE}/api/broadcast/-/-/${roundId}`, f, 'round');
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

/** The whole Round as PGN, one game per Board (GameURL tags, [%clk] comments); same lane and 429 pause as the JSON
 *  calls. */
export function fetchRoundPgn(roundId: string, f: Fetch = fetch): Promise<string> {
  return get(`${BASE}/api/broadcast/round/${roundId}.pgn`, f, 'pgn', 'application/x-chess-pgn', (res) => res.text());
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
    'explorer',
    timeoutMs,
  );
  return r.opening ? `${r.opening.eco} ${r.opening.name}` : null;
}

export function _resetForTests() {
  pausedUntil = 0;
}
