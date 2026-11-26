import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { val } from './helpers/metric.js';
import { ReplaySource } from './helpers/replay-source.js';
import { rateLimited, streamConnected, streamReconnects } from '../src/metrics.js';
import { parseGame, pgnSplitter, RoundStream, type GameUpdate, type StreamStatus } from '../src/lichess/stream.js';
import { type Fetch, USER_AGENT } from '../src/lichess/api.js';

const FIX = 'test/fixtures/lichess/';
const PGN = readFileSync(FIX + 'round-stream.pgn', 'utf8');
const ALL = pgnSplitter()(PGN); // the 7 games, in stream order
const enc = new TextEncoder();

function body(chunks: string[], signal?: AbortSignal, keepOpen = false): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const s of chunks) c.enqueue(enc.encode(s));
      if (!keepOpen) c.close();
      else
        signal?.addEventListener('abort', () => c.error(Object.assign(new Error('aborted'), { name: 'AbortError' })), {
          once: true,
        });
    },
  });
}

const slices = (s: string, n: number) => s.match(new RegExp(`[\\s\\S]{1,${n}}`, 'g'))!;

function make(fetchImpl: Fetch, maxSleeps: number) {
  const delays: number[] = [];
  const games: GameUpdate[] = [];
  const statuses: StreamStatus[] = [];
  const stream: RoundStream = new RoundStream('L3MX2oE3', {
    fetch: fetchImpl,
    sleep: async (ms) => {
      delays.push(ms);
      if (delays.length >= maxSleeps) stream.stop();
    },
  });
  stream.start({ game: (g) => games.push(g), status: (s) => statuses.push(s) });
  return { stream, games, statuses, delays };
}

describe('pgnSplitter', () => {
  it('splits the stream into 7 games, whatever the chunk size', () => {
    expect(ALL).toHaveLength(7);
    const sliced = pgnSplitter();
    const out = slices(PGN, 13).flatMap((c) => sliced(c));
    expect(out).toEqual(ALL);
  });

  it('holds a partial game until its blank line arrives', () => {
    const split = pgnSplitter();
    expect(split(ALL[0])).toEqual([]);
    expect(split('\n\n')).toEqual([ALL[0]]);
  });
});

