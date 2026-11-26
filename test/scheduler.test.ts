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
import { Scheduler } from '../src/scheduler.js';
import { ReplaySource } from './helpers/replay-source.js';

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
  result,
  status: result === '*' ? 'ongoing' : 'finished',
});

let dir: string, logFile: string, t: number;
let state: RoundState, sched: Scheduler, src: ReplaySource, sources: ReplaySource[], sourceIds: string[];

function setup(
  opts: {
    jobTimeMs?: number | null;
    topN?: number;
    engineArgs?: string[];
    init?: ConstructorParameters<typeof RoundState>[1];
  } = {},
) {
  state = new RoundState(
    { load: async () => null, save: async () => {}, loadRound: async () => null, saveRound: async () => {} },
    opts.init,
  );
  if (opts.init === undefined) state.setTopN(opts.topN ?? 3);
  state.setJobTime(opts.jobTimeMs === undefined ? 15 : opts.jobTimeMs);
  sched = new Scheduler(state, {
    defaultEngine: { path: 'fake', options: { MultiPV: '3' } },
    launch: () =>
      Engine.start(process.execPath, { args: [FAKE, '--log', logFile, '--ply-score', ...(opts.engineArgs ?? [])] }),
    source: (id) => (sourceIds.push(id), sources.push((src = new ReplaySource([]))), src),
    now: () => t,
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
const idle = () =>
  until(() => sched.running === null && queueView().current.length === 0 && queueView().backfill === 0);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scheduler-'));
  logFile = join(dir, 'uci.log');
  sources = [];
  sourceIds = [];
  t = 1000;
});
afterEach(async () => {
  await sched.stop();
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

  it('never interrupts a current-tier Job', async () => {
    setup({ topN: 1, jobTimeMs: 150 });
    await sched.startRound(roundInfo('R1', ['g1']), null);
    src.push(upd('g1', E4.slice(0, 1)));
    await until(() => searching('g1', 1));
    src.push(upd('g1', E4.slice(0, 2)));
    await until(() => complete('g1', 1));
    await until(() => complete('g1', 2));
    expect(readLog()).not.toContain('stop');
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
    expect(queueView()).toEqual({ current: [{ boardId: 'g1', ply: 1 }], backfill: 1 });
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
    expect(queueView()).toEqual({ current: [{ boardId: 'g1', ply: 2 }], backfill: 1 });
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

  it('requeues the Job when the engine exits', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    setup({ topN: 1, engineArgs: ['--crash-on', 'e2e4'] });
    await sched.startRound(roundInfo('R1', ['g1']), null);
    src.push(upd('g1', E4.slice(0, 1)));
    await until(() => sched.engine === null && queueView().current.length === 1);
    expect(queueView().current).toEqual([{ boardId: 'g1', ply: 1 }]);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });
});
