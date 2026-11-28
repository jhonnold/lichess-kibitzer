import { describe, expect, it } from 'vitest';
import { SiteState } from '../src/site-state.js';
import type { RoundInfo } from '../src/lichess/api.js';
import type { DataStore } from '../src/store.js';
import { DEFAULT_PASSES_MS } from '../shared/types.js';
import type * as T from '../shared/types.js';
import { engineConfig } from '../shared/engine-config.js';

/** A single Pass of `ms` (null: unset, the Queue idles). */
const one = (ms: number | null): T.PassesMs | null => (ms === null ? null : [ms, null, null]);

const ev = (n: number): T.RegisteredEvent => ({
  tourId: `T${n}`,
  name: `Event ${n}`,
  link: `https://lichess.org/broadcast/x/T${n}`,
});
const info = (tourId = 'T1', n = 3): RoundInfo => ({
  id: 'R1',
  name: 'Round 1',
  tourId,
  boards: Array.from({ length: n }, (_, i) => ({
    id: `g${i + 1}`,
    name: `b${i + 1}`,
    white: { name: `W${i + 1}` },
    black: { name: `B${i + 1}` },
    whiteClockMs: null,
    result: '*' as const,
  })),
});
const search: T.SearchInfo = {
  boardId: 'g1',
  ply: 0,
  engine: 'E',
  depth: 1,
  nps: null,
  lines: [],
  multi: null,
  startedAt: 1,
  tier: 'current',
};
const queue: T.QueueView = { current: [], backfill: 3, deferred: [], deep: [] };

const persisted = (primary: string | null, ...ns: number[]): T.PersistedState => ({
  version: 5,
  deep: [],
  settings: { engine: null, passesMs: [5000, null, null] },
  primary,
  events: ns.map((n) => ({
    event: ev(n),
    topN: 4,
    current: n === 1 ? { tourId: 'T1', roundId: 'R1' } : null,
    dead: [],
  })),
});

function setup(state: T.PersistedState | null = null, rounds?: Map<string, T.Round>) {
  const states: T.PersistedState[] = [];
  const saved: T.Round[] = [];
  const store: DataStore = {
    load: async () => state,
    save: async (s) => void states.push(structuredClone(s)),
    loadRound: async (t) => rounds?.get(t) ?? null,
    saveRound: async (r) => void saved.push(structuredClone(r)),
    listRounds: async () => [],
  };
  const site = new SiteState(store, { state, rounds });
  const log: [string | null, T.SseEvent][] = [];
  const primaries: (string | null)[] = [];
  site.on('event', (t, e) => log.push([t, e]));
  site.on('primary', (p) => primaries.push(p));
  return { site, store, states, saved, log, primaries };
}

