import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as T from '../shared/types.js';
import { Engine } from '../src/engine/engine.js';
import type { RoundInfo } from '../src/lichess/api.js';
import type { GameUpdate } from '../src/lichess/stream.js';
import type { RoundState } from '../src/round-state.js';
import { SiteState } from '../src/site-state.js';
import { dataStore, type DataStore } from '../src/store.js';
import { DEEP_PASS } from '../shared/passes.js';
import { MAX_CRASHES, MIN_LIVE_SLICE_MS, type Job } from '../shared/queue.js';
import { RESTART_MIN_MS, Scheduler } from '../src/scheduler.js';
import { val } from './helpers/metric.js';
import { ReplaySource } from './helpers/replay-source.js';
import { evictions, jobDepth, jobDuration, jobNps, jobs } from '../src/metrics.js';
import { engineConfig } from '../shared/engine-config.js';

/** kibitzer_jobs_total for `outcome`, summed over both tiers. */
const outcomes = async (outcome: string, pass = '0') =>
  (await val(jobs, { tier: 'current', pass, outcome })) + (await val(jobs, { tier: 'backfill', pass, outcome }));

/** A single Pass of `ms` (null: unset, the Queue idles). */
const one = (ms: number | null): T.PassesMs | null => (ms === null ? null : [ms, null, null]);

const FAKE = fileURLToPath(new URL('./fixtures/fake-uci.mjs', import.meta.url));
const E4 = ['e2e4', 'e7e5', 'g1f3'];
const D4 = ['d2d4', 'd7d5', 'c2c4'];
const FOOLS = ['f2f3', 'e7e5', 'g2g4', 'd8h4'];

const EVENT_T1: T.RegisteredEvent = { tourId: 'T1', name: 'E', link: 'https://lichess.org/broadcast/x/T1' };
const EVENT_T2: T.RegisteredEvent = { tourId: 'T2', name: 'E2', link: 'https://lichess.org/broadcast/y/T2' };
const persisted = (dead: T.DeadJob[]): T.PersistedState => ({
  version: 5,
  deep: [],
  settings: { engine: null, passesMs: null },
  primary: 'T1',
  events: [{ event: EVENT_T1, topN: 1, current: null, dead }],
});
const roundInfo = (id: string, boards: string[], tourId = 'T1'): RoundInfo => ({
  id,
  name: id,
  tourId,
  boards: boards.map((b) => ({ id: b, name: b, white: { name: `W${b}` }, black: { name: `B${b}` }, result: '*' })),
});
const upd = (gameId: string, uci: string[], result: T.Result = '*'): GameUpdate => ({
  gameId,
  white: { name: 'W' },
  black: { name: 'B' },
  uci,
  san: uci,
  clocks: uci.map(() => null),
  opening: null,
  result,
  status: result === '*' ? 'ongoing' : 'finished',
});

let dir: string, logFile: string, multiLog: string, t: number;
let site: SiteState,
  state: RoundState,
  sched: Scheduler,
  state2: RoundState, // setup2: Event T2
  src: ReplaySource,
  srcOf: Record<string, ReplaySource>, // by roundId
  sources: ReplaySource[],
  sourceIds: string[];
let engineArgs: string[]; // read per launch
let delays: number[]; // restart delays asked of `after`
let fire: (() => void)[]; // manual mode: timers waiting to be fired by hand
let slices: { ms: number; fn: () => void }[]; // live slice timers, fired by hand

function setup(
  opts: {
    jobTimeMs?: number | null; // a single Pass
    passesMs?: T.PassesMs | null; // overrides jobTimeMs
    topN?: number;
    engineArgs?: string[];
    manual?: boolean; // restart timers wait in `fire` instead of running at once
    launch?: (real: () => Promise<Engine>) => Promise<Engine>; // the main copy
    multiArgs?: string[]; // the multi copy: its own log (multiLog), --offset 5 so its scores differ from main's
    launchMulti?: (real: () => Promise<Engine>) => Promise<Engine>;
    init?: { state: T.PersistedState | null; rounds?: ReadonlyMap<string, T.Round> };
    fetchOpening?: (uci: readonly string[]) => Promise<string | null>;
    store?: DataStore; // default: one that saves nothing and has no Round files
  } = {},
) {
  site = new SiteState(
    opts.store ?? {
      load: async () => null,
      save: async () => {},
      loadRound: async () => null,
      saveRound: async () => {},
      listRounds: async () => [],
    },
    opts.init,
  );
  state = site.event('T1') ?? site.addEvent(EVENT_T1, opts.topN ?? 3);
  site.setPasses(opts.passesMs !== undefined ? opts.passesMs : one(opts.jobTimeMs === undefined ? 15 : opts.jobTimeMs));
  engineArgs = opts.engineArgs ?? [];
  const real = () => Engine.start(process.execPath, { args: [FAKE, '--log', logFile, '--ply-score', ...engineArgs] });
  const multiArgs = ['--log', multiLog, '--ply-score', '--offset', '5', ...(opts.multiArgs ?? [])];
  const realMulti = () => Engine.start(process.execPath, { args: [FAKE, ...multiArgs] });
  sched = new Scheduler(site, {
    defaultEngine: engineConfig('fake', {}, 3),
    launch: (_cfg, role) =>
      role === 'main'
        ? opts.launch
          ? opts.launch(real)
          : real()
        : opts.launchMulti
          ? opts.launchMulti(realMulti)
          : realMulti(),
    after: (ms, fn) => {
      delays.push(ms);
      if (opts.manual) return (fire.push(fn), () => {});
      const h = setTimeout(fn, 0);
      return () => clearTimeout(h);
    },
    afterSlice: (ms, fn) => (slices.push({ ms, fn }), () => {}),
    source: (id) => (sourceIds.push(id), sources.push((src = srcOf[id] = new ReplaySource([]))), src),
    now: () => t,
    fetchOpening: opts.fetchOpening,
  });
}
/** setup() plus a second Event: T1 (Round R1, Boards a*) and T2 (Round S1, Boards b*), each with topN. */
function setup2(opts: Parameters<typeof setup>[0] & {} = {}) {
  setup(opts);
  state2 = site.addEvent(EVENT_T2, opts.topN ?? 3);
}
const startBoth = async () => {
  await sched.startRound('T1', roundInfo('R1', ['a1', 'a2']), null);
  await sched.startRound('T2', roundInfo('S1', ['b1', 'b2'], 'T2'), null);
};
/** The main copy's UCI log (multi: the multi copy's). */
const readLog = (file = logFile) => readFileSync(file, 'utf8').trim().split('\n');
const positions = () => readLog().filter((l) => l.startsWith('position '));
const count = (cmd: string) => readLog().filter((l) => l === cmd || l.startsWith(cmd + ' ')).length;
const evalOf = (id: string, ply: number) => state.board(id)!.plies[ply].eval;
const complete = (id: string, ply: number) => evalOf(id, ply)?.kind === 'complete';
const queueView = () => site.snapshot().queue;
const searching = (id: string, ply: number, tourId = 'T1') => {
  const s = site.snapshot(tourId).search;
  return s?.boardId === id && s.ply === ply;
};

