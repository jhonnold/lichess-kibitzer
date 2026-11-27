import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { probeEngine, type Engine } from '../../src/engine/engine.js';
import type { FollowStatus } from '../../src/follower.js';
import { LichessError, type RoundInfo } from '../../src/lichess/api.js';
import { SiteState } from '../../src/site-state.js';
import type { EngineState } from '../../src/scheduler.js';
import type { JobTiming } from '../../shared/timing.js';
import { DEFAULT_PASSES_MS, type EngineRole } from '../../shared/types.js';
import { engineConfig } from '../../shared/engine-config.js';

const FAKE = fileURLToPath(new URL('../fixtures/fake-uci.mjs', import.meta.url));
const roundInfo = (id: string): RoundInfo => ({
  id,
  name: 'Round 1',
  tourId: 't',
  boards: ['a', 'b', 'c'].map((g) => ({
    id: g,
    name: g,
    white: { name: `W${g}` },
    black: { name: `B${g}` },
    result: '*',
  })),
});
const defaultEngine = engineConfig('berserk');

function setup(adminPassword = 'pw') {
  const state = new SiteState({
    load: async () => null,
    save: async () => {},
    loadRound: async () => null,
    saveRound: async () => {},
  });
  const scheduler = {
    engine: null as Engine | null,
    running: null,
    setPasses: vi.fn(async () => {}),
    setTracked: vi.fn(async () => {}),
    setEngine: vi.fn(async () => {}),
    requeueDead: vi.fn(async (_boardId: string, ply: number) => ply === 1),
    discardDead: vi.fn(async (_boardId: string, ply: number) => ply === 1),
    engines: [] as Engine[],
    copyState: (): EngineState => 'up',
    copyRestarts: (role: EngineRole) => (role === 'main' ? 2 : 1),
    timing: [] as JobTiming[],
    passCounts: [] as number[],
    evictions: [],
  };
  const status: FollowStatus = { next: null, swapAt: null, polledAt: 5, error: null };
  const other: FollowStatus = { ...status, polledAt: 9 };
  const site = {
    status: vi.fn((tourId: string) => (tourId === 't' ? status : other)),
    add: vi.fn(async (link: string, topN = 8) => {
      if (link === 'busy') throw new LichessError(429, 'rate limited');
      if (link !== 'ok') throw new Error('Not a URL');
      return state.addEvent({ tourId: link === 'ok' ? 't' : 'u', name: 'Event', link }, topN).event;
    }),
    remove: vi.fn(async (tourId: string) => state.removeEvent(tourId)),
    setPrimary: vi.fn((tourId: string) => state.setPrimary(tourId)),
  };
  const app = createApp({
    store: { listRounds: async () => [], loadRound: async () => null },
    state,
    scheduler,
    site,
    adminPassword,
    defaultEngine,
    probe: (path) => probeEngine(process.execPath, { args: [path] }), // fake-uci.mjs has no shebang
  });
  return { state, scheduler, site, status, app, agent: request.agent(app) };
}
const login = async (agent: ReturnType<typeof request.agent>) =>
  agent.post('/api/admin/login').send({ password: 'pw' });

describe('admin auth', () => {
  it('sets an httpOnly SameSite=Strict cookie only for the right password', async () => {
    const { agent } = setup();
    expect((await agent.get('/api/admin/status')).status).toBe(401);
    expect((await agent.post('/api/admin/login').send({ password: 'nope' })).status).toBe(401);
    const res = await login(agent);
    expect(res.status).toBe(204);
    expect(res.headers['set-cookie'][0]).toMatch(/^kibitzer_admin=\d+\.[\w-]+;.*HttpOnly; SameSite=Strict/);
    expect((await agent.get('/api/admin/status')).status).toBe(200);
  });

  it('refuses tampered or foreign cookies and an unset password', async () => {
    const a = setup();
    const cookie = (await login(a.agent)).headers['set-cookie'][0].split(';')[0];
    const [name, exp, sig] = cookie.split(/[=.]/);
    const forged = `${name}=${Number(exp) + 1}.${sig}`;
    expect((await request(a.app).get('/api/admin/status').set('Cookie', forged)).status).toBe(401);
    expect((await request(setup().app).get('/api/admin/status').set('Cookie', cookie)).status).toBe(401); // other secret
    expect((await login(setup('').agent)).status).toBe(401);
  });

  it('refuses every route but login without the cookie, changing nothing', async () => {
    const { app, state, scheduler, site } = setup();
    const calls: ['get' | 'post' | 'put' | 'delete', string, object?][] = [
      ['post', '/engine/probe', { path: FAKE }],
      ['post', '/engine/button', { name: 'Clear Hash' }],
      ['put', '/config', { path: 'x', options: {} }],
      ['post', '/event', { link: 'ok' }],
      ['delete', '/event/t'],
      ['put', '/event/t/topn', { n: 3 }],
      ['put', '/event/t/tracked', { boardIds: [] }],
      ['put', '/primary', { tourId: 't' }],
      ['put', '/passes', { ms: [50, null, null] }],
      ['post', '/dead/requeue', { boardId: 'a', ply: 1 }],
      ['post', '/dead/discard', { boardId: 'a', ply: 1 }],
    ];
    for (const [method, path, body] of calls) {
      const res = await request(app)[method](`/api/admin${path}`).send(body);
      expect([path, res.status]).toEqual([path, 401]);
    }
    for (const fn of [...Object.values(scheduler), ...Object.values(site)])
      if (vi.isMockFunction(fn)) expect(fn).not.toHaveBeenCalled();
    expect([state.primaryState, state.events]).toEqual([null, []]);
  });
});

