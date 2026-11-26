import { describe, expect, it } from 'vitest';
import { RoundState } from '../src/round-state.js';
import type { RoundInfo } from '../src/lichess/api.js';
import type { DataStore } from '../src/store.js';
import type * as T from '../shared/types-v2.js';

const mv = (uci: string): T.Move => ({ uci, san: uci, clock: null });
const ev = (cp: number, kind: T.EvalKind = 'complete'): T.Eval => ({
  score: { cp },
  depth: 12,
  kind,
  bestmove: null,
  lines: [],
});
const info = (n = 10, result: T.Result = '*'): RoundInfo => ({
  id: 'R1',
  name: 'Round 1',
  tourId: 'T1',
  boards: Array.from({ length: n }, (_, i) => ({
    id: `g${i + 1}`,
    name: `b${i + 1}`,
    white: { name: `W${i + 1}` },
    black: { name: `B${i + 1}` },
    whiteClockMs: 1000 * (i + 1),
    result,
  })),
});
const event: T.RegisteredEvent = { tourId: 'T1', name: 'Event', link: 'https://lichess.org/broadcast/x/T1' };
const settings: T.Settings = { event, engine: null, jobTimeMs: 5000, topN: 8 };

function setup(init?: { state: T.PersistedState | null; round: T.Round | null }) {
  const states: T.PersistedState[] = [];
  const rounds: T.Round[] = [];
  const store: DataStore = {
    load: async () => init?.state ?? null,
    save: async (s) => void states.push(structuredClone(s)),
    loadRound: async () => init?.round ?? null,
    saveRound: async (r) => void rounds.push(structuredClone(r)),
  };
  const rs = new RoundState(store, init);
  const events: T.SseEvent[] = [];
  rs.on('event', (e) => events.push(e));
  return { rs, store, states, rounds, events };
}
const started = (n = 10) => {
  const s = setup();
  s.rs.startRound(info(n), 1234);
  s.events.length = 0;
  return s;
};

