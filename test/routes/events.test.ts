import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyEvent } from '../../shared/live.js';
import type { Eval, SearchInfo, Snapshot, SseEvent } from '../../shared/types.js';
import { viewers } from '../../src/metrics.js';
import type { RoundState } from '../../src/round-state.js';
import { SiteState } from '../../src/site-state.js';
import { eventsRouter } from '../../src/routes/events.js';
import { val } from '../helpers/metric.js';
import { sse } from '../helpers/sse.js';

const round = {
  id: 'r',
  name: 'R1',
  tourId: 't',
  boards: [{ id: 'g', name: 'b', white: { name: 'W' }, black: { name: 'B' }, result: '*' as const }],
};
const search = (depth: number): SearchInfo => ({
  boardId: 'g',
  ply: 0,
  engine: 'E',
  depth,
  nps: null,
  lines: [],
  multi: null,
  startedAt: 0,
  tier: 'current',
});
const ev: Eval = { score: { cp: 1 }, depth: 1, kind: 'complete', bestmove: null, lines: [] };
const event = { tourId: 't', name: 'Event', link: 'x' };
const rebuild = (events: SseEvent[]) => events.reduce<Snapshot | null>(applyEvent, null);
let site: SiteState, state: RoundState, server: Server, url: string;

beforeEach(async () => {
  site = new SiteState({
    load: async () => null,
    save: async () => {},
    loadRound: async () => null,
    saveRound: async () => {},
    listRounds: async () => [],
  });
  state = site.addEvent(event, 8);
  server = express()
    .use(eventsRouter(site, { throttleMs: 50, heartbeatMs: 20 }))
    .listen(0);
  await once(server, 'listening');
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/events`;
});
afterEach(() => {
  server.closeAllConnections();
  server.close();
});

describe('GET /api/events', () => {
  it('sends SSE headers and a snapshot first', async () => {
    const c = await sse(url);
    expect(c.res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(c.res.headers.get('x-accel-buffering')).toBe('no');
    await vi.waitFor(() =>
      expect(c.events[0]).toEqual({ type: 'snapshot', snapshot: site.snapshot(), now: expect.any(Number) }),
    );
    await c.close();
  });

  it('coalesces search (latest wins), keeps order, and heartbeats', async () => {
    const c = await sse(url);
    state.startRound(round, null);
    for (let d = 1; d <= 10; d++) site.setSearch(search(d), 't');
    state.setEval('g', 0, ev, state.epoch('g'));
    await vi.waitFor(() => expect(c.events.at(-1)?.type).toBe('ply'));
    for (let d = 11; d <= 20; d++) site.setSearch(search(d), 't');
    await vi.waitFor(() => expect(c.events.at(-1)).toEqual({ type: 'search', search: search(20) }));
    const types = c.events.map((e) => e.type);
    expect(types.slice(0, 2)).toEqual(['snapshot', 'snapshot']);
    expect(types.slice(2, -1)).toContain('ply');
    expect(types.filter((t) => t === 'search').length).toBeLessThanOrEqual(4); // 20 sent
    expect(c.events[types.indexOf('ply') - 1]).toEqual({ type: 'search', search: search(10) }); // flushed before ply
    await vi.waitFor(() => expect(c.frames).toContain(': hb'));
    await c.close();
  });

  it('stamps server time on the first frame only', async () => {
    const before = Date.now();
    const c = await sse(url);
    await vi.waitFor(() => expect(c.events).toHaveLength(1));
    const now = (c.events[0] as { now: number }).now;
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
    state.startRound(round, null);
    await vi.waitFor(() => expect(c.events).toHaveLength(2));
    expect(c.events[1]).toEqual({ type: 'snapshot', snapshot: site.snapshot() });
    await c.close();
  });

  it('unsubscribes when the client goes away', async () => {
    const c = await sse(url);
    await vi.waitFor(() => expect(site.listenerCount('event')).toBe(1));
    await c.close();
    await vi.waitFor(() => expect(site.listenerCount('event')).toBe(0));
  });

  it('counts open streams as viewers', async () => {
    const before = await val(viewers);
    const c = await sse(url);
    await vi.waitFor(async () => expect(await val(viewers)).toBe(before + 1));
    await c.close();
    await vi.waitFor(async () => expect(await val(viewers)).toBe(before));
  });

  it('a stream without ?tour follows the Primary: fresh snapshot when it changes, empty when the Event is removed', async () => {
    const other = { tourId: 'u', name: 'Other', link: 'y' };
    const c = await sse(url);
    state.startRound(round, null);
    site.addEvent(other, 8); // not the Primary: nothing for this client
    site.event('u')!.setStream('connected');
    state.setStream('connected');
    await vi.waitFor(() => expect(c.events.at(-1)).toEqual({ type: 'stream-status', status: 'connected' }));
    expect(c.events.map((e) => e.type)).toEqual(['snapshot', 'snapshot', 'stream-status']);
    site.setPrimary('u');
    await vi.waitFor(() => expect(c.events).toHaveLength(4));
    expect(c.events[3]).toMatchObject({
      type: 'snapshot',
      snapshot: { event: other, round: null, stream: 'connected' },
    });
    site.removeEvent('u');
    site.removeEvent('t');
    await vi.waitFor(() => expect(rebuild(c.events)).toMatchObject({ event: null, round: null }));
    await c.close();
  });

  it('a search of another Event reaches the client as a single null', async () => {
    site.addEvent({ tourId: 'u', name: 'Other', link: 'y' }, 8);
    const c = await sse(url);
    const searches = () => c.events.filter((e) => e.type === 'search');
    site.setSearch(search(1), 'u'); // the client's search was already null: nothing
    site.setSearch(search(2), 't');
    await vi.waitFor(() => expect(searches()).toEqual([{ type: 'search', search: search(2) }]));
    site.setSearch(search(3), 'u');
    site.setSearch(search(4), 'u');
    await vi.waitFor(() => expect(searches().at(-1)).toEqual({ type: 'search', search: null }));
    await new Promise((r) => setTimeout(r, 100));
    expect(searches()).toHaveLength(2);
    await c.close();
  });

  it('registering another Event: one empty snapshot (the old Event leaves), then one of the new Event', async () => {
    const c = await sse(url);
    await vi.waitFor(() => expect(c.events).toHaveLength(1));
    site.removeEvent('t');
    site.addEvent({ tourId: 'u', name: 'Other', link: 'y' }, 8);
    await vi.waitFor(() => expect(c.events).toHaveLength(3));
    await new Promise((r) => setTimeout(r, 50));
    expect(c.events.map((e) => (e as { snapshot: Snapshot }).snapshot.event?.tourId ?? null)).toEqual(['t', null, 'u']);
    await c.close();
  });
});
