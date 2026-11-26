import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Eval, SearchInfo } from '../../shared/types.js';
import { viewers } from '../../src/metrics.js';
import { RoundState } from '../../src/round-state.js';
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
  startedAt: 0,
});
const ev: Eval = { score: { cp: 1 }, depth: 1, kind: 'complete', bestmove: null, lines: [] };
let state: RoundState, server: Server, url: string;

beforeEach(async () => {
  state = new RoundState({
    load: async () => null,
    save: async () => {},
    loadRound: async () => null,
    saveRound: async () => {},
  });
  server = express()
    .use(eventsRouter(state, { throttleMs: 50, heartbeatMs: 20 }))
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
    await vi.waitFor(() => expect(c.events[0]).toEqual({ type: 'snapshot', snapshot: state.snapshot() }));
    await c.close();
  });

  it('coalesces search (latest wins), keeps order, and heartbeats', async () => {
    const c = await sse(url);
    state.startRound(round, null);
    for (let d = 1; d <= 10; d++) state.setSearch(search(d));
    state.setEval('g', 0, ev, state.epoch('g'));
    await vi.waitFor(() => expect(c.events.at(-1)?.type).toBe('ply'));
    for (let d = 11; d <= 20; d++) state.setSearch(search(d));
    await vi.waitFor(() => expect(c.events.at(-1)).toEqual({ type: 'search', search: search(20) }));
    const types = c.events.map((e) => e.type);
    expect(types.slice(0, 2)).toEqual(['snapshot', 'snapshot']);
    expect(types.slice(2, -1)).toContain('ply');
    expect(types.filter((t) => t === 'search').length).toBeLessThanOrEqual(4); // 20 sent
    expect(c.events[types.indexOf('ply') - 1]).toEqual({ type: 'search', search: search(10) }); // flushed before ply
    await vi.waitFor(() => expect(c.frames).toContain(': hb'));
    await c.close();
  });

  it('unsubscribes when the client goes away', async () => {
    const c = await sse(url);
    await vi.waitFor(() => expect(state.listenerCount('event')).toBe(1));
    await c.close();
    await vi.waitFor(() => expect(state.listenerCount('event')).toBe(0));
  });

  it('counts open streams as viewers', async () => {
    const before = await val(viewers);
    const c = await sse(url);
    await vi.waitFor(async () => expect(await val(viewers)).toBe(before + 1));
    await c.close();
    await vi.waitFor(async () => expect(await val(viewers)).toBe(before));
  });
});