describe('RoundState', () => {
  it('starts with defaults and an empty snapshot', () => {
    const { rs } = setup();
    expect(rs.settings).toEqual({ event: null, engine: null, jobTimeMs: null, topN: 8 });
    expect(rs.dead).toEqual([]);
    expect(rs.snapshot()).toEqual({
      event: null,
      round: null,
      search: null,
      queue: { current: [], backfill: 0 },
      stream: null,
    });
  });

  it('startRound builds fresh Boards, tracks the first topN and resets the rest', async () => {
    const { rs, events, states, rounds } = setup({
      state: { version: 2, settings, current: null, dead: [] },
      round: null,
    });
    rs.setDead([{ boardId: 'x', board: 1, ply: 1, at: 1 }]);
    rs.setSearch({ boardId: 'g1', ply: 0, engine: 'E', depth: 1, nps: null, lines: [], startedAt: 1 });
    rs.setQueue({ current: [{ boardId: 'g1', ply: 0 }], backfill: 2 });
    rs.setStream('connected');
    events.length = 0;
    rs.startRound(info(), 1234);
    expect(rs.round?.boards.map((b) => [b.board, b.tracked])).toEqual(
      Array.from({ length: 10 }, (_, i) => [i + 1, i < 8]),
    );
    expect(rs.round).toMatchObject({ tourId: 'T1', roundId: 'R1', eventName: 'Event', startsAt: 1234 });
    expect(rs.board('g1')).toMatchObject({ opening: null, clocks: { white: 1000, black: null } });
    expect(rs.board('g1')?.plies).toEqual([{ move: null, at: null, eval: null }]);
    expect(rs.dead).toEqual([]);
    expect(events.map((e) => e.type)).toEqual(['snapshot']);
    const snap = rs.snapshot();
    expect(snap.round?.boards).toHaveLength(8);
    expect([snap.search, snap.stream, snap.queue]).toEqual([null, null, { current: [], backfill: 0 }]);
    await rs.saved();
    expect(rounds.at(-1)?.boards).toHaveLength(10);
    expect(states.at(-1)).toMatchObject({ current: { tourId: 'T1', roundId: 'R1' }, dead: [] });
    rs.setTopN(3);
    rs.startRound(info(), null);
    expect(rs.snapshot().round?.boards).toHaveLength(3);
  });

  it('setTracked emits board/untrack and keeps untracked data in round', () => {
    const { rs, events } = started();
    rs.syncMoves('g1', [mv('e2e4')], 1);
    rs.setEval('g1', 1, ev(10), rs.epoch('g1'));
    events.length = 0;
    rs.setTracked([...Array.from({ length: 8 }, (_, i) => `g${i + 2}`), 'g9', 'nope']);
    expect(events.map((e) => e.type)).toEqual(['untrack', 'board']);
    expect(events[0]).toEqual({ type: 'untrack', boardId: 'g1' });
    expect(rs.board('g1')?.tracked).toBe(false);
    expect(rs.board('g1')?.plies[1].eval).toEqual(ev(10));
    expect(rs.snapshot().round?.boards.map((b) => b.id)).not.toContain('g1');
  });

  it('syncMoves: first sync at null, later at now, no-op on same list, silent when untracked', () => {
    const { rs, events } = started();
    expect(rs.syncMoves('g1', [mv('e2e4')], 100)).toBe(0);
    expect(rs.syncMoves('g1', [mv('e2e4'), mv('e7e5')], 200)).toBe(1);
    expect(rs.board('g1')?.plies.map((p) => p.at)).toEqual([null, null, 200]);
    expect(events.map((e) => e.type)).toEqual(['ply', 'ply']);
    expect(events[1]).toMatchObject({ boardId: 'g1', index: 2 });
    events.length = 0;
    expect(rs.syncMoves('g1', [mv('e2e4'), mv('e7e5')], 300)).toBe(2);
    rs.syncMoves('g10', [mv('d2d4')], 300);
    expect(events).toEqual([]);
    expect(rs.board('g10')?.plies).toHaveLength(2);
  });

  it('retract keeps the common prefix, bumps the epoch and emits board', () => {
    const { rs, events } = started();
    rs.syncMoves('g1', [mv('e2e4'), mv('e7e5'), mv('g1f3')], 1);
    const old = rs.epoch('g1');
    expect(rs.setEval('g1', 1, ev(5), old)).toBe(true);
    events.length = 0;
    expect(rs.syncMoves('g1', [mv('e2e4'), mv('c7c5')], 2)).toBe(1);
    expect(rs.epoch('g1')).toBeGreaterThan(old);
    expect(rs.setEval('g1', 1, ev(9), old)).toBe(false);
    expect(rs.board('g1')?.plies).toHaveLength(3);
    expect(rs.board('g1')?.plies[1].eval).toEqual(ev(5));
    expect(events.map((e) => e.type)).toEqual(['board']);
  });

  it('startRound again with the same Board ids invalidates old epochs and resets sync state', () => {
    const { rs } = started();
    rs.syncMoves('g1', [mv('e2e4')], 1);
    const old = rs.epoch('g1');
    rs.startRound(info(), null);
    expect(rs.epoch('g1')).toBeGreaterThan(old);
    expect(rs.setEval('g1', 0, ev(1), old)).toBe(false);
    expect(rs.board('g1')?.plies).toEqual([{ move: null, at: null, eval: null }]);
    rs.syncMoves('g1', [mv('e2e4')], 5);
    expect(rs.board('g1')?.plies[1].at).toBeNull();
  });

  it('an untracked Board records evals, results and retracts silently but still saves', () => {
    const { rs, events, rounds } = started();
    rs.syncMoves('g1', [mv('e2e4'), mv('e7e5')], 1);
    rs.setTracked(Array.from({ length: 7 }, (_, i) => `g${i + 2}`));
    events.length = 0;
    const saves = rounds.length;
    expect(rs.setEval('g1', 1, ev(7), rs.epoch('g1'))).toBe(true);
    rs.setResult('g1', '1-0');
    const old = rs.epoch('g1');
    rs.syncMoves('g1', [mv('d2d4')], 2);
    expect(events).toEqual([]);
    expect(rs.epoch('g1')).toBeGreaterThan(old);
    expect(rs.board('g1')).toMatchObject({ result: '1-0', plies: [{}, { move: { uci: 'd2d4' } }] });
    rs.syncMoves('g1', [mv('e2e4')], 3);
    expect(rs.setEval('g1', 1, ev(3), rs.epoch('g1'))).toBe(true);
    expect(rs.round?.boards[0].plies[1].eval).toEqual(ev(3));
    expect(rounds.length).toBe(saves + 5);
  });

  it('no-op calls neither emit nor save', () => {
    const { rs, events, rounds } = started();
    rs.syncMoves('g1', [mv('e2e4')], 1);
    events.length = 0;
    const saves = rounds.length;
    rs.syncMoves('g1', [mv('e2e4')], 2);
    rs.setResult('g1', '*');
    rs.setTracked(Array.from({ length: 8 }, (_, i) => `g${i + 1}`));
    expect(events).toEqual([]);
    expect(rounds.length).toBe(saves);
  });

  it('setEval: complete replaces provisional, never the reverse; bad targets are false', () => {
    const { rs, events } = started();
    rs.syncMoves('g1', [mv('e2e4')], 1);
    const ep = rs.epoch('g1');
    expect(rs.setEval('g1', 1, ev(1, 'provisional'), ep)).toBe(true);
    expect(rs.setEval('g1', 1, ev(2, 'complete'), ep)).toBe(true);
    expect(rs.setEval('g1', 1, ev(3, 'provisional'), ep)).toBe(false);
    expect(rs.board('g1')?.plies[1].eval?.score).toEqual({ cp: 2 });
    expect(rs.setEval('g1', 2, ev(0), ep)).toBe(false);
    expect(rs.setEval('nope', 0, ev(0), ep)).toBe(false);
    expect(rs.epoch('nope')).toBe(-1);
    expect(events.filter((e) => e.type === 'ply')).toHaveLength(3); // 2 evals + the append
  });

  it('setResult emits once per change; a Board Finished at startRound still records moves', () => {
    const s = setup();
    s.rs.startRound(info(2, '1-0'), null);
    s.events.length = 0;
    s.rs.setResult('g1', '1-0');
    expect(s.events).toEqual([]);
    expect(s.rs.syncMoves('g1', [mv('e2e4')], 1)).toBe(0);
    s.rs.setResult('g1', '0-1');
    s.rs.setResult('g1', '0-1');
    s.rs.setResult('nope', '*');
    expect(s.events.map((e) => e.type)).toEqual(['ply', 'result']);
    expect(s.rs.board('g1')?.plies).toHaveLength(2);
  });

  it('an Upcoming Board gets at = now for its first move after an empty first sync; unknown Board is null', () => {
    const { rs } = started();
    expect(rs.syncMoves('g1', [], 50)).toBe(0);
    rs.syncMoves('g1', [mv('e2e4')], 60);
    expect(rs.board('g1')?.plies[1].at).toBe(60);
    expect(rs.syncMoves('nope', [], 1)).toBeNull();
  });

  it('transient setters emit; setStream dedups', () => {
    const { rs, events } = started();
    const search: T.SearchInfo = { boardId: 'g1', ply: 0, engine: 'E', depth: 1, nps: null, lines: [], startedAt: 1 };
    rs.setSearch(search);
    rs.setQueue({ current: [], backfill: 3 });
    rs.setStream('connected');
    rs.setStream('connected');
    expect(events.map((e) => e.type)).toEqual(['search', 'queue', 'stream-status']);
    expect(rs.snapshot()).toMatchObject({ search, queue: { backfill: 3 }, stream: 'connected' });
  });

  it('settings mutators persist silently; setEvent drops the Round and transient state', async () => {
    const { rs, events, states } = started();
    rs.setEngine({ path: 'p', options: {} });
    rs.setJobTime(7000);
    rs.setTopN(2);
    expect(events).toEqual([]);
    rs.setStream('connected');
    events.length = 0;
    await rs.saved();
    expect(states.at(-1)?.settings).toMatchObject({ engine: { path: 'p' }, jobTimeMs: 7000, topN: 2 });
    expect(rs.snapshot().round?.boards).toHaveLength(8);
    rs.setEvent(event);
    expect(events.map((e) => e.type)).toEqual(['snapshot']);
    expect(rs.round).toBeNull();
    expect(rs.snapshot()).toMatchObject({ event, round: null, stream: null });
    await rs.saved();
    expect(states.at(-1)).toMatchObject({ current: null, dead: [], settings: { event } });
  });

  it('load restores the tracked set; the first sync after a restore has at null', async () => {
    const a = started();
    a.rs.setTracked(['g10']);
    await a.rs.saved();
    const state = a.states.at(-1)!;
    const round = a.rounds.at(-1)!;
    const rs = await RoundState.load({
      load: async () => state,
      loadRound: async () => round,
      save: async () => {},
      saveRound: async () => {},
    });
    expect(rs.snapshot().round?.boards.map((b) => b.id)).toEqual(['g10']);
    expect(rs.epoch('g1')).toBeGreaterThan(0);
    rs.syncMoves('g10', [mv('e2e4')], 99);
    expect(rs.board('g10')?.plies[1].at).toBeNull();
  });
});