describe('SiteState', () => {
  it('load restores every Event, its Current Round and the Primary; a primary not among the Events falls back to the first', async () => {
    const round = (tourId: string): T.Round => ({
      tourId,
      roundId: 'R1',
      name: 'Round 1',
      eventName: 'x',
      startsAt: null,
      boards: [],
    });
    const state = {
      ...persisted('T2', 1, 2),
      events: persisted('T2', 1, 2).events.map((e) => ({ ...e, current: { tourId: e.event.tourId, roundId: 'R1' } })),
    };
    const store = (s: T.PersistedState): DataStore => ({
      load: async () => s,
      loadRound: async (t) => round(t),
      save: async () => {},
      saveRound: async () => {},
      listRounds: async () => [],
    });
    const site = await SiteState.load(store(state));
    expect(site.events.map((r) => r.event.tourId)).toEqual(['T1', 'T2']);
    expect(site.events.map((r) => r.round?.tourId)).toEqual(['T1', 'T2']);
    expect(site.primary).toBe('T2');
    expect(site.primaryState).toBe(site.event('T2'));
    expect(site.currents).toEqual([
      { tourId: 'T1', roundId: 'R1' },
      { tourId: 'T2', roundId: 'R1' },
    ]);
    expect((await SiteState.load(store({ ...state, primary: 'gone' }))).primary).toBe('T1');
  });

  it('defaults the Passes on a fresh state only; a persisted null stays unset', () => {
    expect(setup().site.settings).toEqual({ engine: null, passesMs: DEFAULT_PASSES_MS });
    const state = { ...persisted(null), settings: { engine: null, passesMs: null } };
    expect(setup(state).site.settings.passesMs).toBeNull();
  });

  it('persists Idle as no Events; addEvent makes the first Event Primary and saves it', async () => {
    const { site, states, primaries } = setup();
    expect(site.primary).toBeNull();
    expect(site.primaryState).toBeNull();
    site.setPasses(one(9000));
    site.setEngine(engineConfig('p'));
    await site.saved();
    expect(states.at(-1)).toEqual({
      version: 5,
      deep: [],
      settings: { engine: engineConfig('p'), passesMs: [9000, null, null] },
      primary: null,
      events: [],
    });
    site.addEvent(ev(1), 5);
    await site.saved();
    expect(primaries).toEqual(['T1']);
    expect(states.at(-1)).toMatchObject({
      primary: 'T1',
      events: [{ event: ev(1), topN: 5, current: null, dead: [] }],
    });
    site.addEvent(ev(2), 5);
    expect(site.primary).toBe('T1');
    expect(primaries).toEqual(['T1']);
  });

  it('re-adding a registered tourId returns the same RoundState unchanged', () => {
    const { site, log } = setup();
    const rs = site.addEvent(ev(1), 5);
    log.length = 0;
    expect(site.addEvent({ ...ev(1), name: 'Renamed' }, 2)).toBe(rs);
    expect(rs.event.name).toBe('Event 1');
    expect(rs.topN).toBe(5);
    expect(log).toEqual([]);
  });

  it('removeEvent: emits an empty snapshot tagged with that tourId, hands the Primary to the oldest remaining (else null), saves', async () => {
    const { site, log, primaries, states } = setup();
    site.addEvent(ev(1), 5);
    site.addEvent(ev(2), 5);
    site.addEvent(ev(3), 5);
    log.length = 0;
    expect(site.removeEvent('nope')).toBe(false);
    expect(site.removeEvent('T1')).toBe(true);
    expect(log).toMatchObject([
      ['T1', { type: 'snapshot', snapshot: { event: null, round: null, search: null } }],
      [null, { type: 'events' }],
    ]);
    expect(site.primary).toBe('T2');
    expect(primaries.at(-1)).toBe('T2');
    await site.saved();
    expect(states.at(-1)).toMatchObject({ primary: 'T2', events: [{ event: ev(2) }, { event: ev(3) }] });
    site.removeEvent('T3'); // not the Primary
    expect(primaries).toEqual(['T1', 'T2']);
    site.removeEvent('T2');
    expect(site.primary).toBeNull();
    expect(primaries.at(-1)).toBeNull();
    await site.saved();
    expect(states.at(-1)).toMatchObject({ primary: null, events: [] });
  });

  it('changes to two Events in one tick: the last write holds both entries in registration order with site settings and primary', async () => {
    const { site, states } = setup();
    const a = site.addEvent(ev(1), 5);
    const b = site.addEvent(ev(2), 6);
    a.setTopN(7);
    b.startRound(info('T2'), null);
    site.setPasses(one(1234));
    await site.saved();
    expect(states.at(-1)).toEqual({
      version: 5,
      deep: [],
      settings: { engine: null, passesMs: [1234, null, null] },
      primary: 'T1',
      events: [
        { event: ev(1), topN: 7, current: null, dead: [] },
        { event: ev(2), topN: 6, current: { tourId: 'T2', roundId: 'R1' }, dead: [] },
      ],
    });
  });

  it('epochs are unique across Events and after a remove + re-add', () => {
    const { site } = setup();
    const a = site.addEvent(ev(1), 5);
    const b = site.addEvent(ev(2), 5);
    a.startRound(info('T1'), null);
    b.startRound(info('T2'), null);
    const seen = [a, b].flatMap((rs) => ['g1', 'g2', 'g3'].map((g) => rs.epoch(g)));
    site.removeEvent('T1');
    const a2 = site.addEvent(ev(1), 5);
    a2.startRound(info('T1'), null);
    seen.push(...['g1', 'g2', 'g3'].map((g) => a2.epoch(g)));
    expect(new Set(seen).size).toBe(9);
  });

  it("snapshot(tourId) carries search only while the running Job is that Event's; queue is global; unknown → empty snapshot", () => {
    const { site } = setup();
    site.addEvent(ev(1), 5);
    site.addEvent(ev(2), 5);
    site.setQueue(queue);
    site.setSearch(search, 'T2');
    expect(site.search).toEqual(search);
    expect(site.snapshot('T2')).toMatchObject({ event: ev(2), search, queue });
    expect(site.snapshot('T1')).toMatchObject({ event: ev(1), search: null, queue });
    expect(site.snapshot()).toMatchObject({ event: ev(1), search: null }); // the Primary
    expect(site.snapshot('nope')).toEqual({
      events: site.summaries(),
      event: null,
      round: null,
      search: null,
      queue,
      stream: null,
    });
    expect(site.snapshot(null).event).toBeNull();
    site.setSearch(null, null);
    expect(site.snapshot('T2').search).toBeNull();
  });

  it('tags RoundState events with their tourId; search/queue are site-wide; a removed RoundState emits and saves nothing', async () => {
    const { site, log, states } = setup();
    const a = site.addEvent(ev(1), 5);
    const b = site.addEvent(ev(2), 5);
    log.length = 0;
    a.startRound(info('T1'), null);
    b.setStream('connected');
    site.setQueue(queue);
    site.setSearch(search, 'T2');
    site.setSearch(null, 'T2');
    expect(log.map(([t, e]) => [t, e.type])).toEqual([
      ['T1', 'snapshot'],
      [null, 'events'],
      ['T2', 'stream-status'],
      [null, 'queue'],
      ['T2', 'search'],
      [null, 'search'],
    ]);
    site.removeEvent('T2');
    await site.saved();
    log.length = 0;
    const writes = states.length;
    b.setStream(null);
    b.setTopN(3);
    b.setDead([]);
    await site.saved();
    expect(log).toEqual([]);
    expect(states.length).toBe(writes);
  });

  it("summaries: primary flag, Current Round name and startsAt, live after a Tracked Board's first move, tracked count", () => {
    const { site } = setup();
    const a = site.addEvent(ev(1), 2);
    site.addEvent(ev(2), 5);
    expect(site.summaries()).toEqual([
      { tourId: 'T1', name: 'Event 1', primary: true, round: null, live: false, tracked: 0 },
      { tourId: 'T2', name: 'Event 2', primary: false, round: null, live: false, tracked: 0 },
    ]);
    a.startRound(info('T1', 4), 99);
    expect(site.summaries()[0]).toEqual({
      tourId: 'T1',
      name: 'Event 1',
      primary: true,
      round: { roundId: 'R1', name: 'Round 1', startsAt: 99 },
      live: false,
      tracked: 2,
    });
    a.syncMoves('g4', [{ uci: 'e2e4', san: 'e4', clock: null }], 1); // untracked: not live
    expect(site.summaries()[0].live).toBe(false);
    a.syncMoves('g1', [{ uci: 'e2e4', san: 'e4', clock: null }], 1);
    expect(site.summaries()[0].live).toBe(true);
    a.setResult('g1', '1-0'); // every Board with moves is over
    expect(site.summaries()[0].live).toBe(false);
    site.setPrimary('T2');
    expect(site.summaries().map((s) => s.primary)).toEqual([false, true]);
  });

  it("emits 'events' on add/remove/primary/startRound/setTracked/first move, never twice for the same summaries", () => {
    const { site, log } = setup();
    const count = () => log.filter(([, e]) => e.type === 'events').length;
    const a = site.addEvent(ev(1), 2);
    expect(count()).toBe(1);
    site.addEvent(ev(2), 2);
    expect(count()).toBe(2);
    expect(log.at(-1)).toEqual([null, { type: 'events', events: site.summaries() }]);
    site.setPrimary('T2');
    expect(count()).toBe(3);
    site.setPrimary('T2'); // unchanged
    a.startRound(info('T1', 4), null);
    expect(count()).toBe(4);
    a.setTracked(['g1', 'g2', 'g3']);
    expect(count()).toBe(5);
    a.setTracked(['g1', 'g2', 'g3']); // unchanged
    const m = [{ uci: 'e2e4', san: 'e4', clock: null }];
    a.syncMoves('g1', m, 1);
    expect(count()).toBe(6);
    a.syncMoves('g1', [...m, { uci: 'e7e5', san: 'e5', clock: null }], 2); // still live: same summaries
    a.setStream('connected'); // not a summary event
    a.setResult('g1', '1-0'); // the last live Board ended: no longer live
    expect(count()).toBe(7);
    site.removeEvent('T1');
    expect(count()).toBe(8);
  });

  it("summaries carry the Follower's Schedule once pushed; a repeat push publishes nothing", () => {
    const { site, log } = setup();
    const a = site.addEvent(ev(1), 2);
    expect(site.summaries()[0]).not.toHaveProperty('next'); // not polled yet: neither Next nor Finished
    const count = () => log.filter(([, e]) => e.type === 'events').length;
    const before = count();
    a.setSchedule({ next: { name: 'Round 3', startsAt: 500 }, finished: false });
    expect(site.summaries()[0]).toMatchObject({
      round: null,
      next: { name: 'Round 3', startsAt: 500 },
      finished: false,
    });
    expect(count()).toBe(before + 1);
    a.setSchedule({ next: { name: 'Round 3', startsAt: 500 }, finished: false });
    expect(count()).toBe(before + 1);
    a.setSchedule({ next: null, finished: true });
    expect(site.summaries()[0]).toMatchObject({ next: null, finished: true });
    expect(count()).toBe(before + 2);
  });

  it("setTracked publishes one 'events' frame with the final summary", () => {
    const { site, log } = setup();
    const a = site.addEvent(ev(1), 2);
    a.startRound(info('T1', 4), null);
    a.syncMoves('g3', [{ uci: 'e2e4', san: 'e4', clock: null }], 1);
    log.length = 0;
    a.setTracked(['g3', 'g4']); // {g1,g2} -> {g3,g4}
    const frames = log.filter(([, e]) => e.type === 'events');
    expect(frames).toEqual([[null, { type: 'events', events: site.summaries() }]]);
    expect(site.summaries()[0]).toMatchObject({ tracked: 2, live: true });
  });

  it("setPrimary: unknown → false; emits 'primary' and saves", async () => {
    const { site, primaries, states } = setup();
    site.addEvent(ev(1), 5);
    site.addEvent(ev(2), 5);
    expect(site.setPrimary('nope')).toBe(false);
    expect(site.setPrimary('T1')).toBe(true); // already the Primary
    expect(primaries).toEqual(['T1']);
    expect(site.setPrimary('T2')).toBe(true);
    expect(primaries).toEqual(['T1', 'T2']);
    await site.saved();
    expect(states.at(-1)?.primary).toBe('T2');
  });

  it("saved() waits for a removed Event's pending Round write", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const done: string[] = [];
    const store: DataStore = {
      load: async () => null,
      save: async () => {},
      loadRound: async () => null,
      saveRound: async (r) => {
        await gate;
        done.push(r.tourId);
      },
      listRounds: async () => [],
    };
    const site = new SiteState(store);
    site.addEvent(ev(1), 5).startRound(info('T1'), null);
    site.removeEvent('T1');
    let resolved = false;
    const saved = site.saved().then(() => (resolved = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBe(false);
    release();
    await saved;
    expect(done).toEqual(['T1']);
  });
});
