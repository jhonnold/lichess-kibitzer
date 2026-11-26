import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { RoundState } from '../../src/round-state.js';
import type { EngineState } from '../../src/scheduler.js';

function setup(...pw: [string | undefined] | []) {
  const adminPassword = pw.length ? pw[0] : 'pw';
  const state = new RoundState({
    load: async () => null,
    save: async () => {},
    loadRound: async () => null,
    saveRound: async () => {},
  });
  const scheduler = {
    engine: null,
    running: null,
    setJobTime: async () => {},
    setTracked: async () => {},
    setEngine: async () => {},
    requeueDead: async () => true,
    discardDead: async () => true,
    engineState: 'up' as EngineState,
    restarts: 2,
  };
  const follower = {
    status: { next: null, swapAt: null, polledAt: null, error: null },
    register: async () => {},
    clear: async () => {},
  };
  const app = createApp({ state, scheduler, follower, adminPassword, defaultEngine: { path: 'berserk', options: {} } });
  return { state, scheduler, app };
}
const basic = (s: string) => `Basic ${Buffer.from(s).toString('base64')}`;
const scrape = (app: ReturnType<typeof setup>['app'], auth?: string) => {
  const req = request(app).get('/api/admin/metrics');
  return auth ? req.set('Authorization', auth) : req;
};

describe('GET /api/admin/metrics', () => {
  it('refuses a missing, wrong or malformed Authorization', async () => {
    const { app } = setup();
    const none = await scrape(app);
    expect(none.status).toBe(401);
    expect(none.headers['www-authenticate']).toBe('Basic realm="kibitzer"');
    for (const auth of [basic('admin:nope'), basic('bob:pw'), basic('pw'), 'Basic !!!', 'Bearer pw'])
      expect([auth, (await scrape(app, auth)).status]).toEqual([auth, 401]);
  });

  it('refuses everything while no password is set', async () => {
    for (const pw of [undefined, '']) {
      const { app } = setup(pw);
      for (const auth of [basic('admin:'), basic('admin:pw')]) expect((await scrape(app, auth)).status).toBe(401);
    }
  });

  it('serves every metric to admin:<password> without the cookie', async () => {
    const res = await scrape(setup().app, basic('admin:pw'));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain; version=0\.0\.4/);
    expect(res.headers['cache-control']).toBe('no-store');
    for (const name of [
      'kibitzer_queue_depth{tier="current"}',
      'kibitzer_queue_depth{tier="backfill"}',
      'kibitzer_dead_letter_queue_size',
      'kibitzer_engine_up',
      'kibitzer_engine_restarts_total',
      'kibitzer_job_duration_seconds',
      'kibitzer_job_depth',
      'kibitzer_lichess_stream_reconnects_total',
      'kibitzer_lichess_rate_limited_total',
      'kibitzer_viewers',
      'kibitzer_process_cpu_user_seconds_total',
    ])
      expect(res.text).toContain(name);
  });

  it('accepts a password containing a colon', async () => {
    expect((await scrape(setup('a:b').app, basic('admin:a:b'))).status).toBe(200);
  });

  it('reports the Queue, Dead-letter queue and engine at scrape time', async () => {
    const { app, state, scheduler } = setup();
    state.setQueue({ current: [{ boardId: 'a', ply: 3 }], backfill: 4 });
    state.setDead([{ boardId: 'a', board: 1, ply: 2, at: 1 }]);
    const body = (await scrape(app, basic('admin:pw'))).text;
    expect(body).toContain('kibitzer_queue_depth{tier="current"} 1');
    expect(body).toContain('kibitzer_queue_depth{tier="backfill"} 4');
    expect(body).toContain('kibitzer_dead_letter_queue_size 1');
    expect(body).toContain('kibitzer_engine_up 1');
    expect(body).toContain('kibitzer_engine_restarts_total 2');
    scheduler.engineState = 'restarting';
    expect((await scrape(app, basic('admin:pw'))).text).toContain('kibitzer_engine_up 0');
  });
});
