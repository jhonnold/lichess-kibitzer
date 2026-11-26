import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoundState } from '../../src/round-state.js';
import type { RoundInfo } from '../../src/lichess/api.js';
import { archiveRouter } from '../../src/routes/archive.js';
import { dataStore } from '../../src/store.js';
import type { Board, Eval, Round } from '../../shared/types.js';
import { roundMeta } from '../../shared/archive.js';
import { archiveReads } from '../../src/metrics.js';
import { val } from '../helpers/metric.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kibitzer-archive-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const board = (id: string, tracked: boolean): Board => ({
  id,
  board: 1,
  white: { name: 'W' },
  black: { name: 'B' },
  result: '*',
  tracked,
  opening: null,
  clocks: { white: null, black: null },
  plies: [{ move: null, at: null, eval: null }],
});
const round = (roundId: string, name = 'Round 1'): Round => ({
  tourId: 'abcdefgh',
  roundId,
  name,
  eventName: 'Event',
  startsAt: 1,
  boards: [board('g1', true), board('g2', false)],
});
const setup = (current: Round | null = round('current1')) => {
  const stored = new Map(
    [round('round001'), round('round002', 'Round 2'), round('current1')].map((r) => [r.roundId, r]),
  );
  const store = {
    listRounds: vi.fn(async () => [...stored.values()].map(roundMeta)),
    loadRound: vi.fn(async (_t: string, r: string) => stored.get(r) ?? null),
  };
  const state = { round: current };
  return { store, app: express().use(archiveRouter({ store, state })) };
};

describe('GET /api/archive', () => {
  it('lists the archived Rounds of an Event, not the Current Round, uncached', async () => {
    const res = await request(setup().app).get('/api/archive');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe('Event');
    expect(res.body[0].rounds.map((r: { roundId: string }) => r.roundId)).toEqual(['round001', 'round002']);
  });
});

describe('GET /api/archive/:tourId/:roundId', () => {
  it('serves the Round with Tracked boards only, cacheable, with an ETag', async () => {
    const { app } = setup();
    const res = await request(app).get('/api/archive/abcdefgh/round001');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('max-age=300');
    expect(res.headers.etag).toBeTruthy();
    expect(res.body.boards.map((b: Board) => b.id)).toEqual(['g1']);
    expect(
      (await request(app).get('/api/archive/abcdefgh/round001').set('If-None-Match', res.headers.etag)).status,
    ).toBe(304);
  });

  it('404s the Current Round and a missing file; 500s a corrupt one', async () => {
    const { app, store } = setup();
    const reads = async () => [
      await val(archiveReads, { outcome: 'ok' }),
      await val(archiveReads, { outcome: 'error' }),
    ];
    const [ok, err] = await reads();
    expect((await request(app).get('/api/archive/abcdefgh/current1')).status).toBe(404);
    expect(store.loadRound).not.toHaveBeenCalled();
    expect(await reads()).toEqual([ok, err]); // no read
    expect((await request(app).get('/api/archive/abcdefgh/nofile00')).status).toBe(404);
    expect(await reads()).toEqual([ok + 1, err]); // a missing file is a successful read
    vi.spyOn(console, 'error').mockImplementation(() => {});
    store.loadRound.mockRejectedValueOnce(new Error('invalid JSON'));
    const res = await request(app).get('/api/archive/abcdefgh/round001');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'archive read failed' });
    expect(await reads()).toEqual([ok + 1, err + 1]);
    store.listRounds.mockRejectedValueOnce(new Error('EACCES'));
    expect((await request(app).get('/api/archive')).status).toBe(500);
    expect((await request(app).get('/api/archive')).status).toBe(200);
    expect(await reads()).toEqual([ok + 2, err + 2]);
  });

  it.each([
    '/api/archive/..%2F..%2Fstate/abcdefgh',
    '/api/archive/%2e%2e/abcdefgh',
    '/api/archive/abcdefgh/..%2Fx',
    '/api/archive/abcdefgh/..%2F..%2F..%2Fetc%2Fpasswd',
    '/api/archive/abcdefgh/%2e%2e%2f%2e%2e%2fstate',
    '/api/archive/abcdefg/abcdefgh',
    '/api/archive/abcdefghi/abcdefgh',
    '/api/archive/abcd-fgh/abcdefgh',
    '/api/archive/abcdefgh/abcdefgh.json',
    `/api/archive/abcdefgh/${'a'.repeat(5000)}`,
    '/api/archive/abcdefgh/abcdefg%00',
  ])('404s %s without touching the store', async (path) => {
    const { app, store } = setup();
    expect((await request(app).get(path)).status).toBe(404);
    expect(store.loadRound).not.toHaveBeenCalled();
  });

  it('serves a Round exactly as the Viewer saw it before the swap', async () => {
    const info = (id: string): RoundInfo => ({
      id,
      name: id,
      tourId: 'abcdefgh',
      boards: [1, 2, 3].map((i) => ({
        id: `game000${i}`,
        name: `b${i}`,
        white: { name: 'W' },
        black: { name: 'B' },
        whiteClockMs: 1000,
        result: '*',
      })),
    });
    const ev: Eval = { score: { cp: 20 }, depth: 12, kind: 'complete', bestmove: 'e7e5', lines: [] };
    const store = dataStore(join(dir, 'state.json'));
    const state = await RoundState.load(store);
    state.setEvent({ tourId: 'abcdefgh', name: 'Event', link: 'x' });
    state.setTopN(2);
    state.startRound(info('round001'), 5);
    state.syncMoves('game0001', [{ uci: 'e2e4', san: 'e4', clock: 100 }], 10);
    state.setEval('game0001', 1, ev, state.epoch('game0001'));
    state.setTracked(['game0001']);
    state.setTracked(['game0001', 'game0002']);
    const last = state.snapshot().round;
    state.startRound(info('round002'), 6);
    await state.saved();
    const app = express().use(archiveRouter({ store, state }));
    const res = await request(app).get('/api/archive/abcdefgh/round001');
    expect(res.body).toEqual(last);
    expect(res.body.boards).toHaveLength(2);
    const list = (await request(app).get('/api/archive')).body;
    expect(list[0].rounds.map((r: { roundId: string }) => r.roundId)).toEqual(['round001']);
  });
});
