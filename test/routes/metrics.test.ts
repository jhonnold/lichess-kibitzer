import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { httpDuration, httpRequests } from '../../src/metrics.js';
import { SiteState } from '../../src/site-state.js';
import type { EngineState } from '../../src/scheduler.js';
import type { EngineRole } from '../../shared/types.js';
import { val } from '../helpers/metric.js';
import { sse } from '../helpers/sse.js';

function setup(...pw: [string | undefined] | []) {
  const adminPassword = pw.length ? pw[0] : 'pw';
  const state = new SiteState({
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
    states: { main: 'up', multi: 'up' } as Record<EngineRole, EngineState>,
    copyState(role: EngineRole) {
      return this.states[role];
    },
    copyRestarts: (role: EngineRole) => (role === 'main' ? 2 : 5),
    timing: { jobs: 0, provisional: 0, ms: null, depth: null },
  };
  const followStatus = { next: null, swapAt: null, polledAt: null as number | null, error: null };
  const polled: Record<string, number | null> = {}; // tourId -> polledAt; unset: followStatus
  const site = {
    add: async () => ({ tourId: 'T', name: 'E', link: '' }),
    remove: async () => true,
    setPrimary: () => true,
    status: (t: string) => (t in polled ? { ...followStatus, polledAt: polled[t] } : followStatus),
  };
  const app = createApp({
    store: { listRounds: async () => [], loadRound: async () => null },
    state,
    scheduler,
    site,
    adminPassword,
    defaultEngine: { path: 'berserk', options: {} },
  });
  return { state, scheduler, followStatus, polled, app };
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
      'kibitzer_engine_up{role="main"}',
      'kibitzer_engine_restarts_total{role="multi"}',
      'kibitzer_job_duration_seconds',
      'kibitzer_job_depth',
      'kibitzer_lichess_stream_reconnects_total',
      'kibitzer_lichess_rate_limited_total',
      'kibitzer_viewers',
      'kibitzer_opening_lookups_total',
      'kibitzer_evictions_total',
      'kibitzer_build_info{rev="',
      'kibitzer_engine_state{role="main",state="up"}',
      'kibitzer_jobs_total',
      'kibitzer_job_nps',
      'kibitzer_lichess_requests_total',
      'kibitzer_lichess_request_duration_seconds',
      'kibitzer_lichess_stream_connected',
      'kibitzer_http_requests_total',
      'kibitzer_http_request_duration_seconds',
      'kibitzer_following',
      'kibitzer_follower_polls_total',
      'kibitzer_follower_last_success_timestamp_seconds',
      'kibitzer_store_writes_total',
      'kibitzer_store_last_save_timestamp_seconds',
      'kibitzer_archive_reads_total',
      'kibitzer_process_cpu_user_seconds_total',
    ])
      expect(res.text).toContain(name);
  });

  it('accepts a password containing a colon', async () => {
    expect((await scrape(setup('a:b').app, basic('admin:a:b'))).status).toBe(200);
  });

  it('reports the Queue, Dead-letter queue and engine at scrape time', async () => {
    const { app, state, scheduler } = setup();
    state.setQueue({ current: [{ boardId: 'a', ply: 3 }], backfill: 4, deferred: [] });
    state.addEvent({ tourId: 'T', name: 'E', link: 'x' }, 2).setDead([{ boardId: 'a', board: 1, ply: 2, at: 1 }]);
    const body = (await scrape(app, basic('admin:pw'))).text;
    expect(body).toContain('kibitzer_queue_depth{tier="current"} 1');
    expect(body).toContain('kibitzer_queue_depth{tier="backfill"} 4');
    expect(body).toContain('kibitzer_dead_letter_queue_size 1');
    state.addEvent({ tourId: 'U', name: 'U', link: 'y' }, 2).setDead([
      { boardId: 'b', board: 1, ply: 2, at: 1 },
      { boardId: 'c', board: 2, ply: 2, at: 1 },
    ]);
    expect((await scrape(app, basic('admin:pw'))).text).toContain('kibitzer_dead_letter_queue_size 3'); // the sum
    expect(body).toContain('kibitzer_engine_up{role="main"} 1');
    expect(body).toContain('kibitzer_engine_restarts_total{role="main"} 2');
    expect(body).toContain('kibitzer_engine_restarts_total{role="multi"} 5');
    expect(body).toContain('kibitzer_engine_state{role="main",state="up"} 1');
    scheduler.states.multi = 'restarting';
    const text = (await scrape(app, basic('admin:pw'))).text;
    expect(text).toContain('kibitzer_engine_up{role="multi"} 0');
    expect(text).toContain('kibitzer_engine_up{role="main"} 1');
    for (const [engineState, on] of [
      ['restarting', 'restarting'],
      [null, 'idle'],
    ] as const) {
      scheduler.states.main = engineState;
      const text = (await scrape(app, basic('admin:pw'))).text;
      for (const st of ['up', 'restarting', 'idle'])
        expect(text).toContain(`kibitzer_engine_state{role="main",state="${st}"} ${st === on ? 1 : 0}`);
    }
  });

  it('counts the registered Events and labels the last successful poll by Event', async () => {
    const { app, state, polled } = setup();
    let body = (await scrape(app, basic('admin:pw'))).text;
    expect(body).toContain('kibitzer_following 0');
    expect(body).not.toContain('kibitzer_follower_last_success_timestamp_seconds{'); // no Event, no sample
    state.addEvent({ tourId: 'T', name: 'E', link: 'https://lichess.org/broadcast/x/T' }, 2);
    state.addEvent({ tourId: 'U', name: 'U', link: 'https://lichess.org/broadcast/x/U' }, 2);
    body = (await scrape(app, basic('admin:pw'))).text;
    expect(body).toContain('kibitzer_following 2');
    expect(body).not.toContain('kibitzer_follower_last_success_timestamp_seconds{'); // none fetched yet
    polled.T = 1_700_000_000_000;
    polled.U = 1_700_000_100_000;
    body = (await scrape(app, basic('admin:pw'))).text;
    expect(body).toContain('kibitzer_follower_last_success_timestamp_seconds{event="T"} 1700000000');
    expect(body).toContain('kibitzer_follower_last_success_timestamp_seconds{event="U"} 1700000100');
    state.removeEvent('T');
    body = (await scrape(app, basic('admin:pw'))).text;
    expect(body).toContain('kibitzer_following 1');
    expect(body).not.toContain('last_success_timestamp_seconds{event="T"}');
  });

  it('reports the build and the configured engine, which follows the saved config', async () => {
    const { app, state } = setup();
    expect((await scrape(app, basic('admin:pw'))).text).toMatch(
      /^kibitzer_build_info\{rev="[^"]+",engine="berserk"\} 1$/m,
    );
    state.setEngine({ path: '/usr/local/bin/stockfish', options: {} });
    expect((await scrape(app, basic('admin:pw'))).text).toMatch(
      /^kibitzer_build_info\{rev="[^"]+",engine="stockfish"\} 1$/m,
    );
  });
});

