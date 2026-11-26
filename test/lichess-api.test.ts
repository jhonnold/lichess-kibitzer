import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetForTests,
  EXPLORER,
  fetchEvent,
  fetchOpening,
  fetchRound,
  LichessError,
  parseEventLink,
  RATE_LIMIT_MS,
  USER_AGENT,
  type Fetch,
} from '../src/lichess/api.js';
import { openingLookups, rateLimited } from '../src/metrics.js';
import { val } from './helpers/metric.js';

const FIX = 'test/fixtures/lichess/';
const json = (file: string) => () => new Response(readFileSync(FIX + file, 'utf8'), { status: 200 });

function fakeFetch(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  const f: Fetch = async (input) => {
    const { pathname } = new URL(String(input));
    calls.push(pathname);
    const route = routes[pathname];
    if (!route) throw new Error(`unexpected ${pathname}`);
    return route();
  };
  return { f, calls };
}

beforeEach(() => _resetForTests());
afterEach(() => vi.useRealTimers());

describe('parseEventLink', () => {
  it('reads a tour link', () => {
    expect(parseEventLink('https://lichess.org/broadcast/1-bundesliga-austria-20262027/IjDgZVUR')).toEqual({
      kind: 'tour',
      id: 'IjDgZVUR',
    });
  });

  it('reads round links with a game id, a query and a fragment', () => {
    const round = { kind: 'round', id: 'L3MX2oE3' };
    const base = 'https://lichess.org/broadcast/1-bundesliga-austria-20262027/round-1/L3MX2oE3';
    expect(parseEventLink(base)).toEqual(round);
    expect(parseEventLink(`${base}/at7GqSzo`)).toEqual(round);
    expect(parseEventLink(`${base}?x#y`)).toEqual(round);
  });

  it('rejects foreign hosts, other paths, short ids and non-URLs', () => {
    for (const bad of [
      'https://example.com/broadcast/a/IjDgZVUR',
      'https://lichess.org/study/abc',
      'https://lichess.org/broadcast/slug/short',
      'not a url',
    ]) {
      expect(() => parseEventLink(bad)).toThrow();
    }
  });
});

describe('fetchEvent / fetchRound', () => {
  it('fetches a tour link with one request', async () => {
    const { f, calls } = fakeFetch({ '/api/broadcast/IjDgZVUR': json('tour.json') });
    const ev = await fetchEvent('https://lichess.org/broadcast/1-bundesliga-austria-20262027/IjDgZVUR', f);
    expect(calls).toEqual(['/api/broadcast/IjDgZVUR']);
    expect(ev.name).toBe('1. Bundesliga Austria 2026/2027');
    expect(ev.rounds).toHaveLength(3);
    expect(ev.rounds[0]).toMatchObject({ id: 'L3MX2oE3', ongoing: true, finished: false });
    expect(ev.defaultRoundId).toBe('L3MX2oE3');
  });

  it('resolves a round link to its tour, in order', async () => {
    const { f, calls } = fakeFetch({
      '/api/broadcast/-/-/L3MX2oE3': json('round.json'),
      '/api/broadcast/IjDgZVUR': json('tour.json'),
    });
    const ev = await fetchEvent('https://lichess.org/broadcast/1-bundesliga-austria-20262027/round-1/L3MX2oE3', f);
    expect(calls).toEqual(['/api/broadcast/-/-/L3MX2oE3', '/api/broadcast/IjDgZVUR']);
    expect(ev.defaultRoundId).toBe('L3MX2oE3');
  });

  it('maps round boards: clocks in ms, player fields, normalised result', async () => {
    const { f } = fakeFetch({ '/api/broadcast/-/-/L3MX2oE3': json('round.json') });
    const r = await fetchRound('L3MX2oE3', f);
    expect(r.tourId).toBe('IjDgZVUR');
    expect(r.boards).toHaveLength(4);
    const byId = Object.fromEntries(r.boards.map((b) => [b.id, b]));
    expect(byId.at7GqSzo).toMatchObject({
      white: { name: 'Hoefelsauer, Thomas', title: 'FM', rating: 2284 },
      whiteClockMs: 408000,
      blackClockMs: 285000,
      result: '*',
    });
    expect(byId.Np4zluu9.result).toBe('1/2-1/2');
    expect(byId.qbPxmdQ2.result).toBe('0-1');
  });

  it('rejects a non-OK response with LichessError', async () => {
    const { f } = fakeFetch({ '/api/broadcast/-/-/L3MX2oE3': () => new Response(null, { status: 500 }) });
    await expect(fetchRound('L3MX2oE3', f)).rejects.toMatchObject({ status: 500 });
    await expect(fetchRound('L3MX2oE3', f)).rejects.toBeInstanceOf(LichessError);
  });
});

