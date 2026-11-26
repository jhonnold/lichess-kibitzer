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
};
const app = createApp({
  state: new RoundState(store),
  scheduler: {
    engine: null,
    running: null,
    startRound: vi.fn(),
    setJobTime: vi.fn(),
    setTracked: vi.fn(),
    setEngine: vi.fn(),
    stop: vi.fn(),
  },
  defaultEngine: { path: 'berserk', options: {} },
});

describe('app', () => {
  it('GET /healthz returns 200 {ok:true}', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
