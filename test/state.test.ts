import { describe, expect, it } from 'vitest';
import { State } from '../src/state.js';
import type { Store } from '../src/store.js';
import type { Eval, EvalKind, GameRef, LiveInfo, Move, Persisted, Result, SseEvent } from '../shared/types.js';

const ref: GameRef = {
  tourId: 'IjDgZVUR',
  roundId: 'L3MX2oE3',
  id: 'at7GqSzo',
  white: { name: 'W' },
  black: { name: 'B' },
};
const mv = (uci: string): Move => ({ uci, san: uci, clock: null });
const ev = (cp: number, kind: EvalKind = 'final'): Eval => ({ score: { cp }, depth: 12, kind, bestmove: null });
const live: LiveInfo = {
  ply: 0,
  engine: 'Fake',
  depth: 5,
  nps: 1000,
  lines: [{ score: { cp: 20 }, depth: 5, san: ['e4'] }],
};

function setup(init: Persisted | null = null) {
  const saved: Persisted[] = [];
  const store: Store = { load: async () => null, save: async (p) => void saved.push(structuredClone(p)) };
  const state = new State(store, init);
  const events: SseEvent[] = [];
  state.on('event', (e) => events.push(e));
  return { state, saved, events };
}

describe('State', () => {
  it('ignores game-only calls while idle', () => {
    const { state, saved, events } = setup();
    expect(state.snapshot()).toEqual({ site: 'idle', game: null, live: null, stream: null });
    expect(state.syncMoves([mv('e2e4')])).toBeNull();
    expect(state.setEval(0, ev(0), state.epoch)).toBe(false);
    state.finish('1-0');
    state.setLive(live);
    state.setStream('connected');
    expect(events).toEqual([]);
    expect(saved).toEqual([]);
  });

  it('pick emits a live snapshot and saves it', () => {
    const { state, saved, events } = setup();
    state.pick(ref);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'snapshot', snapshot: { site: 'live' } });
    expect(saved.at(-1)!.game).toMatchObject({ id: 'at7GqSzo', result: '*', plies: [{ move: null, eval: null }] });
    state.snapshot().game!.plies.length = 0; // snapshot is a copy
    expect(state.game!.plies).toHaveLength(1);
    const restored = (result: Result) =>
      setup({ version: 1, engine: null, game: { ...ref, result, plies: [{ move: null, eval: null }] } }).state.site;
    expect([restored('0-1'), restored('*')]).toEqual(['finished', 'live']);
  });

  it('appends emit ply events; evals upsert; the same list is a no-op', () => {
    const { state, saved, events } = setup();
    state.pick(ref);
    const before = events.length;
    expect(state.syncMoves([mv('e2e4'), mv('e7e5')])).toBe(0);
    expect(events.slice(before)).toMatchObject([
      { type: 'ply', index: 1, ply: { move: { uci: 'e2e4' } } },
      { type: 'ply', index: 2, ply: { move: { uci: 'e7e5' } } },
    ]);
    const ep = state.epoch;
    expect(state.setEval(0, ev(20, 'backfill'), ep)).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'ply', index: 0, ply: { move: null, eval: ev(20, 'backfill') } });
    expect(saved.at(-1)!.game!.plies[0].eval).toEqual(ev(20, 'backfill'));
    expect(state.setEval(3, ev(0), ep)).toBe(false);
    const count = events.length;
    const saves = saved.length;
    expect(state.syncMoves([mv('e2e4'), mv('e7e5')])).toBe(2);
    expect(events.length).toBe(count);
    expect(saved.length).toBe(saves);
  });

  it('a retract keeps the common prefix, emits a snapshot and stales old epochs', () => {
    const { state, events } = setup();
    state.pick(ref);
    state.syncMoves([mv('e2e4'), mv('e7e5')]);
    const ep = state.epoch;
    state.setEval(1, ev(30), ep);
    state.setEval(2, ev(25), ep);
    expect(state.syncMoves([mv('e2e4'), mv('c7c5')])).toBe(1);
    const g = state.snapshot().game!;
    expect(g.plies[1].eval).toEqual(ev(30));
    expect(g.plies[2]).toEqual({ move: mv('c7c5'), eval: null });
    expect(events.at(-1)!.type).toBe('snapshot');
    const n = events.length;
    expect(state.setEval(2, ev(99), ep)).toBe(false);
    expect(events.length).toBe(n);
    expect(state.setEval(2, ev(99), state.epoch)).toBe(true);
    expect(state.syncMoves([mv('e2e4')])).toBe(1);
    expect(state.game!.plies).toHaveLength(2);
    expect(events.at(-1)!.type).toBe('snapshot');
  });

  it('live info and stream status emit, do not save, and are dropped on finish', () => {
    const { state, saved, events } = setup();
    state.pick(ref);
    state.syncMoves([mv('e2e4'), mv('e7e5')]);
    const n = saved.length;
    state.setLive(live);
    state.setStream('connected');
    state.setStream('connected');
    expect(events.slice(-2)).toEqual([
      { type: 'info', live },
      { type: 'stream-status', status: 'connected' },
    ]);
    expect(state.snapshot()).toMatchObject({ live, stream: 'connected' });
    expect(saved.length).toBe(n);
    state.finish('1-0');
    expect(events.at(-1)!.type).toBe('snapshot');
    expect(state.snapshot()).toMatchObject({ site: 'finished', live: null, stream: null });
    const m = events.length;
    expect(state.syncMoves([mv('e2e4')])).toBeNull();
    state.finish('1-0');
    state.setLive(live);
    expect(events.length).toBe(m);
    expect(state.setEval(2, ev(40), state.epoch)).toBe(true);
  });

  it('clear goes idle, keeps the engine, and stales old epochs', () => {
    const { state, saved, events } = setup();
    state.setEngine({ path: '/x', options: { Hash: '1024' } });
    state.pick(ref);
    const old = state.epoch;
    state.clear();
    expect(state.site).toBe('idle');
    expect(events.at(-1)).toMatchObject({ type: 'snapshot', snapshot: { site: 'idle', game: null } });
    expect(saved.at(-1)).toEqual({ version: 1, engine: { path: '/x', options: { Hash: '1024' } }, game: null });
    state.pick(ref);
    expect(state.setEval(0, ev(0), old)).toBe(false);
  });
});