describe('admin routes', () => {
  it('probes an engine; rejects a non-UCI one', async () => {
    const { agent } = setup();
    await login(agent);
    const res = await agent.post('/api/admin/engine/probe').send({ path: FAKE });
    expect(res.body.name).toBe('FakeEngine');
    expect(res.body.options.map((o: { name: string }) => o.name)).toContain('MultiPV');
    expect((await agent.post('/api/admin/engine/probe').send({ path: '/nonexistent' })).status).toBe(400);
  });

  it('sends a button option to every running copy only', async () => {
    const { agent, scheduler } = setup();
    await login(agent);
    expect((await agent.post('/api/admin/engine/button').send({ name: 'Clear Hash' })).status).toBe(409);
    const [main, multi] = [vi.fn(), vi.fn()];
    scheduler.engines = [{ setOption: main }, { setOption: multi }] as unknown as Engine[];
    expect((await agent.post('/api/admin/engine/button').send({ name: 'Clear Hash\ngo' })).status).toBe(400);
    expect((await agent.post('/api/admin/engine/button').send({ name: 'Clear Hash' })).status).toBe(204);
    expect([main.mock.calls, multi.mock.calls]).toEqual([[['Clear Hash']], [['Clear Hash']]]);
  });

  it('answers malformed JSON with a 400 JSON error, no stack', async () => {
    const { agent } = setup();
    await login(agent);
    const res = await agent.put('/api/admin/config').set('Content-Type', 'application/json').send('{bad');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'bad request' });
    expect(res.text).not.toContain('at ');
  });

  it('validates the engine config and hands it to the scheduler', async () => {
    const { agent, scheduler } = setup();
    await login(agent);
    const put = (body: object) => agent.put('/api/admin/config').send(body);
    const copies = { main: { threads: 2, hash: 64 }, multi: { threads: 1, hash: 32, multiPv: 3 } };
    expect((await put({ path: '/e', options: { Style: 1 }, ...copies })).status).toBe(400);
    expect((await put({ path: '/e', options: { 'Style\nquit': '1' }, ...copies })).status).toBe(400);
    expect((await put({ path: '/e', options: { Style: '1\nquit' }, ...copies })).status).toBe(400);
    expect((await put({ path: '/e', options: { MultiPV: '3' }, ...copies })).status).toBe(400); // a copy's own
    expect((await put({ path: '/e', options: {} })).status).toBe(400); // no copies
    expect((await put({ path: '/e', options: {}, ...copies, main: { threads: 0, hash: 64 } })).status).toBe(400);
    expect(
      (await put({ path: '/e', options: {}, ...copies, multi: { threads: 1, hash: 32, multiPv: 1 } })).status,
    ).toBe(400);
    expect(scheduler.setEngine).not.toHaveBeenCalled();
    expect((await put({ path: '/e', options: { Style: 'Risky' }, ...copies, extra: 1 })).status).toBe(204);
    expect(scheduler.setEngine.mock.calls).toEqual([[{ path: '/e', options: { Style: 'Risky' }, ...copies }]]);
    scheduler.setEngine.mockRejectedValueOnce(new Error('spawn failed'));
    expect(await put({ path: '/e', options: {}, ...copies })).toMatchObject({
      status: 400,
      body: { error: 'spawn failed' },
    });
  });

  it('registers an Event through the Site: validates, passes Lichess errors through', async () => {
    const { agent, state, site } = setup();
    await login(agent);
    const post = (body: object) => agent.post('/api/admin/event').send(body);
    expect((await post({})).status).toBe(400);
    expect((await post({ link: 1 })).status).toBe(400);
    expect(site.add).not.toHaveBeenCalled();
    expect(await post({ link: 'busy' })).toMatchObject({ status: 429, body: { error: 'rate limited' } });
    expect(await post({ link: 'nope' })).toMatchObject({ status: 400, body: { error: 'Not a URL' } });
    expect((await post({ link: 'ok' })).status).toBe(204);
    expect(site.add.mock.calls.at(-1)).toEqual(['ok', undefined]);
    expect(state.primaryState?.event).toEqual({ tourId: 't', name: 'Event', link: 'ok' });
  });

  it('POST /event passes topN; 400 for topN 0/65/1.5', async () => {
    const { agent, site } = setup();
    await login(agent);
    const post = (body: object) => agent.post('/api/admin/event').send(body);
    for (const topN of [0, 65, 1.5, '3'] as const) expect((await post({ link: 'ok', topN })).status).toBe(400);
    expect(site.add).not.toHaveBeenCalled();
    expect((await post({ link: 'ok', topN: 3 })).status).toBe(204);
    expect(site.add.mock.calls).toEqual([['ok', 3]]);
  });

  it('DELETE /event/:t removes through the Site: 204, 404 for an unknown Event', async () => {
    const { agent, state, site } = setup();
    await login(agent);
    state.addEvent({ tourId: 't', name: 'Event', link: 'ok' }, 2);
    state.addEvent({ tourId: 'u', name: 'U', link: 'u' }, 2);
    expect((await agent.delete('/api/admin/event/nope')).status).toBe(404);
    expect((await agent.delete('/api/admin/event/t')).status).toBe(204);
    expect(site.remove.mock.calls).toEqual([['nope'], ['t']]);
    expect([state.primary, state.events.map((e) => e.event.tourId)]).toEqual(['u', ['u']]);
  });

  it('PUT /event/:t/topn: 204 for that Event only, 400 for a bad n, 404 for an unknown Event', async () => {
    const { agent, state } = setup();
    await login(agent);
    state.addEvent({ tourId: 't', name: 'Event', link: 'ok' }, 8);
    state.addEvent({ tourId: 'u', name: 'U', link: 'u' }, 8);
    const put = (t: string, n: unknown) => agent.put(`/api/admin/event/${t}/topn`).send({ n });
    for (const n of [0, 2.5, '3', 65, undefined]) expect((await put('u', n)).status).toBe(400);
    expect((await put('nope', 3)).status).toBe(404);
    expect((await put('u', 3)).status).toBe(204);
    expect(state.events.map((e) => e.topN)).toEqual([8, 3]);
  });

  it('PUT /event/:t/tracked: 404 unknown Event, 409 no Current Round, 400 bad ids; reaches that Event', async () => {
    const { agent, state, scheduler } = setup();
    await login(agent);
    const t = state.addEvent({ tourId: 't', name: 'Event', link: 'ok' }, 2);
    state.addEvent({ tourId: 'u', name: 'U', link: 'u' }, 2);
    const tracked = (tourId: string, boardIds: unknown) =>
      agent.put(`/api/admin/event/${tourId}/tracked`).send({ boardIds });
    expect((await tracked('nope', ['a'])).status).toBe(404);
    expect((await tracked('t', ['a'])).status).toBe(409); // no Current Round
    t.startRound(roundInfo('r1'), 1000);
    expect((await tracked('u', ['a'])).status).toBe(409); // u has none: t's Boards are not its
    expect((await tracked('t', [1])).status).toBe(400);
    expect((await tracked('t', 'a')).status).toBe(400);
    expect((await tracked('t', ['b', 'zz'])).status).toBe(400); // not a Board of the Current Round
    expect(scheduler.setTracked).not.toHaveBeenCalled();
    expect((await tracked('t', ['b'])).status).toBe(204);
    expect(scheduler.setTracked.mock.calls).toEqual([['t', ['b']]]);
  });

  it('PUT /primary: 204, 400 when not a string, 404 for an unknown Event', async () => {
    const { agent, state } = setup();
    await login(agent);
    state.addEvent({ tourId: 't', name: 'Event', link: 'ok' }, 2);
    state.addEvent({ tourId: 'u', name: 'U', link: 'u' }, 2);
    const put = (tourId: unknown) => agent.put('/api/admin/primary').send({ tourId });
    for (const tourId of [undefined, 1, null]) expect((await put(tourId)).status).toBe(400);
    expect((await put('nope')).status).toBe(404);
    expect(state.primary).toBe('t');
    expect((await put('u')).status).toBe(204);
    expect(state.primary).toBe('u');
  });

  it('/clear, /topn and /tracked are gone', async () => {
    const { agent, state } = setup();
    await login(agent);
    state.addEvent({ tourId: 't', name: 'Event', link: 'ok' }, 2);
    expect((await agent.post('/api/admin/clear')).status).toBe(404);
    expect((await agent.put('/api/admin/topn').send({ n: 3 })).status).toBe(404);
    expect((await agent.put('/api/admin/tracked').send({ boardIds: [] })).status).toBe(404);
    expect(state.events).toHaveLength(1);
  });

  it('validates the Passes', async () => {
    const { agent, scheduler } = setup();
    await login(agent);
    for (const ms of [
      50,
      'x',
      undefined,
      [50, null],
      [0, null, null],
      [-1, null, null],
      [1e300, null, null],
      [null, 50, null],
      [50, 50, null],
      [50, null, 40],
      [50, 1.5, null],
    ]) {
      expect((await agent.put('/api/admin/passes').send({ ms })).status).toBe(400);
    }
    await agent.put('/api/admin/passes').send({ ms: [50, null, 900] });
    await agent.put('/api/admin/passes').send({ ms: null });
    expect(scheduler.setPasses.mock.calls).toEqual([[[50, null, 900]], [null]]);
  });

  it('requeues and discards Dead-letter queue entries', async () => {
    const { agent, scheduler } = setup();
    await login(agent);
    for (const [route, fn] of [
      ['requeue', scheduler.requeueDead],
      ['discard', scheduler.discardDead],
    ] as const) {
      const post = (body: unknown) => agent.post(`/api/admin/dead/${route}`).send(body);
      expect((await post({ boardId: 'a', ply: 1 })).status).toBe(204);
      expect(fn.mock.calls).toEqual([['a', 1]]);
      const missing = await post({ boardId: 'a', ply: 2 });
      expect([missing.status, missing.body]).toEqual([404, { error: 'not in the Dead-letter queue' }]);
      for (const body of [
        {},
        { boardId: 'a' },
        { boardId: 'a', ply: -1 },
        { boardId: 'a', ply: 1.5 },
        { boardId: 1, ply: 1 },
      ])
        expect((await post(body)).status).toBe(400);
      expect(fn).toHaveBeenCalledTimes(2);
    }
  });

  it('reports the Scheduler timing in the status', async () => {
    const { agent, scheduler } = setup();
    await login(agent);
    scheduler.timing = [{ jobs: 3, provisional: 1, ms: { p50: 800, p95: 900 }, depth: { p50: 20, p95: 22 } }];
    expect((await agent.get('/api/admin/status')).body.timing).toEqual(scheduler.timing);
  });

  it('reports status: site fields, then every Event in order with the primary flag, the total tracked, the running tourId', async () => {
    const { agent, state, status, scheduler } = setup();
    await login(agent);
    const idle = {
      engine: defaultEngine,
      engineRunning: false,
      copies: { main: { state: 'up', restarts: 2 }, multi: { state: 'up', restarts: 1 } },
      timing: [],
      passesMs: DEFAULT_PASSES_MS,
      running: null,
      queue: { current: [], backfill: 0, deferred: [] },
      passCounts: [],
      evictions: [],
      tracked: 0,
      primary: null,
      events: [],
    };
    expect((await agent.get('/api/admin/status')).body).toEqual(idle);
    const t = state.addEvent({ tourId: 't', name: 'Event', link: 'ok' }, 2);
    const u = state.addEvent({ tourId: 'u', name: 'U', link: 'u' }, 3);
    t.startRound(roundInfo('r1'), 1000);
    u.startRound({ ...roundInfo('r2'), tourId: 'u' }, 1000);
    scheduler.running = { tourId: 'u', boardId: 'a', ply: 1, tier: 'current' } as never;
    const body = (await agent.get('/api/admin/status')).body;
    expect(body).toMatchObject({ tracked: 5, primary: 't', running: { tourId: 'u' } });
    expect(
      body.events.map((e: { event: { tourId: string }; primary: boolean; topN: number }) => [
        e.event.tourId,
        e.primary,
        e.topN,
      ]),
    ).toEqual([
      ['t', true, 2],
      ['u', false, 3],
    ]);
    const [a, b] = body.events;
    expect(a.follow).toEqual(status);
    expect(b.follow).toEqual({ ...status, polledAt: 9 });
    expect(a.round).toMatchObject({ tourId: 't', roundId: 'r1', name: 'Round 1' });
    expect(a.round.boards.map((x: { id: string; tracked: boolean }) => [x.id, x.tracked])).toEqual([
      ['a', true],
      ['b', true],
      ['c', false],
    ]);
    expect(a).toMatchObject({ stream: null, dead: [] });
  });
});
