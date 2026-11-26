import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { moveAccuracy } from '../shared/accuracy.js';
import { analyse } from '../shared/analysis.js';
import type { Eval, GameRef, Persisted } from '../shared/types.js';
import { Engine } from '../src/engine/engine.js';
import { Kibitzer, pvToSan, toScore } from '../src/kibitzer.js';
import type { GameUpdate } from '../src/lichess/stream.js';
import { State } from '../src/state.js';
import { ReplaySource } from './helpers/replay-source.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-uci.mjs', import.meta.url));
const ref: GameRef = { tourId: 't', roundId: 'r1', id: 'g1', white: { name: 'W' }, black: { name: 'B' } };
const MOVES = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5'];
const update = (n: number, result: GameUpdate['result'] = '*', uci = MOVES.slice(0, n)): GameUpdate => ({
  gameId: 'g1',
  white: ref.white,
  black: ref.black,
  uci,
  san: uci,
  clocks: uci.map(() => null),
  result,
  status: result === '*' ? 'ongoing' : 'finished',
});
const final = (cp: number): Eval => ({ score: { cp }, depth: 3, kind: 'final', bestmove: 'e2e4' }); // fake: cp 29 for the side to move
const backfill = (cp: number): Eval => ({ ...final(cp), kind: 'backfill' });

let dir: string, logFile: string, src: ReplaySource, sources: string[][], state: State, kib: Kibitzer;
const readLog = () => readFileSync(logFile, 'utf8').trim().split('\n');
const tail = (n: number) => readLog().slice(-n);
const goes = () => readLog().filter((l) => l === 'go infinite').length;
function setup(init: Persisted | null = null) {
  state = new State({ load: async () => null, save: async () => {} }, init);
  kib = new Kibitzer(state, {
    defaultEngine: { path: 'fake', options: { Hash: '64' } },
    launch: () => Engine.start(process.execPath, { args: [FAKE, '--log', logFile] }),
    source: (roundId) => (sources.push([roundId]), (src = new ReplaySource([]))),
    backfillMs: 5,
  });
}
const plies = () => state.game!.plies;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kibitzer-'));
  logFile = join(dir, 'uci.log');
  sources = [];
});
afterEach(async () => {
  await kib.clear();
  rmSync(dir, { recursive: true, force: true });
});

