import { describe, expect, it } from 'vitest';
import { SiteState } from '../src/site-state.js';
import type { RoundInfo } from '../src/lichess/api.js';
import type { DataStore } from '../src/store.js';
import type * as T from '../shared/types.js';

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

const persisted = (site: Partial<T.SiteSettings>, entry: Partial<T.PersistedEvent> = {}): T.PersistedState => ({
  version: 5,
  deep: [],
  settings: { engine: null, passesMs: [5000, null, null], ...site },
  primary: event.tourId,
  events: [{ event, topN: 8, current: null, dead: [], ...entry }],
});

function setup(init?: { state: T.PersistedState | null; round: T.Round | null }) {
  const states: T.PersistedState[] = [];
  const rounds: T.Round[] = [];
  const store: DataStore = {
    load: async () => init?.state ?? null,
    save: async (s) => void states.push(structuredClone(s)),
    loadRound: async () => init?.round ?? null,
    saveRound: async (r) => void rounds.push(structuredClone(r)),
    listRounds: async () => [],
  };
  const site = new SiteState(store, {
    state: init?.state ?? null,
    rounds: new Map(init?.round ? [['T1', init.round]] : []),
  });
  const rs = site.event('T1') ?? site.addEvent(event, 8);
  const events: T.SseEvent[] = [];
  site.on('event', (_t, e) => e.type !== 'events' && events.push(e)); // the summaries are tested in site-state
  return { site, rs, store, states, rounds, events };
}
const started = (n = 10) => {
  const s = setup();
  s.rs.startRound(info(n), 1234);
  s.events.length = 0;
  return s;
};