/** Resolves once pred holds: checked now, then on every state event. */
function until(pred: () => boolean, ms = 2000): Promise<void> {
  if (pred()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (!pred()) return;
      clearTimeout(timer);
      site.off('event', check);
      resolve();
    };
    const timer = setTimeout(() => {
      site.off('event', check);
      reject(new Error('until: timeout'));
    }, ms);
    site.on('event', check);
  });
}
/** For conditions no state event announces (engine up again). */
async function poll(pred: () => boolean, ms = 2000): Promise<void> {
  for (const end = Date.now() + ms; !pred(); await new Promise((r) => setTimeout(r, 5))) {
    if (Date.now() > end) throw new Error('poll: timeout');
  }
}
const idle = () =>
  until(() => sched.running === null && queueView().current.length === 0 && queueView().backfill === 0);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scheduler-'));
  logFile = join(dir, 'uci.log');
  multiLog = join(dir, 'multi.log');
  sources = [];
  srcOf = {};
  sourceIds = [];
  t = 1000;
  delays = [];
  fire = [];
  slices = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  await sched.stop();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('Scheduler', () => {
  it('searches latest plies before backfill', async () => {
    setup({ jobTimeMs: null });
    await sched.startRound('T1', roundInfo('R1', ['g1', 'g2', 'g3']), null);
    src.push(upd('g1', E4));
    src.push(upd('g2', D4.slice(0, 2)));
    await sched.setPasses(one(15));
    await idle();
    expect(positions().slice(0, 2)).toEqual([
      `position startpos moves ${E4.join(' ')}`,
      'position startpos moves d2d4 d7d5',
    ]);
    expect(complete('g1', 0) && complete('g1', 1) && complete('g2', 0) && complete('g2', 1)).toBe(true);
  });

  it('observes job duration, depth and nps for each recorded Eval', async () => {
    const count = async (m: typeof jobDuration | typeof jobDepth | typeof jobNps, role?: string) => {
      const of = (tier: string) =>
        val(m, { tier, pass: '0', kind: 'complete', ...(role && { role }) }, `${m.name}_count`);
      return (await of('current')) + (await of('backfill'));
    };
    const [d0, p0, n0, r0, mp0, mn0] = [
      await count(jobDuration),
      await count(jobDepth, 'main'),
      await count(jobNps, 'main'),
      await outcomes('recorded'),
      await count(jobDepth, 'multi'),
      await count(jobNps, 'multi'),
    ];
    setup();
    await sched.startRound('T1', roundInfo('R1', ['g1']), null);
    src.push(upd('g1', E4));
    await idle();
    const done = [0, 1, 2, 3].filter((p) => complete('g1', p)).length;
    expect(done).toBeGreaterThanOrEqual(1);
    expect((await count(jobDuration)) - d0).toBeGreaterThanOrEqual(done);
    expect((await count(jobDepth, 'main')) - p0).toBeGreaterThanOrEqual(done);
    expect((await count(jobNps, 'main')) - n0).toBeGreaterThanOrEqual(done); // the fake engine sends nps
    expect((await count(jobDepth, 'multi')) - mp0).toBeGreaterThanOrEqual(done);
    expect((await count(jobNps, 'multi')) - mn0).toBeGreaterThanOrEqual(done);
    expect((await outcomes('recorded')) - r0).toBeGreaterThanOrEqual((await count(jobDuration)) - d0); // + Provisional
  });

  it('keeps Job timing over Complete Jobs', async () => {
    setup();
    await sched.startRound('T1', roundInfo('R1', ['g1']), null);
    src.push(upd('g1', E4));
    await idle();
    const done = [0, 1, 2, 3].filter((p) => complete('g1', p)).length;
    const { jobs, ms, depth } = sched.timing[0];
    expect(jobs).toBeGreaterThanOrEqual(done);
    expect(ms!.p50).toBeGreaterThanOrEqual(0);
    expect(depth!.p50).toBeGreaterThan(0);
  });

  it('runs the longest-waiting Board first', async () => {
    setup();
    await sched.startRound('T1', roundInfo('R1', ['g1', 'g2']), null);
    await idle();
    await sched.setPasses(one(null));
    t = 100;
    src.push(upd('g2', D4));
    t = 200;
    src.push(upd('g1', E4));
    const before = positions().length;
    await sched.setPasses(one(15));
    await idle();
    expect(positions()[before]).toBe(`position startpos moves ${D4.join(' ')}`);
    expect(positions()[before + 1]).toBe(`position startpos moves ${E4.join(' ')}`);
  });

  it('pre-empts a backfill Job for a new current one', async () => {
    setup({ topN: 1 });
    await sched.startRound('T1', roundInfo('R1', ['g1']), null);
    src.push(upd('g1', E4.slice(0, 2)));
    await until(() => searching('g1', 2));
    await sched.setPasses(one(5000)); // applies to the next Job: the ply 1 backfill
    await until(() => searching('g1', 1));
    await sched.setPasses(one(15));
    src.push(upd('g1', E4));
    await until(() => evalOf('g1', 1)?.kind === 'provisional');
    await until(() => complete('g1', 1));
    expect(readLog()).toContain('stop');
    expect(complete('g1', 3)).toBe(true);
  });

  it('evicts a live Job at once when its Board moves, and searches the old position again in full', async () => {
    setup({ topN: 1, passesMs: [5000, null, null] });
    await sched.startRound('T1', roundInfo('R1', ['g1']), null);
    src.push(upd('g1', E4.slice(0, 1)));
    await until(() => searching('g1', 1));
    const stale0 = await val(evictions, { reason: 'stale' });
    src.push(upd('g1', E4.slice(0, 2)));
    await until(() => searching('g1', 2));
    expect(evalOf('g1', 1)?.kind).toBe('provisional');
    expect((await val(evictions, { reason: 'stale' })) - stale0).toBe(1);
    await sched.setPasses(one(15));
    await sched.engine!.stop(); // cut short the ply 2 search, started at 5000 ms
    await until(() => complete('g1', 1) && complete('g1', 2));
  });

  it('lets a live Job run its slice, then evicts it for another live position', async () => {
    const live0 = await val(evictions, { reason: 'live' });
    setup({ topN: 2, passesMs: [5000, null, null] });
    await sched.startRound('T1', roundInfo('R1', ['g1', 'g2']), null);
    await until(() => searching('g1', 0));
    expect(slices.at(-1)?.ms).toBe(MIN_LIVE_SLICE_MS);
    t += MIN_LIVE_SLICE_MS - 1;
    slices.at(-1)!.fn(); // g2's live position waits, but the slice is not up yet
    expect(searching('g1', 0)).toBe(true);
    t += 1;
    slices.at(-1)!.fn();
    await until(() => searching('g2', 0));
    expect(evalOf('g1', 0)?.kind).toBe('provisional');
    expect(queueView().current).toEqual([]);
    expect(queueView().backfill).toBe(1); // g1's latest ply, waiting for a full search
    expect(queueView().deferred).toEqual([{ boardId: 'g1', ply: 0 }]);
    expect(sched.evictions).toMatchObject([{ boardId: 'g1', board: 1, ply: 0, reason: 'live', depth: 3 }]);
    expect(site.snapshot().search?.tier).toBe('current');
    expect((await val(evictions, { reason: 'live' })) - live0).toBe(1);
    await sched.setPasses(one(15));
    await sched.engine!.stop(); // cut short g2's search, started at 5000 ms
    await until(() => searching('g1', 0));
    expect(site.snapshot().search?.tier).toBe('backfill');
    await until(() => complete('g1', 0));
    expect(queueView().deferred).toEqual([]);
  });

  it('gives no slice when the job time is the slice or shorter', async () => {
    setup({ topN: 2, jobTimeMs: MIN_LIVE_SLICE_MS });
    await sched.startRound('T1', roundInfo('R1', ['g1', 'g2']), null);
    await until(() => searching('g1', 0));
    expect(slices).toEqual([]);
  });

  it("records the main line and the multi copy's Lines White POV; score is the main line's", async () => {
    setup({ topN: 1 });
    await sched.startRound('T1', roundInfo('R1', ['g1']), null);
    src.push(upd('g1', []));
    await until(() => complete('g1', 0));
    const e = evalOf('g1', 0)!;
    expect(e.lines).toEqual([{ score: { cp: 29 }, depth: 3, move: 'e2e4', san: ['e4', 'e5'] }]);
    expect(e.score).toEqual(e.lines[0].score);
    expect(e.bestmove).toBe('e2e4');
    expect(e.multi!.depth).toBe(3);
    expect(e.multi!.lines.map((l) => l.score)).toEqual([{ cp: 34 }, { cp: 33 }, { cp: 32 }]); // --offset 5
    src.push(upd('g1', ['e2e4']));
    await until(() => complete('g1', 1));
    expect(evalOf('g1', 1)!.score).toEqual({ cp: -129 });
    expect(evalOf('g1', 1)!.multi!.lines[0].score).toEqual({ cp: -134 });
  });

  it('sends each copy the shared options, its Threads/Hash, then its MultiPV last', async () => {
    setup({ topN: 1 });
    await sched.setEngine({ ...engineConfig('fake', { Style: 'Risky' }, 4), main: { threads: 2, hash: 64 } });
    await sched.startRound('T1', roundInfo('R1', ['g1']), null);
    const opts = (file: string) => readLog(file).filter((l) => l.startsWith('setoption'));
    expect(opts(logFile)).toEqual([
      'setoption name Style value Risky',
      'setoption name Threads value 2',
      'setoption name Hash value 64',
      'setoption name MultiPV value 1',
    ]);
    expect(opts(multiLog)).toEqual([
      'setoption name Style value Risky',
      'setoption name Threads value 1',
      'setoption name Hash value 1024',
      'setoption name MultiPV value 4',
    ]);
  });

  it('searches each position on both copies at once and stops them together', async () => {
    setup({ topN: 1, passesMs: [5000, null, null] });
    await sched.startRound('T1', roundInfo('R1', ['g1']), null);
    await until(() => {
      const s = site.snapshot().search;
      return s?.lines.length === 1 && s.depth === 3 && s.multi?.lines.length === 3 && s.multi.depth === 3;
    });
    expect(site.snapshot().search).toMatchObject({ depth: 3, multi: { depth: 3, nps: 100000 } });
    await sched.engine!.stop(); // the main copy ends the Job: the multi copy is stopped with it
    await until(() => complete('g1', 0));
    expect(readLog(multiLog)).toContain('stop');
    expect(evalOf('g1', 0)!.multi!.lines).toHaveLength(3);
  });

  it('keeps accuracy on the main copy: a multi crash records the main eval without Lines, no crash counted', async () => {
    const crashed = await outcomes('crashed');
    setup({ topN: 1, multiArgs: ['--crash-on', 'e2e4'] });
    await sched.startRound('T1', roundInfo('R1', ['g1']), null);
    src.push(upd('g1', ['e2e4', 'e7e5']));
    await idle();
    expect(evalOf('g1', 1)).toMatchObject({ kind: 'complete', score: { cp: -129 }, multi: null });
    expect(evalOf('g1', 2)!.multi!.lines).toHaveLength(3);
    expect(state.dead).toEqual([]);
    expect((await outcomes('crashed')) - crashed).toBe(0);
    await poll(() => sched.copyState('multi') === 'up');
    expect(sched.copyRestarts('multi')).toBeGreaterThanOrEqual(1);
    expect(sched.copyRestarts('main')).toBe(0);
  });

  it('fixes the Job outcome when the main copy ends, not while it waits for the multi copy', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let settled = false; // the Scheduler stops the multi copy once the main copy's search has ended
    setup({
      topN: 1,
      launchMulti: async (real) => {
        const e = await real();
        const search = e.search.bind(e);
        e.search = (...args) => search(...args).then(async (r) => (await gate, r)); // held until released
        const stop = e.stop.bind(e);
        e.stop = () => ((settled = true), stop());
        return e;
      },
    });
    await sched.startRound('T1', roundInfo('R1', ['g1']), null);
    await poll(() => settled); // the Scheduler has the main copy's result for the start position
    src.push(upd('g1', ['e2e4'])); // its Board moved on: would have evicted the Job as stale
    release();
    await until(() => complete('g1', 0));
    expect(sched.evictions).toEqual([]);
  });

  it('runs Jobs on the main copy alone while the multi copy is down', async () => {
    setup({ topN: 1, manual: true, launchMulti: () => Promise.reject(new Error('no multi')) });
    await sched.startRound('T1', roundInfo('R1', ['g1']), null);
    src.push(upd('g1', ['e2e4']));
    await idle();
    expect(sched.copyState('multi')).toBe('restarting');
    expect(evalOf('g1', 1)).toMatchObject({ kind: 'complete', multi: null });
    expect(evalOf('g1', 0)).toMatchObject({ kind: 'complete', multi: null });
  });

  it('searches a corrected latest move again', async () => {
    setup({ topN: 1 });
    await sched.startRound('T1', roundInfo('R1', ['g1']), null);
    src.push(upd('g1', E4));
    await idle();
    src.push(upd('g1', ['e2e4', 'e7e5', 'b1c3']));
    await until(() => complete('g1', 3));
    expect(positions()).toContain('position startpos moves e2e4 e7e5 b1c3');
  });

  it('requeues a Job whose position a correction made stale', async () => {
    setup({ topN: 1, passesMs: [150, null, null] });
    await sched.startRound('T1', roundInfo('R1', ['g1']), null);
    src.push(upd('g1', E4.slice(0, 1)));
    await until(() => searching('g1', 1));
    src.push(upd('g1', E4.slice(0, 2)));
    src.push(upd('g1', ['e2e4', 'c7c5'])); // ply 1 is kept, but the epoch changes under its Job
    await sched.setPasses(one(15));
    await until(() => complete('g1', 1) && complete('g1', 2));
    expect(positions()).toContain('position startpos moves e2e4 c7c5');
  });

  it('takes the opening from the PGN tags and asks the explorer only for untagged Tracked Boards', async () => {
    const asked: string[][] = [];
    setup({ jobTimeMs: null, topN: 1, fetchOpening: async (uci) => (asked.push([...uci]), "C20 King's Pawn Game") });
    await sched.startRound('T1', roundInfo('R1', ['g1', 'g2', 'g3']), null);
    src.push({ ...upd('g1', E4), opening: 'B00 Tagged' });
    expect(state.board('g1')?.opening).toBe('B00 Tagged');
    expect(asked).toEqual([]);
    src.push(upd('g3', E4)); // untracked
    expect(asked).toEqual([]);
    src.push(upd('g2', E4)); // untracked too (topN 1)
    src.push(upd('g1', E4.slice(0, 1))); // tracked, untagged
    expect(asked).toEqual([E4.slice(0, 1)]);
    await until(() => state.board('g1')?.opening === "C20 King's Pawn Game");
  });

  it('does nothing about untagged Boards without a fetchOpening option', async () => {
    setup({ jobTimeMs: null });
    await sched.startRound('T1', roundInfo('R1', ['g1']), null);
    src.push(upd('g1', E4));
    expect(state.board('g1')?.opening).toBeNull();
  });

  it('records every Board but only searches Tracked ones', async () => {
    setup({ topN: 1 });
    await sched.startRound('T1', roundInfo('R1', ['g1', 'g2']), null);
    src.push(upd('g2', D4));
    src.push(upd('g1', E4.slice(0, 1)));
    await idle();
    expect(state.board('g2')!.plies).toHaveLength(4);
    expect(state.board('g2')!.plies.every((p) => p.eval === null)).toBe(true);
    expect(positions().some((p) => p.includes('d2d4'))).toBe(false);
    expect(complete('g1', 1)).toBe(true);
  });

  it('idles while the job time is unset', async () => {
    setup({ topN: 1, jobTimeMs: null });
    await sched.startRound('T1', roundInfo('R1', ['g1']), null);
    src.push(upd('g1', E4.slice(0, 1)));
    expect(queueView().current).toEqual([{ boardId: 'g1', ply: 1 }]);
    await new Promise((r) => setTimeout(r, 50)); // negative assertion: nothing may start
    expect(count('go')).toBe(0);
    await sched.setPasses(one(15));
    await until(() => complete('g1', 1) && complete('g1', 0));
  });

  it('evaluates a finished Board and skips mate positions', async () => {
    setup({ topN: 2 });
    await sched.startRound('T1', roundInfo('R1', ['g1', 'g2']), null);
    src.push(upd('g1', E4, '1-0'));
    src.push(upd('g2', FOOLS, '0-1'));
    await idle();
    expect([0, 1, 2, 3].every((i) => complete('g1', i))).toBe(true);
    expect(state.board('g1')!.result).toBe('1-0');
    expect([0, 1, 2, 3].every((i) => complete('g2', i))).toBe(true);
    expect(evalOf('g2', 4)).toBeNull();
    expect(positions().some((p) => p.endsWith(FOOLS.join(' ')))).toBe(false);
  });

  it('startRound drops the running Job and follows the new Round', async () => {
    setup({ topN: 2, passesMs: [5000, null, null] });
    await sched.startRound('T1', roundInfo('R1', ['g1', 'g2']), null);
    await until(() => searching('g1', 0));
    const old = src;
    const t0 = Date.now();
    await sched.startRound('T1', roundInfo('R2', ['h1', 'h2']), null);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(old.stopped).toBe(true);
    expect(sourceIds).toEqual(['R1', 'R2']);
    expect(state.round!.roundId).toBe('R2');
    const ids = [...queueView().current.map((j) => j.boardId), sched.running?.boardId];
    expect(ids.every((id) => id === 'h1' || id === 'h2')).toBe(true);
  });

  it("startRound's snapshot carries no search, stream or Queue of the previous Round", async () => {
    setup({ topN: 2, jobTimeMs: null });
    await sched.startRound('T1', roundInfo('R1', ['g1', 'g2']), null);
    src.status('connected');
    expect(queueView().current.length).toBeGreaterThan(0);
    const seen: T.Snapshot[] = [];
    site.on('event', (_t, e) => e.type === 'snapshot' && seen.push(e.snapshot));
    await sched.startRound('T1', roundInfo('R2', ['h1', 'h2']), null);
    expect(seen).toHaveLength(1);
    expect([seen[0].search, seen[0].stream, seen[0].queue]).toEqual([
      null,
      null,
      { current: [], backfill: 0, deferred: [] },
    ]);
  });

  it('untracking a Board removes its Jobs', async () => {
    setup({ topN: 2, jobTimeMs: null });
    await sched.startRound('T1', roundInfo('R1', ['g1', 'g2']), null);
    src.push(upd('g1', E4.slice(0, 1)));
    src.push(upd('g2', D4));
    await sched.setTracked('T1', ['g1']);
    expect(queueView()).toEqual({ current: [{ boardId: 'g1', ply: 1 }], backfill: 1, deferred: [] });
    await sched.setPasses(one(15));
    await idle();
    expect(complete('g1', 1)).toBe(true);
    expect(positions().some((p) => p.includes('d2d4'))).toBe(false);
  });

  it('tracking a Board searches its earlier plies too', async () => {
    setup({ topN: 1 });
    await sched.startRound('T1', roundInfo('R1', ['g1', 'g2']), null);
    src.push(upd('g2', D4));
    await idle();
    await sched.setTracked('T1', ['g1', 'g2']);
    await idle();
    expect([0, 1, 2, 3].every((i) => complete('g2', i))).toBe(true);
  });

  it('resume rebuilds the Queue from plies without a Complete eval', async () => {
    const ev = (kind: T.EvalKind): T.Eval => ({ score: { cp: 1 }, depth: 1, kind, bestmove: null, lines: [] });
    const ply = (uci: string | null, e: T.Eval | null): T.Ply => ({
      move: uci && { uci, san: uci, clock: null },
      at: null,
      eval: e,
    });
    const board: T.Board = {
      id: 'g1',
      board: 1,
      white: { name: 'W' },
      black: { name: 'B' },
      result: '*',
      tracked: true,
      opening: null,
      clocks: { white: null, black: null },
      plies: [ply(null, ev('complete')), ply('e2e4', ev('provisional')), ply('e7e5', null)],
    };
    const round: T.Round = { tourId: 'T1', roundId: 'R1', name: 'R1', eventName: 'E', startsAt: null, boards: [board] };
    setup({ jobTimeMs: null, init: { state: persisted([]), rounds: new Map([['T1', round]]) } });
    await sched.resume();
    expect(sourceIds).toEqual(['R1']);
    expect(queueView()).toEqual({ current: [{ boardId: 'g1', ply: 2 }], backfill: 1, deferred: [] });
    await sched.setPasses(one(15));
    await idle();
    expect(complete('g1', 1) && complete('g1', 2)).toBe(true);
    expect(readLog()).not.toContain('position startpos');
  });

  it('setEngine restarts the engine and requeues the running Job', async () => {
    const interrupted = await outcomes('interrupted');
    setup({ topN: 1, passesMs: [5000, null, null] });
    await sched.startRound('T1', roundInfo('R1', ['g1']), null);
    await until(() => searching('g1', 0));
    await sched.setPasses(one(null)); // keep the requeued Job from starting on the new engine
    await sched.setEngine(engineConfig('fake', {}, 2));
    expect(count('uci')).toBe(2);
    expect(readLog(multiLog).filter((l) => l === 'uci')).toHaveLength(2); // both copies restart
    expect(readLog(multiLog)).toContain('setoption name MultiPV value 2');
    expect(sched.running).toBeNull();
    expect(queueView().current).toEqual([{ boardId: 'g1', ply: 0 }]);
    expect((await outcomes('interrupted')) - interrupted).toBe(1);
    await sched.setPasses(one(15));
    await until(() => complete('g1', 0));
    expect(evalOf('g1', 0)!.multi!.lines).toHaveLength(2);
  });

  it('restarts a crashed engine and carries on with the other Jobs', async () => {
    setup({ topN: 2, engineArgs: ['--crash-on', 'e2e4'] });
    await sched.startRound('T1', roundInfo('R1', ['g1', 'g2']), null);
    src.push(upd('g1', E4.slice(0, 1)));
    src.push(upd('g2', D4));
    await until(() => [0, 1, 2, 3].every((i) => complete('g2', i)));
    expect(count('uci')).toBeGreaterThanOrEqual(2);
    expect(count('setoption name MultiPV value 1')).toBeGreaterThanOrEqual(2); // options applied again on relaunch
    await poll(() => sched.copyState('main') === 'up');
    expect(delays[0]).toBe(RESTART_MIN_MS);
    expect(sched.copyRestarts('main')).toBeGreaterThanOrEqual(1);
  });

  describe('Dead-letter queue', () => {
    const E4_POS = 'position startpos moves e2e4';
    async function crashing(): Promise<void> {
      setup({ topN: 1, engineArgs: ['--crash-on', 'e2e4'] });
      await sched.startRound('T1', roundInfo('R1', ['g1']), null);
      src.push(upd('g1', E4.slice(0, 1)));
      await until(() => state.dead.length === 1 && complete('g1', 0));
    }

    it('takes a position that crashed the engine three times, and moves on', async () => {
      const [crashed, dead] = [await outcomes('crashed'), await outcomes('dead_lettered')];
      await crashing();
      expect([(await outcomes('crashed')) - crashed, (await outcomes('dead_lettered')) - dead]).toEqual([
        MAX_CRASHES - 1,
        1,
      ]);
      expect(state.dead.map(({ boardId, ply }) => ({ boardId, ply }))).toEqual([{ boardId: 'g1', ply: 1 }]);
      expect(evalOf('g1', 1)).toBeNull();
      expect(queueView().current).toEqual([]);
      expect(positions().filter((p) => p === E4_POS)).toHaveLength(MAX_CRASHES);
      expect(delays).toEqual([1000, 2000, 4000]);
    });

    it('searches a requeued entry again', async () => {
      await crashing();
      engineArgs = [];
      await sched.setEngine(engineConfig('fake'));
      expect(await sched.requeueDead('g1', 1)).toBe(true);
      await until(() => complete('g1', 1));
      expect(state.dead).toEqual([]);
    });

    it('forgets a discarded entry', async () => {
      await crashing();
      expect(await sched.discardDead('g1', 1)).toBe(true);
      expect(state.dead).toEqual([]);
      expect(queueView().current).toEqual([]);
      expect(await sched.discardDead('g1', 1)).toBe(false);
      expect(await sched.requeueDead('g1', 1)).toBe(false);
      src.push(upd('g1', E4.slice(0, 2))); // the rebuild of the Board's backfill leaves it out
      await until(() => complete('g1', 2));
      await idle();
      expect(positions().filter((p) => p === E4_POS)).toHaveLength(MAX_CRASHES);
      expect(evalOf('g1', 1)).toBeNull();
    });

    it('drops and persists the entries a correction took away', async () => {
      await crashing();
      src.push(upd('g1', []));
      await until(() => state.dead.length === 0);
      expect(queueView().current).toEqual([]);
    });

    it('is emptied by a new Round', async () => {
      await crashing();
      await sched.startRound('T1', roundInfo('R2', ['h1']), null);
      expect(state.dead).toEqual([]);
    });

    it('is restored at boot, so its positions are not searched again', async () => {
      const ply = (uci: string | null): T.Ply => ({
        move: uci && { uci, san: uci, clock: null },
        at: null,
        eval: null,
      });
      const board: T.Board = {
        id: 'g1',
        board: 1,
        white: { name: 'W' },
        black: { name: 'B' },
        result: '*',
        tracked: true,
        opening: null,
        clocks: { white: null, black: null },
        plies: [ply(null), ply('e2e4')],
      };
      const round: T.Round = {
        tourId: 'T1',
        roundId: 'R1',
        name: 'R1',
        eventName: 'E',
        startsAt: null,
        boards: [board],
      };
      const dead = [{ tourId: 'T1', boardId: 'g1', board: 1, ply: 1, at: 5 }];
      setup({ jobTimeMs: null, init: { state: persisted(dead), rounds: new Map([['T1', round]]) } });
      await sched.resume();
      expect(queueView()).toEqual({ current: [], backfill: 1, deferred: [] });
      expect(state.dead).toEqual(dead);
      await sched.setPasses(one(15));
      await idle();
      expect(complete('g1', 0)).toBe(true);
      expect(positions().some((p) => p.includes('e2e4'))).toBe(false);
    });
  });

  describe('two Events', () => {
    const board = (id: string, n: number, uci: string[], evals: (T.Eval | null)[] = []): T.Board => {
      const ply = (u: string | null, e: T.Eval | null): T.Ply => ({
        move: u && { uci: u, san: u, clock: null },
        at: null,
        eval: e,
      });
      return {
        id,
        board: n,
        white: { name: 'W' },
        black: { name: 'B' },
        result: '*',
        tracked: true,
        opening: null,
        clocks: { white: null, black: null },
        plies: [ply(null, evals[0] ?? null), ...uci.map((u, i) => ply(u, evals[i + 1] ?? null))],
      };
    };
    const complete0: T.Eval = { score: { cp: 1 }, depth: 1, kind: 'complete', bestmove: null, lines: [] };

    it("routes each Job's eval to its own Event's Board", async () => {
      setup2({ topN: 1 });
      await startBoth();
      src = srcOf.R1;
      srcOf.R1.push(upd('a1', E4.slice(0, 1)));
      srcOf.S1.push(upd('b1', D4.slice(0, 1)));
      await until(() => complete('a1', 1) && state2.board('b1')!.plies[1]?.eval?.kind === 'complete');
      expect(state.board('b1')).toBeUndefined();
      expect(state2.board('a1')).toBeUndefined();
      expect(positions()).toContain('position startpos moves e2e4');
      expect(positions()).toContain('position startpos moves d2d4');
    });

    it("a Round swap of one Event keeps the other Event's running Job", async () => {
      setup2({ topN: 1, passesMs: [5000, null, null] });
      await sched.startRound('T2', roundInfo('S1', ['b1', 'b2'], 'T2'), null);
      await until(() => searching('b1', 0, 'T2'));
      await sched.startRound('T1', roundInfo('R1', ['a1', 'a2']), null);
      const job = sched.running;
      expect(job).toMatchObject({ tourId: 'T2', boardId: 'b1' });
      const dropped = await outcomes('dropped');
      await sched.startRound('T1', roundInfo('R2', ['a1']), null);
      expect(sched.running).toEqual(job);
      expect(await outcomes('dropped')).toBe(dropped);
      expect(searching('b1', 0, 'T2')).toBe(true);
      expect(srcOf.S1.stopped).toBe(false);
      expect(srcOf.R1.stopped).toBe(true);
      expect(srcOf.R2.stopped).toBe(false);
    });

    describe('removing an Event', () => {
      it('halts only its own Job', async () => {
        setup2({ topN: 1, passesMs: [5000, null, null] });
        await sched.startRound('T1', roundInfo('R1', ['a1', 'a2']), null);
        await until(() => searching('a1', 0));
        await sched.startRound('T2', roundInfo('S1', ['b1', 'b2'], 'T2'), null);
        await sched.removeEvent('T1');
        await until(() => searching('b1', 0, 'T2'));
        expect(sched.running).toMatchObject({ tourId: 'T2', boardId: 'b1' });
        expect(queueView().current.every((j) => j.boardId.startsWith('b'))).toBe(true);
        expect(site.event('T1')).toBeUndefined();
        expect(srcOf.R1.stopped).toBe(true);
        expect(srcOf.S1.stopped).toBe(false);
        await sched.setPasses(one(15));
        await sched.engine!.stop(); // cut short b1's 5000 ms search
        await until(() => state2.board('b1')!.plies[0].eval?.kind === 'complete');
        expect(state2.board('b1')!.plies[0].eval?.kind).toBe('complete');
      });

      it("leaves the other Event's running Job alone", async () => {
        setup2({ topN: 1, passesMs: [5000, null, null] });
        await sched.startRound('T2', roundInfo('S1', ['b1', 'b2'], 'T2'), null);
        await until(() => searching('b1', 0, 'T2'));
        await sched.startRound('T1', roundInfo('R1', ['a1', 'a2']), null);
        const job = sched.running;
        const dropped = await outcomes('dropped');
        await sched.removeEvent('T1');
        expect(sched.running).toEqual(job);
        expect(await outcomes('dropped')).toBe(dropped);
        expect(searching('b1', 0, 'T2')).toBe(true);
        expect(queueView().current).toEqual([]);
        expect(srcOf.S1.stopped).toBe(false);
      });

      it('drops the result of its Job and never writes it into another Event', async () => {
        setup2({ topN: 1, passesMs: [5000, null, null] });
        await sched.startRound('T1', roundInfo('R1', ['a1', 'a2']), null);
        await until(() => searching('a1', 0));
        await sched.startRound('T2', roundInfo('S1', ['b1', 'b2'], 'T2'), null);
        const dropped = await outcomes('dropped');
        const rs = state;
        await sched.removeEvent('T1');
        expect(await outcomes('dropped')).toBe(dropped + 1);
        expect(rs.board('a1')!.plies[0].eval).toBeNull();
        expect(state2.board('a1')).toBeUndefined();
        expect(state2.board('b1')!.plies[0].eval).toBeNull(); // T2's own Job is still searching
      });
    });

    it("a live position of one Event evicts another Event's backfill Job", async () => {
      setup2({ topN: 1, passesMs: [5000, null, null] });
      await sched.startRound('T1', roundInfo('R1', ['a1', 'a2']), null);
      srcOf.R1.push(upd('a1', E4.slice(0, 1)));
      await until(() => searching('a1', 1));
      await sched.engine!.stop(); // cut short ply 1; ply 0 is left to backfill
      await until(() => searching('a1', 0));
      expect(site.snapshot().search?.tier).toBe('backfill');
      await sched.startRound('T2', roundInfo('S1', ['b1', 'b2'], 'T2'), null);
      await until(() => searching('b1', 0, 'T2'));
      expect(sched.evictions[0]).toMatchObject({ tourId: 'T1', boardId: 'a1', ply: 0, reason: 'backfill' }); // newest first
    });

    it('the last Event removed quits both engines; a new Round launches them again', async () => {
      setup2({ topN: 1, jobTimeMs: null });
      await startBoth();
      expect(sched.copyState('main')).toBe('up');
      await sched.removeEvent('T1');
      expect([sched.copyState('main'), sched.copyState('multi'), sched.engines.length]).toEqual(['up', 'up', 2]);
      await sched.removeEvent('T2');
      expect([sched.copyState('main'), sched.copyState('multi'), sched.engines.length]).toEqual([null, null, 0]);
      expect(site.snapshot().search).toBeNull();
      site.addEvent(EVENT_T1, 1);
      await sched.startRound('T1', roundInfo('R3', ['a1']), null);
      expect([sched.copyState('main'), sched.copyState('multi'), sched.engines.length]).toEqual(['up', 'up', 2]);
    });

    it('Dead-letter entries persist to their own Event', async () => {
      setup2({ topN: 1, engineArgs: ['--crash-on', 'e2e4'] });
      await startBoth();
      srcOf.S1.push(upd('b1', E4.slice(0, 1)));
      await until(() => state2.dead.length === 1 && state2.board('b1')!.plies[0].eval?.kind === 'complete');
      expect(state2.dead.map(({ tourId, boardId, ply }) => ({ tourId, boardId, ply }))).toEqual([
        { tourId: 'T2', boardId: 'b1', ply: 1 },
      ]);
      expect(state.dead).toEqual([]);
    });

    it('resume follows every Event with a Round and restores each Dead-letter queue with its tourId', async () => {
      const r1: T.Round = {
        tourId: 'T1',
        roundId: 'R1',
        name: 'R1',
        eventName: 'E',
        startsAt: null,
        boards: [board('a1', 1, ['d2d4'], [complete0])],
      };
      const r2: T.Round = {
        tourId: 'T2',
        roundId: 'S1',
        name: 'S1',
        eventName: 'E2',
        startsAt: null,
        boards: [board('b1', 1, ['e2e4'], [complete0])],
      };
      const dead = [{ tourId: 'T2', boardId: 'b1', board: 1, ply: 1, at: 5 }];
      const init: T.PersistedState = {
        version: 5,
        deep: [],
        settings: { engine: null, passesMs: null },
        primary: 'T1',
        events: [
          { event: EVENT_T1, topN: 1, current: { tourId: 'T1', roundId: 'R1' }, dead: [] },
          { event: EVENT_T2, topN: 1, current: { tourId: 'T2', roundId: 'S1' }, dead },
        ],
      };
      setup({
        jobTimeMs: null,
        init: {
          state: init,
          rounds: new Map([
            ['T1', r1],
            ['T2', r2],
          ]),
        },
      });
      state2 = site.event('T2')!;
      await sched.resume();
      expect(sourceIds).toEqual(['R1', 'S1']);
      expect(queueView()).toEqual({ current: [{ boardId: 'a1', ply: 1 }], backfill: 0, deferred: [] });
      await sched.setTracked('T1', ['a1']); // persists the Dead-letter queue per Event
      expect([state.dead, state2.dead]).toEqual([[], dead]);
      await sched.setPasses(one(15));
      await until(() => state.board('a1')!.plies[1].eval?.kind === 'complete');
      expect(positions().some((p) => p.endsWith('moves e2e4'))).toBe(false);
      expect(sched.copyState('main')).toBe('up');
    });

    it('drops the result of a Job whose Event was removed behind the Scheduler', async () => {
      setup2({ topN: 1, passesMs: [5000, null, null] });
      await sched.startRound('T1', roundInfo('R1', ['a1', 'a2']), null);
      await until(() => searching('a1', 0));
      const rs = state;
      const dropped = await outcomes('dropped');
      site.removeEvent('T1');
      await sched.engine!.stop(); // the search ends normally
      await poll(() => sched.running === null);
      expect(await outcomes('dropped')).toBe(dropped + 1);
      expect(rs.board('a1')!.plies[0].eval).toBeNull();
    });

    it('the last Event removed while a restart is pending launches nothing', async () => {
      setup({ jobTimeMs: null, manual: true });
      await sched.startRound('T1', roundInfo('R1', ['g1']), null);
      await sched.engine!.quit();
      await poll(() => fire.length === 1);
      await sched.removeEvent('T1');
      fire[0]();
      await sched.setPasses(one(null));
      expect([count('uci'), sched.copyState('main'), sched.engines.length]).toEqual([1, null, 0]);
    });

    it("another Event's Dead-letter entries survive an Event's Round swap", async () => {
      setup2({ topN: 1, engineArgs: ['--crash-on', 'e2e4'] });
      await startBoth();
      srcOf.S1.push(upd('b1', E4.slice(0, 1)));
      await until(() => state2.dead.length === 1);
      const queue = (sched as unknown as { queue: { dead(): unknown[] } }).queue;
      const before = queue.dead();
      expect(before).toHaveLength(1);
      await sched.startRound('T1', roundInfo('R2', ['a1']), null);
      expect(queue.dead()).toEqual(before);
      expect(state2.dead).toHaveLength(1);
    });

    it("setTracked of one Event leaves the other's Jobs", async () => {
      setup2({ topN: 1, jobTimeMs: null });
      await startBoth();
      const ids = () =>
        queueView()
          .current.map((j) => j.boardId)
          .sort();
      expect(ids()).toEqual(['a1', 'b1']);
      await sched.setTracked('T1', ['a2']);
      expect(ids()).toEqual(['a2', 'b1']);
    });
  });

  describe('restart backoff', () => {
    it('doubles up to the cap', async () => {
      setup({ topN: 3, engineArgs: ['--exit-on-go'] });
      await sched.startRound('T1', roundInfo('R1', ['g1', 'g2', 'g3']), null);
      await until(() => state.dead.length === 3);
      await poll(() => delays.length === 9);
      expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
      expect(sched.copyRestarts('main')).toBe(9);
    });

    it('starts over after a Job completes', async () => {
      setup({ topN: 2, jobTimeMs: null, engineArgs: ['--crash-on', 'e2e4'] });
      await sched.startRound('T1', roundInfo('R1', ['g1', 'g2']), null);
      src.push(upd('g1', E4.slice(0, 1)));
      await sched.setPasses(one(15));
      await until(() => state.dead.length === 1 && complete('g1', 0) && complete('g2', 0)); // searched after the crashes
      expect(delays).toEqual([1000, 2000, 4000]);
      src.push(upd('g2', E4.slice(0, 1)));
      await poll(() => delays.length === 4);
      expect(delays[3]).toBe(1000);
    });

    it('survives a failing launch', async () => {
      let n = 0;
      setup({
        topN: 1,
        launch: (real) => (n++ < 2 ? Promise.reject(new Error('no such engine')) : real()),
      });
      await sched.startRound('T1', roundInfo('R1', ['g1']), null); // does not throw
      expect(sched.copyState('main')).toBe('restarting');
      await poll(() => sched.copyState('main') === 'up');
      expect(delays).toEqual([1000, 2000]);
      await until(() => complete('g1', 0));
    });
  });

  describe('engine exit with no running Job', () => {
    it('restarts without counting a crash', async () => {
      setup({ topN: 1, jobTimeMs: null, engineArgs: ['--crash-on', 'e2e4'] });
      await sched.startRound('T1', roundInfo('R1', ['g1']), null);
      await sched.engine!.quit();
      await poll(() => sched.copyState('main') === 'up' && count('uci') === 2);
      expect(delays).toEqual([1000]);
      expect(state.dead).toEqual([]);
      src.push(upd('g1', E4.slice(0, 1)));
      await sched.setPasses(one(15));
      await until(() => state.dead.length === 1);
      expect(positions().filter((p) => p === 'position startpos moves e2e4')).toHaveLength(MAX_CRASHES);
    });

    it('is not relaunched twice when a config change got there first', async () => {
      setup({ jobTimeMs: null, manual: true });
      await sched.startRound('T1', roundInfo('R1', ['g1']), null);
      await sched.engine!.quit();
      await poll(() => fire.length === 1);
      expect(sched.copyState('main')).toBe('restarting');
      await sched.setEngine(engineConfig('fake'));
      expect(sched.copyState('main')).toBe('up');
      fire[0]();
      await sched.setPasses(one(null)); // waits for the timer's turn on the serial chain
      expect(count('uci')).toBe(2);
    });

    it('is not relaunched after stop()', async () => {
      setup({ jobTimeMs: null, manual: true });
      await sched.startRound('T1', roundInfo('R1', ['g1']), null);
      await sched.engine!.quit();
      await poll(() => fire.length === 1);
      await sched.stop();
      fire[0]();
      await sched.setPasses(one(null));
      expect([count('uci'), sched.copyState('main')]).toEqual([1, null]);
    });
  });
});

