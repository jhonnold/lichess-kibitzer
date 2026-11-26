import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { probeEngine, type Engine } from '../../src/engine/engine.js';
import type { FollowStatus } from '../../src/follower.js';
import { LichessError, type EventInfo, type RoundInfo } from '../../src/lichess/api.js';
import { RoundState } from '../../src/round-state.js';
import type { EngineState } from '../../src/scheduler.js';

const FAKE = fileURLToPath(new URL('../fixtures/fake-uci.mjs', import.meta.url));
const event: EventInfo = {
  id: 't',
  name: 'Event',
  rounds: [{ id: 'r1', name: 'Round 1', ongoing: true, finished: false, startsAt: 1000 }],
};
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
const defaultEngine = { path: 'berserk', options: { Hash: '1024' } };

function setup(adminPassword = 'pw') {
  const state = new RoundState({
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
    engineState: 'up' as EngineState,
    restarts: 2,
  };
  const status: FollowStatus = { next: null, swapAt: null, polledAt: null, error: null };
  const follower = {
    status,
    register: vi.fn(async (link: string) => {
      if (link === 'busy') throw new LichessError(429, 'rate limited');
      if (link !== 'ok') throw new Error('Not a URL');
      state.setEvent({ tourId: 't', name: 'Event', link });
    }),
    clear: vi.fn(async () => state.setEvent(null)),
  };
  const fetchEvent = vi.fn(async (link: string) => {
    if (link === 'busy') throw new LichessError(429, 'rate limited');
    if (link !== 'ok') throw new Error('Not a URL');
    return event;
  });
  const app = createApp({
    state,
    scheduler,
    follower,
    adminPassword,
    defaultEngine,
    probe: (path) => probeEngine(process.execPath, { args: [path] }), // fake-uci.mjs has no shebang
    lichess: { fetchEvent },
  });
  return { state, scheduler, follower, status, app, agent: request.agent(app) };
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
    const { app, state, scheduler, follower } = setup();
    const calls: ['get' | 'post' | 'put', string, object?][] = [
      ['get', '/event?link=ok'],
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
    for (const fn of [...Object.values(scheduler), follower.register, follower.clear])
      if (vi.isMockFunction(fn)) expect(fn).not.toHaveBeenCalled();
    expect([state.settings.topN, state.settings.event, state.round]).toEqual([8, null, null]);
  });
});

