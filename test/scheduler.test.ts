import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as T from '../shared/types.js';
import { Engine } from '../src/engine/engine.js';
import type { RoundInfo } from '../src/lichess/api.js';
import type { GameUpdate } from '../src/lichess/stream.js';
import { RoundState } from '../src/round-state.js';
import { MAX_CRASHES, MIN_LIVE_SLICE_MS } from '../shared/queue.js';
import { RESTART_MIN_MS, Scheduler } from '../src/scheduler.js';
import { val } from './helpers/metric.js';
import { ReplaySource } from './helpers/replay-source.js';
import { evictions, jobDepth, jobDuration } from '../src/metrics.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-uci.mjs', import.meta.url));
const E4 = ['e2e4', 'e7e5', 'g1f3'];
const D4 = ['d2d4', 'd7d5', 'c2c4'];
const FOOLS = ['f2f3', 'e7e5', 'g2g4', 'd8h4'];

const roundInfo = (id: string, boards: string[]): RoundInfo => ({
  id,
  name: id,
  tourId: 'T1',
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

let dir: string, logFile: string, t: number;
let state: RoundState, sched: Scheduler, src: ReplaySource, sources: ReplaySource[], sourceIds: string[];
let engineArgs: string[]; // read per launch
let delays: number[]; // restart delays asked of `after`
let fire: (() => void)[]; // manual mode: timers waiting to be fired by hand
let slices: { ms: number; fn: () => void }[]; // live slice timers, fired by hand

function setup(
  opts: {
    jobTimeMs?: number | null;
    topN?: number;
    engineArgs?: string[];
    manual?: boolean; // restart timers wait in `fire` instead of running at once
    launch?: (real: () => Promise<Engine>) => Promise<Engine>;
    init?: ConstructorParameters<typeof RoundState>[1];
    fetchOpening?: (uci: readonly string[]) => Promise<string | null>;
  } = {},
) {
  state = new RoundState(
    { load: async () => null, save: async () => {}, loadRound: async () => null, saveRound: async () => {} },
    opts.init,
  );
  if (opts.init === undefined) state.setTopN(opts.topN ?? 3);
  state.setJobTime(opts.jobTimeMs === undefined ? 15 : opts.jobTimeMs);
  engineArgs = opts.engineArgs ?? [];
  const real = () => Engine.start(process.execPath, { args: [FAKE, '--log', logFile, '--ply-score', ...engineArgs] });
  sched = new Scheduler(state, {
    defaultEngine: { path: 'fake', options: { MultiPV: '3' } },
    launch: () => (opts.launch ? opts.launch(real) : real()),
    after: (ms, fn) => {
      delays.push(ms);
      if (opts.manual) return (fire.push(fn), () => {});
      const h = setTimeout(fn, 0);
      return () => clearTimeout(h);
    },
    afterSlice: (ms, fn) => (slices.push({ ms, fn }), () => {}),
    source: (id) => (sourceIds.push(id), sources.push((src = new ReplaySource([]))), src),
    now: () => t,
    fetchOpening: opts.fetchOpening,
  });
}
const readLog = () => readFileSync(logFile, 'utf8').trim().split('\n');
const positions = () => readLog().filter((l) => l.startsWith('position '));
const count = (cmd: string) => readLog().filter((l) => l === cmd || l.startsWith(cmd + ' ')).length;
const evalOf = (id: string, ply: number) => state.board(id)!.plies[ply].eval;
const complete = (id: string, ply: number) => evalOf(id, ply)?.kind === 'complete';
const queueView = () => state.snapshot().queue;
const searching = (id: string, ply: number) => {
  const s = state.snapshot().search;
  return s?.boardId === id && s.ply === ply;
};

/** Resolves once pred holds: checked now, then on every state event. */
function until(pred: () => boolean, ms = 2000): Promise<void> {
  if (pred()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (!pred()) return;
      clearTimeout(timer);
      state.off('event', check);
      resolve();
    };
    const timer = setTimeout(() => {
      state.off('event', check);
      reject(new Error('until: timeout'));
    }, ms);
    state.on('event', check);
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
  sources = [];
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
    await sched.startRound(roundInfo('R1', ['g1', 'g2', 'g3']), null);
    src.push(upd('g1', E4));
    src.push(upd('g2', D4.slice(0, 2)));
    await sched.setJobTime(15);
    await idle();
    expect(positions().slice(0, 2)).toEqual([
      `position startpos moves ${E4.join(' ')}`,
      'position startpos moves d2d4 d7d5',
    ]);
    expect(complete('g1', 0) && complete('g1', 1) && complete('g2', 0) && complete('g2', 1)).toBe(true);
  });

  it('observes job duration and depth for each recorded Eval', async () => {
    const count = async (m: typeof jobDuration | typeof jobDepth) => {
      const one = (tier: string) => val(m, { tier, kind: 'complete' }, `${m.name}_count`);
      return (await one('current')) + (await one('backfill'));
    };
    const [d0, p0] = [await count(jobDuration), await count(jobDepth)];
    setup();
    await sched.startRound(roundInfo('R1', ['g1']), null);
    src.push(upd('g1', E4));
    await idle();
    const done = [0, 1, 2, 3].filter((p) => complete('g1', p)).length;
    expect(done).toBeGreaterThanOrEqual(1);
    expect((await count(jobDuration)) - d0).toBeGreaterThanOrEqual(done);
    expect((await count(jobDepth)) - p0).toBeGreaterThanOrEqual(done);
  });

  it('keeps Job timing over Complete Jobs', async () => {
    setup();
    await sched.startRound(roundInfo('R1', ['g1']), null);
    src.push(upd('g1', E4));
    await idle();
    const done = [0, 1, 2, 3].filter((p) => complete('g1', p)).length;
    const { jobs, ms, depth } = sched.timing;
    expect(jobs).toBeGreaterThanOrEqual(done);
    expect(ms!.p50).toBeGreaterThanOrEqual(0);
    expect(depth!.p50).toBeGreaterThan(0);
  });

  it('runs the longest-waiting Board first', async () => {
    setup();
    await sched.startRound(roundInfo('R1', ['g1', 'g2']), null);
    await idle();
    await sched.setJobTime(null);
    t = 100;
    src.push(upd('g2', D4));
    t = 200;
    src.push(upd('g1', E4));
    const before = positions().length;
    await sched.setJobTime(15);
    await idle();
    expect(positions()[before]).toBe(`position startpos moves ${D4.join(' ')}`);
    expect(positions()[before + 1]).toBe(`position startpos moves ${E4.join(' ')}`);
  });

  it('pre-empts a backfill Job for a new current one', async () => {
    setup({ topN: 1 });
    await sched.startRound(roundInfo('R1', ['g1']), null);
    src.push(upd('g1', E4.slice(0, 2)));
    await until(() => searching('g1', 2));
    await sched.setJobTime(5000); // applies to the next Job: the ply 1 backfill
    await until(() => searching('g1', 1));
    await sched.setJobTime(15);
    src.push(upd('g1', E4));
    await until(() => evalOf('g1', 1)?.kind === 'provisional');
    await until(() => complete('g1', 1));
    expect(readLog()).toContain('stop');
    expect(complete('g1', 3)).toBe(true);
  });

  it('evicts a live Job at once when its Board moves, and searches the old position again in full', async () => {
    setup({ topN: 1, jobTimeMs: 5000 });
    await sched.startRound(roundInfo('R1', ['g1']), null);
    src.push(upd('g1', E4.slice(0, 1)));
    await until(() => searching('g1', 1));
    const stale0 = await val(evictions, { reason: 'stale' });
    src.push(upd('g1', E4.slice(0, 2)));
    await until(() => searching('g1', 2));
    expect(evalOf('g1', 1)?.kind).toBe('provisional');
    expect((await val(evictions, { reason: 'stale' })) - stale0).toBe(1);
    await sched.setJobTime(15);
    await sched.engine!.stop(); // cut short the ply 2 search, started at 5000 ms
    await until(() => complete('g1', 1) && complete('g1', 2));
  });

  it('lets a live Job run its slice, then evicts it for another live position', async () => {
    const live0 = await val(evictions, { reason: 'live' });
    setup({ topN: 2, jobTimeMs: 5000 });
    await sched.startRound(roundInfo('R1', ['g1', 'g2']), null);
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
    expect(state.snapshot().search?.tier).toBe('current');
    expect((await val(evictions, { reason: 'live' })) - live0).toBe(1);
    await sched.setJobTime(15);
    await sched.engine!.stop(); // cut short g2's search, started at 5000 ms
    await until(() => searching('g1', 0));
    expect(state.snapshot().search?.tier).toBe('backfill');
    await until(() => complete('g1', 0));
    expect(queueView().deferred).toEqual([]);
  });

  it('gives no slice when the job time is the slice or shorter', async () => {
    setup({ topN: 2, jobTimeMs: MIN_LIVE_SLICE_MS });
    await sched.startRound(roundInfo('R1', ['g1', 'g2']), null);
    await until(() => searching('g1', 0));
    expect(slices).toEqual([]);
  });

  it('records the engine lines White POV', async () => {
    setup({ topN: 1 });
    await sched.startRound(roundInfo('R1', ['g1']), null);
    src.push(upd('g1', []));
    await until(() => complete('g1', 0));
    const e = evalOf('g1', 0)!;
    expect(e.lines).toHaveLength(3);
    expect(e.lines[0]).toEqual({ score: { cp: 29 }, depth: 3, move: 'e2e4', san: ['e4', 'e5'] });
    expect(e.lines[1].score).toEqual({ cp: 28 });
    expect(e.score).toEqual(e.lines[0].score);
    expect(e.bestmove).toBe('e2e4');
    src.push(upd('g1', ['e2e4']));
    await until(() => complete('g1', 1));
    expect(evalOf('g1', 1)!.score).toEqual({ cp: -129 });
  });

  it('searches a corrected latest move again', async () => {
    setup({ topN: 1 });
    await sched.startRound(roundInfo('R1', ['g1']), null);
    src.push(upd('g1', E4));
    await idle();
    src.push(upd('g1', ['e2e4', 'e7e5', 'b1c3']));
    await until(() => complete('g1', 3));
    expect(positions()).toContain('position startpos moves e2e4 e7e5 b1c3');
  });

  it('requeues a Job whose position a correction made stale', async () => {
    setup({ topN: 1, jobTimeMs: 150 });
    await sched.startRound(roundInfo('R1', ['g1']), null);
    src.push(upd('g1', E4.slice(0, 1)));
    await until(() => searching('g1', 1));
    src.push(upd('g1', E4.slice(0, 2)));
    src.push(upd('g1', ['e2e4', 'c7c5'])); // ply 1 is kept, but the epoch changes under its Job
    await sched.setJobTime(15);
    await until(() => complete('g1', 1) && complete('g1', 2));
    expect(positions()).toContain('position startpos moves e2e4 c7c5');
  });

  it('takes the opening from the PGN tags and asks the explorer only for untagged Tracked Boards', async () => {
    const asked: string[][] = [];
    setup({ jobTimeMs: null, topN: 1, fetchOpening: async (uci) => (asked.push([...uci]), "C20 King's Pawn Game") });
    await sched.startRound(roundInfo('R1', ['g1', 'g2', 'g3']), null);
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
    await sched.startRound(roundInfo('R1', ['g1']), null);
    src.push(upd('g1', E4));
    expect(state.board('g1')?.opening).toBeNull();
  });

  it('records every Board but only searches Tracked ones', async () => {
    setup({ topN: 1 });
    await sched.startRound(roundInfo('R1', ['g1', 'g2']), null);
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
    await sched.startRound(roundInfo('R1', ['g1']), null);
    src.push(upd('g1', E4.slice(0, 1)));
    expect(queueView().current).toEqual([{ boardId: 'g1', ply: 1 }]);
    await new Promise((r) => setTimeout(r, 50)); // negative assertion: nothing may start
    expect(count('go')).toBe(0);
    await sched.setJobTime(15);
    await until(() => complete('g1', 1) && complete('g1', 0));
  });

  it('evaluates a finished Board and skips mate positions', async () => {
    setup({ topN: 2 });
    await sched.startRound(roundInfo('R1', ['g1', 'g2']), null);
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
    setup({ topN: 2, jobTimeMs: 5000 });
    await sched.startRound(roundInfo('R1', ['g1', 'g2']), null);
    await until(() => searching('g1', 0));
    const old = src;
    const t0 = Date.now();
    await sched.startRound(roundInfo('R2', ['h1', 'h2']), null);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(old.stopped).toBe(true);
    expect(sourceIds).toEqual(['R1', 'R2']);
    expect(state.round!.roundId).toBe('R2');
    const ids = [...queueView().current.map((j) => j.boardId), sched.running?.boardId];
    expect(ids.every((id) => id === 'h1' || id === 'h2')).toBe(true);
  });

  it('untracking a Board removes its Jobs', async () => {
    setup({ topN: 2, jobTimeMs: null });
    await sched.startRound(roundInfo('R1', ['g1', 'g2']), null);
    src.push(upd('g1', E4.slice(0, 1)));
    src.push(upd('g2', D4));
    await sched.setTracked(['g1']);
    expect(queueView()).toEqual({ current: [{ boardId: 'g1', ply: 1 }], backfill: 1, deferred: [] });
    await sched.setJobTime(15);
    await idle();
    expect(complete('g1', 1)).toBe(true);
    expect(positions().some((p) => p.includes('d2d4'))).toBe(false);
  });

  it('tracking a Board searches its earlier plies too', async () => {
    setup({ topN: 1 });
    await sched.startRound(roundInfo('R1', ['g1', 'g2']), null);
    src.push(upd('g2', D4));
    await idle();
    await sched.setTracked(['g1', 'g2']);
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
    const settings: T.Settings = { event: null, engine: null, jobTimeMs: null, topN: 1 };
    setup({ jobTimeMs: null, init: { state: { version: 2, settings, current: null, dead: [] }, round } });
    await sched.resume();
    expect(sourceIds).toEqual(['R1']);
    expect(queueView()).toEqual({ current: [{ boardId: 'g1', ply: 2 }], backfill: 1, deferred: [] });
    await sched.setJobTime(15);
    await idle();
    expect(complete('g1', 1) && complete('g1', 2)).toBe(true);
    expect(readLog()).not.toContain('position startpos');
  });

  it('setEngine restarts the engine and requeues the running Job', async () => {
    setup({ topN: 1, jobTimeMs: 5000 });
    await sched.startRound(roundInfo('R1', ['g1']), null);
    await until(() => searching('g1', 0));
    await sched.setJobTime(null); // keep the requeued Job from starting on the new engine
    await sched.setEngine({ path: 'fake', options: { MultiPV: '2' } });
    expect(count('uci')).toBe(2);
    expect(readLog()).toContain('setoption name MultiPV value 2');
    expect(sched.running).toBeNull();
    expect(queueView().current).toEqual([{ boardId: 'g1', ply: 0 }]);
    await sched.setJobTime(15);
    await until(() => complete('g1', 0));
    expect(evalOf('g1', 0)!.lines).toHaveLength(2);
  });

  it('restarts a crashed engine and carries on with the other Jobs', async () => {
    setup({ topN: 2, engineArgs: ['--crash-on', 'e2e4'] });
    await sched.startRound(roundInfo('R1', ['g1', 'g2']), null);
    src.push(upd('g1', E4.slice(0, 1)));
    src.push(upd('g2', D4));
    await until(() => [0, 1, 2, 3].every((i) => complete('g2', i)));
    expect(count('uci')).toBeGreaterThanOrEqual(2);
    expect(count('setoption name MultiPV value 3')).toBeGreaterThanOrEqual(2); // options applied again on relaunch
    await poll(() => sched.engineState === 'up');
    expect(delays[0]).toBe(RESTART_MIN_MS);
    expect(sched.restarts).toBeGreaterThanOrEqual(1);
  });

  describe('Dead-letter queue', () => {
    const E4_POS = 'position startpos moves e2e4';
    async function crashing(): Promise<void> {
      setup({ topN: 1, engineArgs: ['--crash-on', 'e2e4'] });
      await sched.startRound(roundInfo('R1', ['g1']), null);
      src.push(upd('g1', E4.slice(0, 1)));
      await until(() => state.dead.length === 1 && complete('g1', 0));
    }

    it('takes a position that crashed the engine three times, and moves on', async () => {
      await crashing();
      expect(state.dead.map(({ boardId, ply }) => ({ boardId, ply }))).toEqual([{ boardId: 'g1', ply: 1 }]);
      expect(evalOf('g1', 1)).toBeNull();
      expect(queueView().current).toEqual([]);
      expect(positions().filter((p) => p === E4_POS)).toHaveLength(MAX_CRASHES);
      expect(delays).toEqual([1000, 2000, 4000]);
    });

    it('searches a requeued entry again', async () => {
      await crashing();
      engineArgs = [];
      await sched.setEngine({ path: 'fake', options: {} });
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
      await sched.startRound(roundInfo('R2', ['h1']), null);
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
      const settings: T.Settings = { event: null, engine: null, jobTimeMs: null, topN: 1 };
      const dead = [{ boardId: 'g1', board: 1, ply: 1, at: 5 }];
      setup({ jobTimeMs: null, init: { state: { version: 2, settings, current: null, dead }, round } });
      await sched.resume();
      expect(queueView()).toEqual({ current: [], backfill: 1, deferred: [] });
      expect(state.dead).toEqual(dead);
      await sched.setJobTime(15);
      await idle();
      expect(complete('g1', 0)).toBe(true);
      expect(positions().some((p) => p.includes('e2e4'))).toBe(false);
    });
  });

  describe('restart backoff', () => {
    it('doubles up to the cap', async () => {
      setup({ topN: 3, engineArgs: ['--exit-on-go'] });
      await sched.startRound(roundInfo('R1', ['g1', 'g2', 'g3']), null);
      await until(() => state.dead.length === 3);
      await poll(() => delays.length === 9);
      expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
      expect(sched.restarts).toBe(9);
    });

    it('starts over after a Job completes', async () => {
      setup({ topN: 2, jobTimeMs: null, engineArgs: ['--crash-on', 'e2e4'] });
      await sched.startRound(roundInfo('R1', ['g1', 'g2']), null);
      src.push(upd('g1', E4.slice(0, 1)));
      await sched.setJobTime(15);
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
      await sched.startRound(roundInfo('R1', ['g1']), null); // does not throw
      expect(sched.engineState).toBe('restarting');
      await poll(() => sched.engineState === 'up');
      expect(delays).toEqual([1000, 2000]);
      await until(() => complete('g1', 0));
    });
  });

  describe('engine exit with no running Job', () => {
    it('restarts without counting a crash', async () => {
      setup({ topN: 1, jobTimeMs: null, engineArgs: ['--crash-on', 'e2e4'] });
      await sched.startRound(roundInfo('R1', ['g1']), null);
      await sched.engine!.quit();
      await poll(() => sched.engineState === 'up' && count('uci') === 2);
      expect(delays).toEqual([1000]);
      expect(state.dead).toEqual([]);
      src.push(upd('g1', E4.slice(0, 1)));
      await sched.setJobTime(15);
      await until(() => state.dead.length === 1);
      expect(positions().filter((p) => p === 'position startpos moves e2e4')).toHaveLength(MAX_CRASHES);
    });

    it('is not relaunched twice when a config change got there first', async () => {
      setup({ jobTimeMs: null, manual: true });
      await sched.startRound(roundInfo('R1', ['g1']), null);
      await sched.engine!.quit();
      await poll(() => fire.length === 1);
      expect(sched.engineState).toBe('restarting');
      await sched.setEngine({ path: 'fake', options: {} });
      expect(sched.engineState).toBe('up');
      fire[0]();
      await sched.setJobTime(null); // waits for the timer's turn on the serial chain
      expect(count('uci')).toBe(2);
    });

    it('is not relaunched after stop()', async () => {
      setup({ jobTimeMs: null, manual: true });
      await sched.startRound(roundInfo('R1', ['g1']), null);
      await sched.engine!.quit();
      await poll(() => fire.length === 1);
      await sched.stop();
      fire[0]();
      await sched.setJobTime(null);
      expect([count('uci'), sched.engineState]).toEqual([1, null]);
    });
  });
});