describe('Kibitzer', () => {
  it('backfills, then stops → records Final → searches each new Live position', async () => {
    setup();
    await kib.pick(ref);
    src.status('connected');
    src.push(update(2));
    await vi.waitFor(() => expect(goes()).toBe(1));
    expect(sources).toEqual([['r1']]);
    expect(state.snapshot().stream).toBe('connected');
    expect(readLog().slice(1)).toEqual([
      'setoption name Hash value 64',
      'isready',
      'position startpos',
      'go movetime 5',
      '> bestmove e2e4',
      'position startpos moves e2e4',
      'go movetime 5',
      '> bestmove e2e4',
      'position startpos moves e2e4 e7e5',
      'go infinite',
    ]);
    expect(plies().map((p) => p.eval)).toEqual([backfill(29), backfill(-29), null]); // White POV
    await vi.waitFor(() => expect(state.snapshot().live?.lines[0]).toEqual({ score: { cp: 29 }, depth: 3, san: [] }));
    src.push(update(3));
    await vi.waitFor(() => expect(goes()).toBe(2));
    expect(tail(4)).toEqual(['stop', '> bestmove e2e4', 'position startpos moves e2e4 e7e5 g1f3', 'go infinite']);
    expect(plies()[2].eval).toEqual(final(29));
    const n = readLog().length; // reconnect: the stream re-sends the same game; the Live search must be left alone
    src.status('reconnecting');
    src.push(update(3)); // serial worker: applied (as a no-op) before update(4), so no sleep needed
    src.push(update(4));
    await vi.waitFor(() => expect(goes()).toBe(3));
    expect(readLog().slice(n)).toEqual([
      'stop',
      '> bestmove e2e4',
      'position startpos moves e2e4 e7e5 g1f3 b8c6',
      'go infinite',
    ]);
    expect([plies()[3].eval, state.snapshot().stream]).toEqual([final(-29), 'reconnecting']);
    await vi.waitFor(() => expect(state.snapshot().live?.ply).toBe(4));
    const a = analyse(plies()); // Backfill excluded: only move 3 (Nf3), between two Final evals
    expect([a.fromMove, a.black]).toEqual([2, null]);
    expect(a.white).toBeCloseTo(moveAccuracy({ cp: 29 }, { cp: -29 }, 'white'), 10); // the fake flips POV each ply
  });

  it('retract: drops the stopped eval and re-searches the new position', async () => {
    setup();
    await kib.pick(ref);
    src.push(update(3));
    await vi.waitFor(() => expect(goes()).toBe(1));
    src.push(update(3, '*', ['e2e4', 'e7e5', 'b1c3']));
    await vi.waitFor(() => expect(goes()).toBe(2));
    expect(tail(3)).toEqual(['> bestmove e2e4', 'position startpos moves e2e4 e7e5 b1c3', 'go infinite']);
    expect(plies()[3]).toEqual({ move: { uci: 'b1c3', san: 'b1c3', clock: null }, eval: null });
    const engine = kib.engine!; // clear while Live kills the process
    await kib.clear();
    expect([state.site, engine.exited, kib.engine, tail(1)]).toEqual(['idle', true, null, ['quit']]);
  });

  it('game end stops the engine, records Final, then kills it (Finished has no process)', async () => {
    setup();
    await kib.pick(ref);
    src.push(update(1));
    await vi.waitFor(() => expect(goes()).toBe(1));
    const engine = kib.engine!;
    src.push(update(1, '0-1'));
    await vi.waitFor(() => expect(engine.exited).toBe(true));
    expect([state.site, kib.engine, state.snapshot().live, plies()[1].eval]).toEqual([
      'finished',
      null,
      null,
      final(-29),
    ]);
    expect(src.stopped).toBe(true);
    expect(tail(3)).toEqual(['stop', '> bestmove e2e4', 'quit']);
  });

  it('ignores other Boards of the Round', async () => {
    setup();
    await kib.pick(ref);
    src.push(update(1));
    await vi.waitFor(() => expect(goes()).toBe(1));
    const engine = kib.engine!;
    src.push({ ...update(3, '1-0'), gameId: 'other' });
    src.push(update(2));
    await vi.waitFor(() => expect(plies()).toHaveLength(3));
    expect([state.site, kib.engine === engine, engine.exited]).toEqual(['live', true, false]);
  });

  it('resume: keeps saved evals and backfills positions missed while down', async () => {
    const game = {
      ...ref,
      result: '*' as const,
      plies: [
        { move: null, eval: final(29) },
        { move: { uci: 'e2e4', san: 'e4', clock: null }, eval: null },
      ],
    };
    setup({ version: 1, engine: null, game });
    await kib.resume();
    src.push(update(3));
    await vi.waitFor(() => expect(goes()).toBe(1));
    expect(plies().map((p) => p.eval)).toEqual([final(29), backfill(-29), backfill(29), null]);
    expect(readLog().filter((l) => l.startsWith('position'))).toEqual([
      'position startpos moves e2e4',
      'position startpos moves e2e4 e7e5',
      'position startpos moves e2e4 e7e5 g1f3',
    ]);
  });

  it('a failed launch leaves the site Idle', async () => {
    setup();
    kib = new Kibitzer(state, { defaultEngine: { path: '/nonexistent/engine', options: {} } });
    await expect(kib.pick(ref)).rejects.toThrow();
    expect(state.site).toBe('idle');
  });

  it('maps scores to White POV and PVs to SAN', () => {
    expect([toScore({ unit: 'cp', value: 50 }, 1), toScore({ unit: 'mate', value: 3 }, 1)]).toEqual([
      { cp: -50 },
      { mate: -3 },
    ]);
    expect(toScore({ unit: 'mate', value: 0 }, 4)).toBeNull();
    expect(pvToSan('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', ['g1f3', 'g8f6', 'e1e8'])).toEqual([
      'Nf3',
      'Nf6',
    ]);
  });
});