describe('HTTP metrics', () => {
  const reqs = (route: string, method: string, status: string) => val(httpRequests, { route, method, status });
  const timed = (route: string, method: string, status: string) =>
    val(httpDuration, { route, method, status }, 'kibitzer_http_request_duration_seconds_count');

  it('labels requests by route pattern, never by raw path', async () => {
    const { app } = setup();
    const cases: [string, string, string, string][] = [
      ['/healthz', '/healthz', 'GET', '200'],
      ['/api/archive/abcdefgh/ijklmnop', '/api/archive/:tourId/:roundId', 'GET', '404'],
      ['/api/admin/metrics', '/api/admin/metrics', 'GET', '401'],
      ['/api/admin/status', '/api/admin/*', 'GET', '401'], // the cookie check answers before any route
      ['/no/such/path', '<unmatched>', 'GET', '404'],
    ];
    for (const [path, ...labels] of cases) {
      const [n, t] = [await reqs(...labels), await timed(...labels)];
      await request(app).get(path);
      expect([path, await reqs(...labels), await timed(...labels)]).toEqual([path, n + 1, t + 1]);
    }
  });

  it('counts an SSE stream when it closes, without a duration sample', async () => {
    const server = setup().app.listen(0);
    await once(server, 'listening');
    try {
      const labels = ['/api/events', 'GET', '200'] as const;
      const [n, t] = [await reqs(...labels), await timed(...labels)];
      const c = await sse(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/events`);
      await vi.waitFor(() => expect(c.events.length).toBeGreaterThan(0));
      expect(await reqs(...labels)).toBe(n);
      await c.close();
      await vi.waitFor(async () => expect(await reqs(...labels)).toBe(n + 1));
      expect(await timed(...labels)).toBe(t);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
