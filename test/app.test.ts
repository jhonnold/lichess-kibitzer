import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { State } from '../src/state.js';

const app = createApp({
  state: new State({ load: async () => null, save: async () => {} }),
  kibitzer: { engine: null, pick: async () => {}, clear: async () => {} },
  defaultEngine: { path: 'berserk', options: {} },
});

describe('app', () => {
  it('GET /healthz returns 200 {ok:true}', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