describe('Scheduler Passes', () => {
  const msOf = (id: string, ply: number) => evalOf(id, ply)?.ms;
  const ev = (depth: number, ms: number): T.Eval => ({
    score: { cp: 1 },
    depth,
    kind: 'complete',
    bestmove: null,
    lines: [],
    ms,
  });
  /** A Round of one live Board g1 (e2e4 played), both plies with a Complete eval at `depth` after `ms`. */
  const resumed = (depth: number, ms: number) => {
    const ply = (uci: string | null): T.Ply => ({
      move: uci && { uci, san: uci, clock: null },
      at: null,
      eval: ev(depth, ms),
    });
    const board: T.Board = {
      id: 'g1',
      board: 1,
      white: { name: 'W' },
      black: { name: 'B' },
      result: '*',
      tracked: true,
      opening: null,
      clocks: { white: null, black: null },
      plies: [ply(null), ply('e2e4')],
    };
    const round: T.Round = { tourId: 'T1', roundId: 'R1', name: 'R1', eventName: 'E', startsAt: null, boards: [board] };
    return { state: persisted([]), rounds: new Map([['T1', round]]) };
  };

  it('deepens each position Pass by Pass, never to the deep Pass, live or not', async () => {
    setup({ topN: 1, passesMs: [5, 10, 20] });
    await sched.startRound('T1', roundInfo('R1', ['g1']), null);
    src.push(upd('g1', E4));
    await poll(() => [1, 2, 3].every((p) => msOf('g1', p) === 10) && sched.running === null);
    expect(msOf('g1', 0)).toBe(5); // the start position: Pass 0 only
    expect(sched.passCounts).toEqual([]);
    src.push(upd('g1', E4, '1-0')); // nothing is live: the deep Pass is still on demand only
    await idle();
    expect([0, 1, 2, 3].map((p) => msOf('g1', p))).toEqual([5, 10, 10, 10]);
    expect(sched.passCounts).toEqual([]);
    expect(sched.timing.map((t) => t.jobs)).toEqual([4, 3]);
  });

  it('evicts a deepening Job for a new position and drops its result when it is no deeper', async () => {
    const [discarded, upgrade] = [await outcomes('discarded', '1'), await val(evictions, { reason: 'upgrade' })];
    setup({ topN: 2, passesMs: [5, 5000, null] });
    await sched.startRound('T1', roundInfo('R1', ['g1', 'g2']), null);
    src.push(upd('g1', ['e2e4']));
    await until(() => searching('g1', 1) && site.snapshot().search?.pass === 1);
    expect(site.snapshot().search?.ms).toBe(5000);
    src.push(upd('g2', ['d2d4']));
    await until(() => complete('g2', 1));
    expect(evalOf('g1', 1)).toMatchObject({ kind: 'complete', depth: 3, ms: 5 }); // the Pass 0 eval stays
    expect(sched.evictions[0]).toMatchObject({ boardId: 'g1', ply: 1, reason: 'upgrade', depth: 3 });
    expect((await val(evictions, { reason: 'upgrade' })) - upgrade).toBe(1);
    expect((await outcomes('discarded', '1')) - discarded).toBe(1);
    expect(sched.passCounts[1] + (sched.running?.pass === 1 ? 1 : 0)).toBe(2); // g1 again, and g2
  });

  it('keeps an interrupted deepening search that got deeper, as Complete, and searches it again', async () => {
    setup({ topN: 1, passesMs: [5, 5000, null], init: resumed(1, 5) });
    await sched.resume();
    await until(() => searching('g1', 1) && site.snapshot().search?.depth === 3);
    expect(site.snapshot().search?.pass).toBe(1);
    t += 1234;
    src.push(upd('g1', ['e2e4', 'e7e5'])); // its Board moved on
    await until(() => complete('g1', 2));
    expect(evalOf('g1', 1)).toMatchObject({ kind: 'complete', depth: 3, ms: 1234 });
    expect(sched.evictions[0]).toMatchObject({ boardId: 'g1', ply: 1, reason: 'stale' });
    await poll(() => sched.running?.pass === 1);
    const pass1 = sched.passCounts[1] + 1; // the waiting ones and the running one
    expect(pass1).toBe(2); // ply 1 again (1234 ms < 5000 ms), and ply 2
  });

  it('setPasses queues the positions a new Pass applies to, and drops the Jobs of a Pass turned off', async () => {
    setup({ topN: 1, jobTimeMs: 5 });
    await sched.startRound('T1', roundInfo('R1', ['g1']), null);
    src.push(upd('g1', E4));
    await idle();
    expect([0, 1, 2, 3].map((p) => msOf('g1', p))).toEqual([5, 5, 5, 5]);
    await sched.setPasses([5, 10, null]);
    await poll(() => [1, 2, 3].every((p) => msOf('g1', p) === 10));
    expect(msOf('g1', 0)).toBe(5);
    await sched.setPasses([5, 20, 5000]); // the deep Pass queues nothing
    await poll(() => [1, 2, 3].every((p) => msOf('g1', p) === 20) && sched.running === null);
    expect(sched.passCounts).toEqual([]);
  });

  it('stops a running Job whose Pass is turned off, and does not queue it again', async () => {
    setup({ topN: 1, passesMs: [5, 5000, null] });
    await sched.startRound('T1', roundInfo('R1', ['g1']), null);
    src.push(upd('g1', ['e2e4']));
    await until(() => searching('g1', 1) && site.snapshot().search?.pass === 1);
    await sched.setPasses([5, null, null]);
    await poll(() => sched.running === null);
    expect(sched.evictions[0]).toMatchObject({ boardId: 'g1', ply: 1, reason: 'upgrade' });
    expect(evalOf('g1', 1)).toMatchObject({ kind: 'complete', ms: 5 });
    expect(sched.passCounts).toEqual([]);
  });
});