describe('parseGame', () => {
  it('parses a live game: 52 plies, clocks, players, ongoing', () => {
    const u = parseGame(ALL[0]);
    expect(u!.gameId).toBe('at7GqSzo');
    expect(u!.uci).toHaveLength(52);
    expect(u!.san.slice(0, 2)).toEqual(['d4', 'd5']);
    expect(u!.uci.slice(0, 2)).toEqual(['d2d4', 'd7d5']);
    expect(u!.san[51]).toBe('Rc3');
    expect(u!.clocks.slice(50, 52)).toEqual([408000, 285000]);
    expect(u!.white).toMatchObject({ name: 'Hoefelsauer, Thomas', title: 'FM', rating: 2284 });
    expect(u!.black).toMatchObject({ name: 'Huber, Benedikt' });
    expect(u!.result).toBe('*');
    expect(u!.status).toBe('ongoing');
  });

  it('parses a finished game: clocks present on every ply, %eval and text comments ignored', () => {
    const u = parseGame(ALL[1]);
    expect(u!.gameId).toBe('qbPxmdQ2');
    expect(u!.uci).toHaveLength(38);
    expect(u!.clocks.every((c) => c !== null)).toBe(true);
    expect(u!.san).toContain('Ne4');
    expect(u!.result).toBe('0-1');
    expect(u!.status).toBe('finished');
  });

  it('reads the opening from the ECO and Opening tags, name alone without ECO, null without Opening', () => {
    expect(parseGame(ALL[0])!.opening).toBe('E06 Catalan Opening: Closed');
    expect(parseGame(ALL[0].replace(/^\[ECO[^\n]*\n/m, ''))!.opening).toBe('Catalan Opening: Closed');
    expect(parseGame(ALL[0].replace(/^\[Opening[^\n]*\n/m, ''))!.opening).toBeNull();
  });

  it('parses an Upcoming Board: no moves, ongoing', () => {
    const u = parseGame(ALL[0].slice(0, ALL[0].indexOf('\n\n') + 2) + '*');
    expect(u).toMatchObject({ gameId: 'at7GqSzo', uci: [], status: 'ongoing' });
  });

  it('returns null for no GameURL tag, a FEN header, and an illegal move', () => {
    expect(parseGame(ALL[0].replace(/^\[GameURL[^\n]*\n/m, ''))).toBeNull();
    expect(parseGame(ALL[0].replace('[Event', '[FEN "8/8/8/8/8/8/8/8 w - - 0 1"]\n[Event'))).toBeNull();
    expect(parseGame(ALL[0].replace('1. d4 ', '1. d5 '))).toBeNull();
  });
});

describe('RoundStream', () => {
  it('streams every Board in stream order, then backs off once', async () => {
    const eof = await val(streamReconnects, { reason: 'eof' });
    const f = vi.fn<Fetch>(async () => new Response(body(slices(PGN, 500)), { status: 200 }));
    const { stream, games, statuses, delays } = make(f, 1);
    await stream.done;
    const [url, init] = f.mock.calls[0];
    expect(String(url)).toBe('https://lichess.org/api/stream/broadcast/round/L3MX2oE3.pgn');
    expect((init?.headers as Record<string, string>)['User-Agent']).toBe(USER_AGENT);
    expect(games.map((g) => [g.gameId, g.uci.length])).toEqual([
      ['at7GqSzo', 52],
      ['qbPxmdQ2', 38],
      ['gH77VTmz', 65],
      ['at7GqSzo', 53],
      ['gH77VTmz', 66],
      ['at7GqSzo', 54],
      ['at7GqSzo', 55],
    ]);
    expect(statuses).toEqual(['connected', 'reconnecting']);
    expect(delays).toEqual([1000]);
    expect(await val(streamReconnects, { reason: 'eof' })).toBe(eof + 1);
    expect(await val(streamConnected)).toBe(0);
  });

  it('counts an HTTP error as a reconnect with reason http_error', async () => {
    const n = await val(streamReconnects, { reason: 'http_error' });
    const { stream, statuses } = make(async () => new Response('down', { status: 503 }), 1);
    await stream.done;
    expect(statuses).toEqual(['reconnecting']);
    expect(await val(streamReconnects, { reason: 'http_error' })).toBe(n + 1);
  });

  it('dedupes a reconnect that resends the latest state of each Board', async () => {
    let n = 0;
    const f: Fetch = async () => {
      n++;
      return new Response(body(n === 1 ? slices(PGN, 500) : [ALL[6] + '\n\n' + ALL[1] + '\n\n']), { status: 200 });
    };
    const { stream, games, statuses, delays } = make(f, 2);
    await stream.done;
    expect(games).toHaveLength(7);
    expect(statuses).toEqual(['connected', 'reconnecting', 'connected', 'reconnecting']);
    expect(delays).toEqual([1000, 1000]);
  });

  it('backs off a Round whose Boards are all Finished', async () => {
    const f = vi.fn<Fetch>(async () => new Response(body([ALL[1] + '\n\n']), { status: 200 }));
    const { stream, games, delays } = make(f, 3);
    await stream.done;
    expect(games.map((g) => g.gameId)).toEqual(['qbPxmdQ2']);
    expect(delays).toEqual([1000, 2000, 4000]);
  });

  it('backs off exponentially to 60s on network errors; waits a minute on 429', async () => {
    const f = vi.fn<Fetch>(async () => {
      throw new TypeError('fetch failed');
    });
    const { stream, statuses, delays } = make(f, 8);
    await stream.done;
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
    expect(f).toHaveBeenCalledTimes(8);
    expect(statuses).not.toContain('connected');

    const limited = await val(rateLimited, { source: 'stream' });
    const reconnects = async () => [
      await val(streamReconnects, { reason: 'rate_limited' }),
      await val(streamReconnects, { reason: 'network' }),
    ];
    const [r429, rNet] = await reconnects();
    let n = 0;
    const g: Fetch = async () => {
      n++;
      if (n === 1) return new Response(null, { status: 429 });
      throw new TypeError('fetch failed');
    };
    const r = make(g, 2);
    await r.stream.done;
    expect(r.delays).toEqual([60000, 1000]);
    expect(await val(rateLimited, { source: 'stream' })).toBe(limited + 1);
    expect(await reconnects()).toEqual([r429 + 1, rNet + 1]);
  });

  it('keeps following every Board after one finishes, until stop()', async () => {
    const f: Fetch = async (_url, init) =>
      new Response(body(slices(PGN, 500), init?.signal ?? undefined, true), { status: 200 });
    const { stream, games, statuses, delays } = make(f, 99);
    await vi.waitFor(() => expect(games).toHaveLength(7));
    expect(games[1].status).toBe('finished');
    expect(statuses).toEqual(['connected']);
    expect(await val(streamConnected)).toBe(1);
    stream.stop();
    await stream.done;
    expect(await val(streamConnected)).toBe(0); // the abort path, which skips 'reconnecting'
    expect(statuses).toEqual(['connected']);
    expect(delays).toEqual([]);
  });
});

describe('ReplaySource', () => {
  it('replays the fixture, then forwards push and status', () => {
    const src = ReplaySource.fromFile(FIX + 'round-stream.pgn', 'at7GqSzo');
    expect(src.updates).toHaveLength(4);
    const got: GameUpdate[] = [];
    const statuses: StreamStatus[] = [];
    src.start({ game: (g) => got.push(g), status: (s) => statuses.push(s) });
    expect(src.started).toBe(true);
    for (let i = 0; i < 4; i++) expect(src.next()).toBe(src.updates[i]);
    expect(src.next()).toBeUndefined();
    expect(got).toEqual(src.updates);

    src.status('connected');
    expect(statuses).toEqual(['connected']);
    src.push({ ...src.updates[3], result: '1-0', status: 'finished' });
    expect(got).toHaveLength(5);
    expect(src.stopped).toBe(false);
  });

  it('replays every Board of the fixture without a gameId', () => {
    const src = ReplaySource.fromFile(FIX + 'round-stream.pgn');
    expect(src.updates).toHaveLength(7);
    expect(new Set(src.updates.map((u) => u.gameId))).toEqual(new Set(['at7GqSzo', 'qbPxmdQ2', 'gH77VTmz']));
  });
});
