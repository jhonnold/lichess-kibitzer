import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { RoundState } from '../src/round-state.js';
import type { DataStore } from '../src/store.js';

const store: DataStore = {
  load: async () => null,
  save: async () => {},
  loadRound: async () => null,
  saveRound: async () => {},
  listRounds: async () => [],
};
const app = createApp({
  store,
  state: new RoundState(store),
  scheduler: {
    engine: null,
    running: null,
    setJobTime: vi.fn(),
    setTracked: vi.fn(),
    setEngine: vi.fn(),
  },
  follower: {
    status: { next: null, swapAt: null, polledAt: null, error: null },
    register: vi.fn(),
    clear: vi.fn(),
  },
  defaultEngine: { path: 'berserk', options: {} },
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