describe('Scheduler deep analysis', () => {
  let store: DataStore;
  const ply = (u: string | null, e: T.Eval | null): T.Ply => ({
    move: u && { uci: u, san: u, clock: null },
    at: null,
    eval: e,
  });
  /** A finished, untracked Board with every ply's eval `e`. */
  const board = (id: string, uci: string[], o: Partial<T.Board> = {}, e: T.Eval | null = null): T.Board => ({
    id,
    board: 1,
    white: { name: 'W' },
    black: { name: 'B' },
    result: '1-0',
    tracked: false,
    opening: null,
    clocks: { white: null, black: null },
    plies: [ply(null, e), ...uci.map((u) => ply(u, e))],
    ...o,
  });
  const round = (tourId: string, roundId: string, boards: T.Board[]): T.Round => ({
    tourId,
    roundId,
    name: roundId,
    eventName: 'E',
    startsAt: null,
    boards,
  });
  /** The evals' ms of that Board in its Round file (null: no eval), once every write is done. */
  const fileMs = async (tourId: string, roundId: string, boardId: string) => {
    await site.saved();
    const r = await store.loadRound(tourId, roundId);
    return r!.boards.find((b) => b.id === boardId)!.plies.map((p) => (p.eval?.kind === 'complete' ? p.eval.ms : null));
  };
  const deepQueue = () => (sched as unknown as { queue: { deep(): Job[] } }).queue.deep();
  const regularIdle = () => sched.running === null && !sched.passCounts[0] && !sched.passCounts[1];
  const settled = () => poll(() => sched.deep.length === 0 && sched.running === null, 5000);
  const deepSearch = (id: string, ply: number) => searching(id, ply) && site.snapshot().search?.pass === DEEP_PASS;

  beforeEach(() => {
    store = dataStore(join(dir, 'data', 'state.json'));
  });

  it('fills every ply of an archived Board of no Event and writes its Round file; engines run only meanwhile', async () => {
    const recorded = await outcomes('recorded', '2');
    await store.saveRound(round('T9', 'R0', [board('z1', E4), board('z2', FOOLS, { board: 2, result: '0-1' })]));
    setup({ store, passesMs: [5, 10, 20] });
    expect(await sched.requestDeep('T9', 'R0', 'nope')).toBe('unknown board');
    expect(await sched.requestDeep('T9', 'R9', 'z1')).toBe('unknown board');
    expect(sched.copyState('main')).toBeNull();
    expect(await sched.requestDeep('T9', 'R0', 'z1')).toBe('ok');
    expect(sched.copyState('main')).toBe('up');
    expect(sched.deep).toEqual([{ tourId: 'T9', roundId: 'R0', boardId: 'z1', board: 1, left: 4, total: 4 }]);
    await settled();
    expect(await fileMs('T9', 'R0', 'z1')).toEqual([20, 20, 20, 20]);
    expect((await outcomes('recorded', '2')) - recorded).toBe(4);
    expect(sched.timing[DEEP_PASS].jobs).toBe(4);
    await poll(() => sched.copyState('main') === null); // nothing left
    expect(await sched.requestDeep('T9', 'R0', 'z2')).toBe('ok');
    expect(sched.deep[0]).toMatchObject({ left: 4, total: 4 }); // the final mate position is not searched
    await settled();
    expect(await fileMs('T9', 'R0', 'z2')).toEqual([20, 20, 20, 20, null]);
    expect(await fileMs('T9', 'R0', 'z1')).toEqual([20, 20, 20, 20]);
  });

  it('refuses a request while the deep Pass is off', async () => {
    await store.saveRound(round('T1', 'R0', [board('z1', E4)]));
    setup({ store, passesMs: [5, 10, null] });
    expect(await sched.requestDeep('T1', 'R0', 'z1')).toBe('pass 3 off');
    expect(sched.deep).toEqual([]);
  });

  it('deepens a finished Tracked Board of the Current Round, over its Pass 1 and 2 evals', async () => {
    setup({ store, topN: 1, passesMs: [5, 10, 20] });
    await sched.startRound('T1', roundInfo('R1', ['g1']), null);
    src.push(upd('g1', E4, '1-0'));
    await poll(() => regularIdle() && [1, 2, 3].every((p) => evalOf('g1', p)?.ms === 10));
    expect(evalOf('g1', 0)?.ms).toBe(5);
    const sent: number[] = [];
    site.on('event', (_t, e) => e.type === 'ply' && e.ply.eval?.ms === 20 && sent.push(e.index));
    expect(await sched.requestDeep('T1', 'R1', 'g1')).toBe('ok');
    await settled();
    expect([0, 1, 2, 3].map((p) => evalOf('g1', p))).toEqual(
      Array(4).fill(expect.objectContaining({ kind: 'complete', ms: 20 })),
    );
    expect(sent).toEqual([0, 1, 2, 3]);
    expect(await fileMs('T1', 'R1', 'g1')).toEqual([20, 20, 20, 20]);
    expect(sched.passCounts).toEqual([]);
  });

  it('replaces an eval that searched longer than the deep Pass', async () => {
    const long: T.Eval = { score: { cp: 1 }, depth: 40, kind: 'complete', bestmove: null, lines: [], ms: 1e6 };
    const r1 = round('T1', 'R1', [board('g1', E4, { tracked: true }, long)]);
    const init = {
      ...persisted([]),
      events: [{ event: EVENT_T1, topN: 1, current: { tourId: 'T1', roundId: 'R1' }, dead: [] }],
    };
    setup({ store, passesMs: [5, 10, 20], init: { state: init, rounds: new Map([['T1', r1]]) } });
    await sched.resume();
    expect(await sched.requestDeep('T1', 'R1', 'g1')).toBe('ok');
    await settled();
    expect([0, 1, 2, 3].map((p) => [evalOf('g1', p)?.ms, evalOf('g1', p)?.depth])).toEqual(Array(4).fill([20, 3]));
  });

  it('holds deep Jobs while a Tracked Board is live, gives way when one goes live, and resumes after', async () => {
    const upgrade = await val(evictions, { reason: 'upgrade' });
    await store.saveRound(round('T1', 'R0', [board('z1', E4)]));
    setup({ store, topN: 1, passesMs: [5, 10, 5000] });
    await sched.startRound('T1', roundInfo('R1', ['g1']), null);
    await poll(regularIdle);
    expect(await sched.requestDeep('T1', 'R0', 'z1')).toBe('ok');
    await until(() => deepSearch('z1', 0));
    src.push(upd('g1', ['e2e4'])); // g1 is live
    await poll(() => sched.evictions[0]?.boardId === 'z1');
    expect(sched.evictions[0]).toMatchObject({ boardId: 'z1', ply: 0, reason: 'upgrade', depth: null });
    expect((await val(evictions, { reason: 'upgrade' })) - upgrade).toBe(1);
    await poll(() => regularIdle() && complete('g1', 1));
    await new Promise((r) => setTimeout(r, 50));
    expect(sched.running).toBeNull(); // held
    expect(deepQueue().map((j) => j.ply)).toEqual([0, 1, 2, 3]);
    expect(sched.deep[0].left).toBe(4);
    src.push(upd('g1', ['e2e4'], '1-0')); // over: nothing is live
    await until(() => deepSearch('z1', 0));
  });

  it('a Round swap of its Event while a deep Job of an archived Round runs loses no ply', async () => {
    await store.saveRound(round('T1', 'R0', [board('z1', E4)]));
    setup({ store, topN: 1, passesMs: [5, 10, 5000] });
    expect(await sched.requestDeep('T1', 'R0', 'z1')).toBe('ok');
    await until(() => deepSearch('z1', 0));
    await sched.setPasses([5, 10, 20]); // from the next Job
    await sched.startRound('T1', roundInfo('R1', ['g1']), null); // its Pass 0 Job evicts the deep one
    await settled();
    expect(await fileMs('T1', 'R0', 'z1')).toEqual([20, 20, 20, 20]);
    expect(complete('g1', 0)).toBe(true);
  });

  it('a Round swap moves the deep Jobs of the replaced Round to its Round file, losing nothing', async () => {
    setup({ store, topN: 1, passesMs: [5, 10, 5000] });
    await sched.startRound('T1', roundInfo('R1', ['g1']), null);
    src.push(upd('g1', E4, '1-0'));
    await poll(regularIdle);
    expect(await sched.requestDeep('T1', 'R1', 'g1')).toBe('ok');
    await until(() => deepSearch('g1', 0));
    await sched.engine!.stop(); // ply 0 ends early, recorded in the Current Round
    await until(() => deepSearch('g1', 1));
    expect(evalOf('g1', 0)?.ms).toBe(5000);
    await sched.setPasses([5, 10, 20]);
    await sched.startRound('T1', roundInfo('R2', ['h1']), null); // halts ply 1: requeued
    expect(sched.deep[0]).toMatchObject({ roundId: 'R1', left: 3 });
    await settled();
    expect(await fileMs('T1', 'R1', 'g1')).toEqual([5000, 20, 20, 20]);
    expect(state.round!.roundId).toBe('R2');
  });

  it('a Round under deep analysis that becomes current again opens with its deep evals and goes on there', async () => {
    const r1 = round('T1', 'R1', [board('g1', E4, { tracked: true })]);
    await store.saveRound(r1);
    setup({ store, topN: 1, passesMs: [5, 10, 5000] });
    expect(await sched.requestDeep('T1', 'R1', 'g1')).toBe('ok');
    await until(() => deepSearch('g1', 0));
    await sched.engine!.stop();
    await until(() => deepSearch('g1', 1));
    await sched.setPasses([5, 10, 20]);
    await sched.startRound('T1', roundInfo('R1', ['g1']), null, r1); // r1 is stale: the held copy is opened
    expect(evalOf('g1', 0)?.ms).toBe(5000);
    await settled();
    expect([0, 1, 2, 3].map((p) => evalOf('g1', p)?.ms)).toEqual([5000, 20, 20, 20]);
    expect(await fileMs('T1', 'R1', 'g1')).toEqual([5000, 20, 20, 20]);
  });

  it('removing the Event keeps its deep requests, and the engines while they last', async () => {
    setup({ store, topN: 1, passesMs: [5, 10, 5000] });
    await sched.startRound('T1', roundInfo('R1', ['g1']), null);
    src.push(upd('g1', E4, '1-0'));
    await poll(regularIdle);
    expect(await sched.requestDeep('T1', 'R1', 'g1')).toBe('ok');
    await until(() => deepSearch('g1', 0));
    await sched.setPasses([5, 10, 20]);
    await sched.removeEvent('T1'); // halts ply 0: its Round goes to the Archive
    expect(site.event('T1')).toBeUndefined();
    expect(sched.deep).toMatchObject([{ boardId: 'g1', left: 4 }]);
    expect(sched.copyState('main')).toBe('up');
    await settled();
    expect(await fileMs('T1', 'R1', 'g1')).toEqual([20, 20, 20, 20]);
    await poll(() => sched.copyState('main') === null);
  });

  it('a restart resumes each request where it was', async () => {
    await store.saveRound(round('T1', 'R0', [board('z1', E4)]));
    setup({ store, passesMs: [5, 10, 5000] });
    expect(await sched.requestDeep('T1', 'R0', 'z1')).toBe('ok');
    await until(() => deepSearch('z1', 0));
    await sched.engine!.stop(); // ply 0 ends early
    await until(() => deepSearch('z1', 1));
    await sched.stop();
    await site.saved();
    setup({ store, passesMs: [5, 10, 20], init: { state: await store.load() } });
    expect(sched.deep).toEqual([{ tourId: 'T1', roundId: 'R0', boardId: 'z1', board: 1, left: 3, total: 4 }]);
    await sched.resume();
    await settled();
    expect(await fileMs('T1', 'R0', 'z1')).toEqual([5000, 20, 20, 20]);
  });

  it('drops a restored request whose Round file is gone, and clamps the plies of another to its Board', async () => {
    await store.saveRound(round('T1', 'R0', [board('z1', E4)]));
    const req = (boardId: string, roundId: string, left: number[]) => ({
      tourId: 'T1',
      roundId,
      boardId,
      board: 1,
      at: 1,
      left,
      total: 4,
    });
    const init = { ...persisted([]), deep: [req('z1', 'R0', [2, 3, 9]), req('q1', 'R8', [0])] };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    setup({ store, passesMs: [5, 10, 20], init: { state: init } });
    await sched.resume();
    expect(sched.deep).toMatchObject([{ boardId: 'z1', left: 2 }]);
    await settled();
    expect(await fileMs('T1', 'R0', 'z1')).toEqual([null, null, 20, 20]);
  });

  it('cancel stops the running deep Job and drops the rest; the engines quit with nothing left', async () => {
    await store.saveRound(round('T1', 'R0', [board('z1', E4)]));
    setup({ store, passesMs: [5, 10, 5000] });
    expect(await sched.requestDeep('T1', 'R0', 'z1')).toBe('ok');
    await until(() => deepSearch('z1', 0));
    expect(await sched.cancelDeep('z1')).toBe(true);
    expect([sched.running, sched.deep, deepQueue()]).toEqual([null, [], []]);
    expect(sched.copyState('main')).toBeNull();
    expect(await sched.cancelDeep('z1')).toBe(false);
    expect(await fileMs('T1', 'R0', 'z1')).toEqual([null, null, null, null]);
  });

  it('a repeat request restarts the Board', async () => {
    await store.saveRound(round('T1', 'R0', [board('z1', E4)]));
    setup({ store, passesMs: [5, 10, 5000] });
    expect(await sched.requestDeep('T1', 'R0', 'z1')).toBe('ok');
    await until(() => deepSearch('z1', 0));
    await sched.engine!.stop();
    await until(() => deepSearch('z1', 1));
    t = 2000;
    expect(await sched.requestDeep('T1', 'R0', 'z1')).toBe('ok');
    expect(sched.deep).toMatchObject([{ left: 4, total: 4 }]);
    expect(site.deep[0].at).toBe(2000);
    await until(() => deepSearch('z1', 0));
  });

  it('gives up a ply that crashes the engine MAX_CRASHES times, never dead-lettered, and goes on', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await store.saveRound(round('T1', 'R0', [board('z1', E4)]));
    setup({ store, passesMs: [5, 10, 20], engineArgs: ['--crash-on', 'e2e4'] });
    expect(await sched.requestDeep('T1', 'R0', 'z1')).toBe('ok');
    await settled();
    expect(await fileMs('T1', 'R0', 'z1')).toEqual([20, null, 20, 20]);
    expect(state.dead).toEqual([]);
    expect(positions().filter((p) => p === 'position startpos moves e2e4')).toHaveLength(MAX_CRASHES);
  });
});
