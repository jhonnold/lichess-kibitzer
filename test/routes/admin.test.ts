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
import { DEFAULT_JOB_TIME_MS, type EngineRole } from '../../shared/types.js';
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
    setJobTime: vi.fn(async () => {}),
    setTracked: vi.fn(async () => {}),
    setEngine: vi.fn(async () => {}),
    requeueDead: vi.fn(async (_boardId: string, ply: number) => ply === 1),
    discardDead: vi.fn(async (_boardId: string, ply: number) => ply === 1),
    engines: [] as Engine[],
    copyState: (): EngineState => 'up',
    copyRestarts: (role: EngineRole) => (role === 'main' ? 2 : 1),
    timing: { jobs: 0, provisional: 0, ms: null, depth: null } as JobTiming,
    evictions: [],
  };
  const status: FollowStatus = { next: null, swapAt: null, polledAt: 5, error: null };
  const other: FollowStatus = { ...status, polledAt: 9 };
  const site = {
    status: vi.fn((tourId: string) => (tourId === 't' ? status : other)),
    add: vi.fn(async (link: string, topN = 8) => {
      if (link === 'busy') throw new LichessError(429, 'rate limited');
      if (link !== 'ok') throw new Error('Not a URL');
      return state.addEvent({ tourId: 't', name: 'Event', link }, topN).event;
    }),
    remove: vi.fn(async (tourId: string) => state.removeEvent(tourId)),
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
    const calls: ['get' | 'post' | 'put', string, object?][] = [
      ['post', '/engine/probe', { path: FAKE }],
      ['post', '/engine/button', { name: 'Clear Hash' }],
      ['put', '/config', { path: 'x', options: {} }],
      ['post', '/event', { link: 'ok' }],
      ['post', '/clear'],
      ['put', '/topn', { n: 3 }],
      ['put', '/jobtime', { ms: 50 }],
      ['put', '/tracked', { boardIds: [] }],
      ['post', '/dead/requeue', { boardId: 'a', ply: 1 }],
      ['post', '/dead/discard', { boardId: 'a', ply: 1 }],
    ];
    for (const [method, path, body] of calls) {
      const res = await request(app)[method](`/api/admin${path}`).send(body);
      expect([path, res.status]).toEqual([path, 401]);
    }
    for (const fn of [...Object.values(scheduler), site.add, site.remove])
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

  it('PUT /topn without an Event → 409', async () => {
    const { agent } = setup();
    await login(agent);
    const res = await agent.put('/api/admin/topn').send({ n: 3 });
    expect([res.status, res.body]).toEqual([409, { error: 'no Event' }]);
  });

  it('validates N, job time and the tracked set', async () => {
    const { agent, state, scheduler } = setup();
    await login(agent);
    for (const n of [0, 2.5, '3', 65]) expect((await agent.put('/api/admin/topn').send({ n })).status).toBe(400);
    expect((await agent.put('/api/admin/topn').send({ n: 3 })).status).toBe(409); // no Event
    state.addEvent({ tourId: 't', name: 'Event', link: 'ok' }, 8);
    expect((await agent.put('/api/admin/topn').send({ n: 3 })).status).toBe(204);
    expect(state.primaryState?.topN).toBe(3);
    for (const ms of [-1, 0, 'x', undefined, 1e300]) {
      expect((await agent.put('/api/admin/jobtime').send({ ms })).status).toBe(400);
    }
    await agent.put('/api/admin/jobtime').send({ ms: 50 });
    await agent.put('/api/admin/jobtime').send({ ms: null });
    expect(scheduler.setJobTime.mock.calls).toEqual([[50], [null]]);
    const tracked = (boardIds: unknown) => agent.put('/api/admin/tracked').send({ boardIds });
    expect((await tracked(['a'])).status).toBe(409); // no Current Round
    state.primaryState!.startRound(roundInfo('r1'), 1000);
    expect((await tracked([1])).status).toBe(400);
    expect((await tracked(['b', 'zz'])).status).toBe(400); // not a Board of the Current Round
    expect((await tracked(['b'])).status).toBe(204);
    expect(scheduler.setTracked.mock.calls).toEqual([['t', ['b']]]);
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
    scheduler.timing = { jobs: 3, provisional: 1, ms: { p50: 800, p95: 900 }, depth: { p50: 20, p95: 22 } };
    expect((await agent.get('/api/admin/status')).body.timing).toEqual(scheduler.timing);
  });

  it('reports status (with follow), and clears the Event through the Site', async () => {
    const { agent, state, site, status } = setup();
    await login(agent);
    const idle = {
      event: null,
      round: null,
      stream: null,
      engine: defaultEngine,
      engineRunning: false,
      copies: { main: { state: 'up', restarts: 2 }, multi: { state: 'up', restarts: 1 } },
      timing: { jobs: 0, provisional: 0, ms: null, depth: null },
      jobTimeMs: DEFAULT_JOB_TIME_MS,
      topN: 8,
      running: null,
      queue: { current: [], backfill: 0, deferred: [] },
      dead: [],
      evictions: [],
      follow: { next: null, swapAt: null, polledAt: null, error: null },
    };
    expect((await agent.get('/api/admin/status')).body).toEqual(idle);
    state.addEvent({ tourId: 'z', name: 'Z', link: 'z' }, 2); // not the Primary: its status must not show
    state.removeEvent('z');
    state.addEvent({ tourId: 't', name: 'Event', link: 'ok' }, 2);
    state.addEvent({ tourId: 'u', name: 'U', link: 'u' }, 2);
    state.primaryState!.startRound(roundInfo('r1'), 1000);
    const { round, follow } = (await agent.get('/api/admin/status')).body;
    expect(follow).toEqual(status);
    expect(round.boards.map((b: { id: string; tracked: boolean }) => [b.id, b.tracked])).toEqual([
      ['a', true],
      ['b', true],
      ['c', false],
    ]);
    expect(round).toMatchObject({ tourId: 't', roundId: 'r1', name: 'Round 1' });
    expect((await agent.post('/api/admin/clear')).status).toBe(204);
    expect(site.remove).toHaveBeenCalledWith('t');
    expect([state.primary, state.events.map((e) => e.event.tourId)]).toEqual(['u', ['u']]);
  });
});