describe('admin routes', () => {
  it('previews events, passing Lichess errors through', async () => {
    const { agent } = setup();
    await login(agent);
    expect((await agent.get('/api/admin/event').query({ link: 'ok' })).body).toEqual(event);
    expect((await agent.get('/api/admin/event').query({ link: 'busy' })).status).toBe(429);
    expect((await agent.get('/api/admin/event').query({ link: 'x' })).body).toEqual({ error: 'Not a URL' });
  });

  it('probes an engine; rejects a non-UCI one', async () => {
    const { agent } = setup();
    await login(agent);
    const res = await agent.post('/api/admin/engine/probe').send({ path: FAKE });
    expect(res.body.name).toBe('FakeEngine');
    expect(res.body.options.map((o: { name: string }) => o.name)).toContain('MultiPV');
    expect((await agent.post('/api/admin/engine/probe').send({ path: '/nonexistent' })).status).toBe(400);
  });

  it('sends a button option to the running engine only', async () => {
    const { agent, scheduler } = setup();
    await login(agent);
    expect((await agent.post('/api/admin/engine/button').send({ name: 'Clear Hash' })).status).toBe(409);
    const setOption = vi.fn();
    scheduler.engine = { setOption } as unknown as Engine;
    expect((await agent.post('/api/admin/engine/button').send({ name: 'Clear Hash\ngo' })).status).toBe(400);
    expect((await agent.post('/api/admin/engine/button').send({ name: 'Clear Hash' })).status).toBe(204);
    expect(setOption.mock.calls).toEqual([['Clear Hash']]);
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
    expect((await put({ path: '/e', options: { Hash: 1 } })).status).toBe(400);
    expect((await put({ path: '/e', options: { 'Hash\nquit': '1' } })).status).toBe(400);
    expect((await put({ path: '/e', options: { Hash: '1\nquit' } })).status).toBe(400);
    expect(scheduler.setEngine).not.toHaveBeenCalled();
    expect((await put({ path: '/e', options: { MultiPV: '3' } })).status).toBe(204);
    expect(scheduler.setEngine.mock.calls).toEqual([[{ path: '/e', options: { MultiPV: '3' } }]]);
    scheduler.setEngine.mockRejectedValueOnce(new Error('spawn failed'));
    expect(await put({ path: '/e', options: {} })).toMatchObject({ status: 400, body: { error: 'spawn failed' } });
  });

  it('registers an Event through the Follower: validates, passes Lichess errors through', async () => {
    const { agent, state, follower } = setup();
    await login(agent);
    const post = (body: object) => agent.post('/api/admin/event').send(body);
    expect((await post({})).status).toBe(400);
    expect((await post({ link: 1 })).status).toBe(400);
    expect(follower.register).not.toHaveBeenCalled();
    expect(await post({ link: 'busy' })).toMatchObject({ status: 429, body: { error: 'rate limited' } });
    expect(await post({ link: 'nope' })).toMatchObject({ status: 400, body: { error: 'Not a URL' } });
    expect((await post({ link: 'ok' })).status).toBe(204);
    expect(follower.register.mock.calls.at(-1)).toEqual(['ok']);
    expect(state.settings.event).toEqual({ tourId: 't', name: 'Event', link: 'ok' });
  });

  it('validates N, job time and the tracked set', async () => {
    const { agent, state, scheduler } = setup();
    await login(agent);
    for (const n of [0, 2.5, '3', 65]) expect((await agent.put('/api/admin/topn').send({ n })).status).toBe(400);
    expect((await agent.put('/api/admin/topn').send({ n: 3 })).status).toBe(204);
    expect(state.settings.topN).toBe(3);
    for (const ms of [-1, 0, 'x', undefined, 1e300]) {
      expect((await agent.put('/api/admin/jobtime').send({ ms })).status).toBe(400);
    }
    await agent.put('/api/admin/jobtime').send({ ms: 50 });
    await agent.put('/api/admin/jobtime').send({ ms: null });
    expect(scheduler.setJobTime.mock.calls).toEqual([[50], [null]]);
    const tracked = (boardIds: unknown) => agent.put('/api/admin/tracked').send({ boardIds });
    expect((await tracked(['a'])).status).toBe(409); // no Current Round
    state.startRound(roundInfo('r1'), 1000);
    expect((await tracked([1])).status).toBe(400);
    expect((await tracked(['b', 'zz'])).status).toBe(400); // not a Board of the Current Round
    expect((await tracked(['b'])).status).toBe(204);
    expect(scheduler.setTracked.mock.calls).toEqual([[['b']]]);
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

  it('reports status (with follow), and clears the Event through the Follower', async () => {
    const { agent, state, follower, status } = setup();
    await login(agent);
    const idle = {
      event: null,
      round: null,
      stream: null,
      engine: defaultEngine,
      engineRunning: false,
      engineState: 'up',
      restarts: 2,
      jobTimeMs: null,
      topN: 8,
      running: null,
      queue: { current: [], backfill: 0 },
      dead: [],
      follow: status,
    };
    expect((await agent.get('/api/admin/status')).body).toEqual(idle);
    await agent.put('/api/admin/topn').send({ n: 2 });
    state.startRound(roundInfo('r1'), 1000);
    const { round } = (await agent.get('/api/admin/status')).body;
    expect(round.boards.map((b: { id: string; tracked: boolean }) => [b.id, b.tracked])).toEqual([
      ['a', true],
      ['b', true],
      ['c', false],
    ]);
    expect(round).toMatchObject({ tourId: 't', roundId: 'r1', name: 'Round 1' });
    expect((await agent.post('/api/admin/clear')).status).toBe(204);
    expect(follower.clear).toHaveBeenCalledTimes(1);
    expect([state.settings.event, state.round]).toEqual([null, null]);
  });
});
