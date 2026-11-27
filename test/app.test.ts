import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { SiteState } from '../src/site-state.js';
import type { DataStore } from '../src/store.js';
import { engineConfig } from '../shared/engine-config.js';

const store: DataStore = {
  load: async () => null,
  save: async () => {},
  loadRound: async () => null,
  saveRound: async () => {},
  listRounds: async () => [],
};
const app = createApp({
  store,
  state: new SiteState(store),
  scheduler: {
    engine: null,
    running: null,
    setPasses: vi.fn(),
    setTracked: vi.fn(),
    setEngine: vi.fn(),
  },
  site: {
    status: () => null,
    add: vi.fn(),
    remove: vi.fn(),
  },
  defaultEngine: engineConfig('berserk'),
});

describe('app', () => {
  it('GET /healthz returns 200 {ok:true}', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('mounts the Archive list', async () => {
    const res = await request(app).get('/api/archive');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