describe('RoundState', () => {
  it('starts with its topN and an empty Round', () => {
    const { rs } = setup();
    expect(rs.topN).toBe(8);
    expect(rs.dead).toEqual([]);
    expect(rs.snapshot()).toEqual({
      events: [expect.objectContaining({ tourId: 'T1', primary: true, round: null, live: false, tracked: 0 })],
      event,
      round: null,
      search: null,
      queue: { current: [], backfill: 0, deferred: [], deep: [] },
      stream: null,
    });
  });

  it('startRound builds fresh Boards, tracks the first topN and resets the rest', async () => {
    const { site, rs, events, states, rounds } = setup({
      state: persisted({}),
      round: null,
    });
    rs.setDead([{ boardId: 'x', board: 1, ply: 1, at: 1 }]);
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
    expect(snap.round?.boards.map((b) => b.tracked)).toEqual(Array.from({ length: 10 }, (_, i) => i < 8)); // every Board
    expect(snap.stream).toBeNull();
    await site.saved();
    expect(rounds.at(-1)?.boards).toHaveLength(10);
    expect(states.at(-1)?.events[0]).toMatchObject({ current: { tourId: 'T1', roundId: 'R1' }, dead: [] });
    rs.setTopN(3);
    rs.startRound(info(), null);
    expect(rs.snapshot().round?.boards.filter((b) => b.tracked)).toHaveLength(3);
  });

  it('setTracked emits board (the new flag) both ways and keeps untracked data in round and snapshot', () => {
    const { rs, events } = started();
    rs.syncMoves('g1', [mv('e2e4')], 1);
    rs.setEval('g1', 1, ev(10), rs.epoch('g1'));
    events.length = 0;
    rs.setTracked([...Array.from({ length: 8 }, (_, i) => `g${i + 2}`), 'g9', 'nope']);
    expect(events).toMatchObject([
      { type: 'board', board: { id: 'g1', tracked: false, plies: [{}, { eval: ev(10) }] } },
      { type: 'board', board: { id: 'g9', tracked: true } },
    ]);
    expect(rs.board('g1')?.tracked).toBe(false);
    expect(rs.board('g1')?.plies[1].eval).toEqual(ev(10));
    expect(rs.snapshot().round?.boards.find((b) => b.id === 'g1')).toMatchObject({ tracked: false });
  });

  it('addBoards appends the missing Boards untracked, with a board event each', () => {
    const { rs, events } = started(2);
    rs.addBoards(info(4).boards);
    expect(events).toMatchObject([
      { type: 'board', board: { id: 'g3', board: 3, tracked: false } },
      { type: 'board', board: { id: 'g4', board: 4, tracked: false } },
    ]);
    expect(rs.snapshot().round?.boards.map((b) => b.id)).toEqual(['g1', 'g2', 'g3', 'g4']);
  });

  it('setOpening sets, saves and emits, untracked too; null, same or unknown is a no-op', async () => {
    const { rs, events, rounds } = started();
    events.length = 0;
    rs.setOpening('g1', 'E06 Catalan');
    expect(rs.board('g1')?.opening).toBe('E06 Catalan');
    expect(events).toMatchObject([{ type: 'board', board: { id: 'g1', opening: 'E06 Catalan' } }]);
    rs.setOpening('g1', 'E06 Catalan');
    rs.setOpening('g1', null);
    rs.setOpening('nope', 'X');
    expect(events).toHaveLength(1);
    expect(rs.board('g1')?.opening).toBe('E06 Catalan');
    rs.setOpening('g10', 'A00 Untracked');
    expect(events).toMatchObject([
      {},
      { type: 'board', board: { id: 'g10', tracked: false, opening: 'A00 Untracked' } },
    ]);
    await rs.saved();
    expect(rounds.at(-1)?.boards.map((b) => b.opening)).toEqual([
      'E06 Catalan',
      ...Array(8).fill(null),
      'A00 Untracked',
    ]);
  });

  it('syncMoves: first sync at null, later at now, no-op on same list, emits when untracked too', () => {
    const { rs, events } = started();
    expect(rs.syncMoves('g1', [mv('e2e4')], 100)).toBe(0);
    expect(rs.syncMoves('g1', [mv('e2e4'), mv('e7e5')], 200)).toBe(1);
    expect(rs.board('g1')?.plies.map((p) => p.at)).toEqual([null, null, 200]);
    expect(events.map((e) => e.type)).toEqual(['ply', 'ply']);
    expect(events[1]).toMatchObject({ boardId: 'g1', index: 2 });
    events.length = 0;
    expect(rs.syncMoves('g1', [mv('e2e4'), mv('e7e5')], 300)).toBe(2);
    expect(events).toEqual([]);
    rs.syncMoves('g10', [mv('d2d4')], 300);
    expect(events).toMatchObject([{ type: 'ply', boardId: 'g10', index: 1 }]);
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

  it('an untracked Board records and emits evals, results and retracts, and saves', () => {
    const { rs, events, rounds } = started();
    rs.syncMoves('g1', [mv('e2e4'), mv('e7e5')], 1);
    rs.setTracked(Array.from({ length: 7 }, (_, i) => `g${i + 2}`));
    events.length = 0;
    const saves = rounds.length;
    expect(rs.setEval('g1', 1, ev(7), rs.epoch('g1'))).toBe(true);
    rs.setResult('g1', '1-0');
    const old = rs.epoch('g1');
    rs.syncMoves('g1', [mv('d2d4')], 2);
    expect(events).toMatchObject([
      { type: 'ply', boardId: 'g1', index: 1, ply: { eval: ev(7) } },
      { type: 'result', boardId: 'g1', result: '1-0' },
      { type: 'board', board: { id: 'g1', tracked: false } },
    ]);
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

  it('setStream emits and dedups; startRound resets it', () => {
    const { rs, events } = started();
    rs.setStream('connected');
    rs.setStream('connected');
    expect(events.map((e) => e.type)).toEqual(['stream-status']);
    expect(rs.snapshot()).toMatchObject({ stream: 'connected' });
    rs.startRound(info(), null);
    expect(rs.stream).toBeNull();
  });

  it('setTopN and setDead save the Event entry silently', async () => {
    const { site, rs, events, states } = started();
    rs.setTopN(2);
    rs.setDead([{ boardId: 'g1', board: 1, ply: 0, at: 1 }]);
    expect(events).toEqual([]);
    await site.saved();
    expect(states.at(-1)?.events[0]).toMatchObject({ topN: 2, dead: [{ boardId: 'g1' }] });
    expect(rs.persisted()).toMatchObject({ event, topN: 2, current: { tourId: 'T1', roundId: 'R1' } });
  });

  it('load restores the tracked set; the first sync after a restore has at null', async () => {
    const a = started();
    a.rs.setTracked(['g10']);
    await a.site.saved();
    const state = a.states.at(-1)!;
    const round = a.rounds.at(-1)!;
    const site = await SiteState.load({
      load: async () => state,
      loadRound: async () => round,
      save: async () => {},
      saveRound: async () => {},
      listRounds: async () => [],
    });
    const rs = site.event('T1')!;
    expect(
      rs
        .snapshot()
        .round?.boards.filter((b) => b.tracked)
        .map((b) => b.id),
    ).toEqual(['g10']);
    expect(rs.epoch('g1')).toBeGreaterThan(0);
    rs.syncMoves('g10', [mv('e2e4')], 99);
    expect(rs.board('g10')?.plies[1].at).toBeNull();
  });

  it('openRound makes a loaded Round current again: evals and tracked kept, new epochs, no Round-file save', async () => {
    const a = started(3);
    a.rs.setEval('g1', 0, ev(10), a.rs.epoch('g1'));
    a.rs.setTracked(['g3']);
    const file = structuredClone(a.rs.round!) as T.Round;
    const b = setup();
    b.rs.setTopN(2);
    b.rs.startRound(info(2), null); // some other Round is current
    const old = b.rs.epoch('g1');
    b.rs.setDead([{ boardId: 'g1', board: 1, ply: 0, at: 1 }]);
    b.events.length = 0;
    b.rounds.length = 0;
    b.rs.openRound(file);
    expect(b.rs.round!.boards.map((x) => x.tracked)).toEqual([false, false, true]);
    expect(b.rs.board('g1')!.plies[0].eval).toMatchObject({ score: { cp: 10 } });
    expect(b.rs.epoch('g1')).toBeGreaterThan(old);
    expect(b.rs.setEval('g1', 0, ev(20), old)).toBe(false);
    expect(b.rs.dead).toEqual([]);
    expect(b.events.map((e) => e.type)).toEqual(['snapshot']);
    expect(b.rounds).toEqual([]);
    await b.site.saved();
    expect(b.states.at(-1)!.events[0].current).toEqual({ tourId: 'T1', roundId: 'R1' });
  });

  it('setStartsAt emits a snapshot and saves once; an equal value or no Round is silent', () => {
    const s = started(2);
    s.rounds.length = 0;
    s.rs.setStartsAt(1234);
    expect(s.events).toEqual([]);
    expect(s.rounds).toEqual([]);
    s.rs.setStartsAt(5678);
    expect(s.events.map((e) => e.type)).toEqual(['snapshot']);
    expect(s.rs.round!.startsAt).toBe(5678);
    expect(s.rounds).toHaveLength(1);
    expect(s.rounds[0].startsAt).toBe(5678);
    setup().rs.setStartsAt(1); // no Round: no-op
  });
});
