import { describe, expect, it } from 'vitest';
import { SiteState } from '../src/site-state.js';
import type { RoundInfo } from '../src/lichess/api.js';
import type { DataStore } from '../src/store.js';
import { DEFAULT_JOB_TIME_MS } from '../shared/types.js';
import type * as T from '../shared/types.js';
import { engineConfig } from '../shared/engine-config.js';

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
const queue: T.QueueView = { current: [], backfill: 3, deferred: [] };

const persisted = (primary: string | null, ...ns: number[]): T.PersistedState => ({
  version: 3,
  settings: { engine: null, jobTimeMs: 5000 },
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

  it('defaults the job time on a fresh state only; a persisted null stays unset', () => {
    expect(setup().site.settings).toEqual({ engine: null, jobTimeMs: DEFAULT_JOB_TIME_MS });
    const state = { ...persisted(null), settings: { engine: null, jobTimeMs: null } };
    expect(setup(state).site.settings.jobTimeMs).toBeNull();
  });

  it('persists Idle as no Events; addEvent makes the first Event Primary and saves it', async () => {
    const { site, states, primaries } = setup();
    expect(site.primary).toBeNull();
    expect(site.primaryState).toBeNull();
    site.setJobTime(9000);
    site.setEngine(engineConfig('p'));
    await site.saved();
    expect(states.at(-1)).toEqual({
      version: 3,
      settings: { engine: engineConfig('p'), jobTimeMs: 9000 },
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
    expect(log).toMatchObject([['T1', { type: 'snapshot', snapshot: { event: null, round: null, search: null } }]]);
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
    site.setJobTime(1234);
    await site.saved();
    expect(states.at(-1)).toEqual({
      version: 3,
      settings: { engine: null, jobTimeMs: 1234 },
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
    expect(site.snapshot('nope')).toEqual({ event: null, round: null, search: null, queue, stream: null });
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