describe('fetchOpening', () => {
  const reply = (body: unknown, status = 200) =>
    vi.fn<Fetch>(async () => new Response(JSON.stringify(body), { status }));

  it('asks the masters explorer for the position and names it with its ECO', async () => {
    const f = reply({ opening: { eco: 'C20', name: "King's Pawn Game" } });
    const lookups = await val(openingLookups);
    expect(await fetchOpening(['e2e4', 'e7e5'], f)).toBe("C20 King's Pawn Game");
    expect(f).toHaveBeenCalledWith(
      `${EXPLORER}/masters?play=e2e4,e7e5`,
      expect.objectContaining({
        headers: expect.objectContaining({ 'User-Agent': USER_AGENT }),
      }),
    );
    expect(await val(openingLookups)).toBe(lookups + 1);
  });

  it('is null for a position the book has no name for', async () => {
    expect(await fetchOpening(['a2a3'], reply({ opening: null }))).toBeNull();
  });

  it('throws on an HTTP error, and after a 429 without calling fetch', async () => {
    await expect(fetchOpening(['e2e4'], reply({}, 500))).rejects.toMatchObject({ status: 500 });
    const f = reply({}, 429);
    await expect(fetchOpening(['e2e4'], f)).rejects.toMatchObject({ status: 429 });
    await expect(fetchOpening(['e2e4'], f)).rejects.toMatchObject({ status: 429 });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('fails a hung request on the timeout without blocking the event/round calls', async () => {
    const hung: Fetch = (_url, init) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
    const lookup = fetchOpening(['e2e4'], hung, 20);
    const { f } = fakeFetch({ '/api/broadcast/-/-/L3MX2oE3': json('round.json') });
    await expect(fetchRound('L3MX2oE3', f)).resolves.toMatchObject({ id: 'L3MX2oE3' });
    await expect(lookup).rejects.toMatchObject({ name: 'TimeoutError' });
  });
});

describe('rate limiting and serialisation', () => {
  it('pauses for a minute after a 429 without calling fetch', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    let calls = 0;
    const f: Fetch = async () => {
      calls++;
      return calls === 1 ? new Response(null, { status: 429 }) : new Response(readFileSync(FIX + 'round.json', 'utf8'));
    };

    const limited = await val(rateLimited, { source: 'api' });
    const first = await fetchRound('L3MX2oE3', f).catch((e) => e);
    expect(first).toBeInstanceOf(LichessError);
    expect(first.status).toBe(429);

    const second = await fetchRound('L3MX2oE3', f).catch((e) => e);
    expect(second.status).toBe(429);
    expect(calls).toBe(1);
    expect(await val(rateLimited, { source: 'api' })).toBe(limited + 1); // the local pause sent no request

    vi.setSystemTime(1_000_000 + RATE_LIMIT_MS);
    await expect(fetchRound('L3MX2oE3', f)).resolves.toMatchObject({ id: 'L3MX2oE3' });
    expect(calls).toBe(2);
  });

  it('runs requests one at a time', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const f: Fetch = async () => {
      calls++;
      if (calls === 1) await gate;
      return new Response(readFileSync(FIX + 'round.json', 'utf8'));
    };
    const a = fetchRound('L3MX2oE3', f);
    const b = fetchRound('L3MX2oE3', f);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(1);
    release();
    await Promise.all([a, b]);
    expect(calls).toBe(2);
  });
});
