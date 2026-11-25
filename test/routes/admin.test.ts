import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { probeEngine } from '../../src/engine/engine.js';
import { LichessError, type EventInfo } from '../../src/lichess/api.js';
import { State } from '../../src/state.js';

const FAKE = fileURLToPath(new URL('../fixtures/fake-uci.mjs', import.meta.url));
const ref = { tourId: 't', roundId: 'r', id: 'g', white: { name: 'W' }, black: { name: 'B' } };
const event: EventInfo = { id: 't', name: 'Event', rounds: [] };

function setup(adminPassword = 'pw') {
  const state = new State({ load: async () => null, save: async () => {} });
  const kibitzer = { engine: null, pick: vi.fn(async () => state.pick(ref)), clear: vi.fn(async () => state.clear()) };
  const fetchEvent = vi.fn(async (link: string) => {
    if (link === 'busy') throw new LichessError(429, 'rate limited');
    if (link !== 'ok') throw new Error('Not a URL');
    return event;
  });
  const fetchRound = vi.fn(async (id: string) => ({ id, name: 'R1', tourId: 't', boards: [] }));
  const app = createApp({
    state,
    kibitzer,
    adminPassword,
    defaultEngine: { path: 'berserk', options: { Hash: '1024' } },
    probe: (path) => probeEngine(process.execPath, { args: [path] }), // fake-uci.mjs has no shebang
    lichess: { fetchEvent, fetchRound },
  });
  return { state, kibitzer, app, agent: request.agent(app) };
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
});

describe('admin routes', () => {
  it('looks up events and rounds, passing Lichess errors through', async () => {
    const { agent } = setup();
    await login(agent);
    expect((await agent.get('/api/admin/event').query({ link: 'ok' })).body).toEqual(event);
    expect((await agent.get('/api/admin/event').query({ link: 'busy' })).status).toBe(429);
    expect((await agent.get('/api/admin/event').query({ link: 'x' })).body).toEqual({ error: 'Not a URL' });
    expect((await agent.get('/api/admin/rounds/r1')).body).toMatchObject({ id: 'r1', boards: [] });
  });

  it('probes an engine; rejects a non-UCI one', async () => {
    const { agent } = setup();
    await login(agent);
    const res = await agent.post('/api/admin/engine/probe').send({ path: FAKE });
    expect(res.body.name).toBe('FakeEngine');
    expect(res.body.options.map((o: { name: string }) => o.name)).toContain('MultiPV');
    expect((await agent.post('/api/admin/engine/probe').send({ path: '/nonexistent' })).status).toBe(400);
  });

  it('answers malformed JSON with a 400 JSON error, no stack', async () => {
    const { agent } = setup();
    await login(agent);
    const res = await agent.put('/api/admin/config').set('Content-Type', 'application/json').send('{bad');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'bad request' });
    expect(res.text).not.toContain('at ');
  });

  it('saves config, picks, clears and reports status', async () => {
    const { agent, state, kibitzer } = setup();
    await login(agent);
    expect((await agent.get('/api/admin/status')).body).toEqual({
      site: 'idle',
      stream: null,
      engine: { path: 'berserk', options: { Hash: '1024' } },
      engineRunning: false,
      game: null,
    });
    expect((await agent.put('/api/admin/config').send({ path: '/e', options: { Hash: 1 } })).status).toBe(400);
    expect((await agent.put('/api/admin/config').send({ path: '/e', options: { MultiPV: '3' } })).status).toBe(204);
    expect(state.engine).toEqual({ path: '/e', options: { MultiPV: '3' } });
    expect((await agent.post('/api/admin/pick').send(ref)).status).toBe(204);
    expect(kibitzer.pick).toHaveBeenCalledWith(ref);
    expect((await agent.get('/api/admin/status')).body).toMatchObject({ site: 'live', game: { ...ref, result: '*' } });
    expect((await agent.post('/api/admin/clear')).status).toBe(204);
    expect([kibitzer.clear.mock.calls.length, state.site]).toEqual([1, 'idle']);
  });
});
