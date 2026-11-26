import { mkdtempSync, readFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Engine, probeEngine } from '../../src/engine/engine.js';
import type { UciInfo } from '../../src/engine/uci-parser.js';

const FAKE = fileURLToPath(new URL('../fixtures/fake-uci.mjs', import.meta.url));
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

let engine: Engine | undefined;
let logFile: string;
const start = (flags: string[] = [], timeoutMs = 2000) => {
  logFile = join(mkdtempSync(join(tmpdir(), 'fake-uci-')), 'log.txt');
  return Engine.start(process.execPath, { args: [FAKE, '--log', logFile, ...flags], timeoutMs }).then(
    (e) => (engine = e),
  );
};
const readLog = () => readFileSync(logFile, 'utf8').trim().split('\n');
/** Asserts each line appears in order (each after the previous match). */
const inOrder = (log: string[], seq: string[]) => {
  let from = 0;
  for (const line of seq) {
    const i = log.indexOf(line, from);
    expect(i, `missing "${line}" after line ${from}`).toBeGreaterThanOrEqual(from);
    from = i + 1;
  }
};

afterEach(async () => {
  await engine?.quit();
  engine = undefined;
});

describe('Engine', () => {
  it('handshakes and probes name and options', async () => {
    const e = await start();
    expect(e.name).toBe('FakeEngine');
    expect(e.options).toEqual(
      expect.arrayContaining([
        { name: 'Threads', type: 'spin', default: '1', min: 1, max: 512 },
        { name: 'Hash', type: 'spin', default: '16', min: 1, max: 33554432 },
        { name: 'MultiPV', type: 'spin', default: '1', min: 1, max: 256 },
        { name: 'Clear Hash', type: 'button' },
      ]),
    );
    expect(readLog()[0]).toBe('uci');

    const probed = await probeEngine(process.execPath, { args: [FAKE, '--log', logFile] });
    expect(probed).toEqual({ name: e.name, options: e.options });
    expect(readLog().at(-1)).toBe('quit');
  });

  it('rejects a non-UCI engine that never sends uciok', async () => {
    await expect(start(['--no-uciok'], 1000)).rejects.toThrow(/no uciok/);
  });

  it('rejects when the binary does not exist', async () => {
    await expect(Engine.start('/nonexistent/engine')).rejects.toThrow();
  });

  it('sends setoption and isready in order', async () => {
    const e = await start();
    e.setOption('Hash', 64);
    e.setOption('Clear Hash');
    await e.isReady();
    inOrder(readLog(), ['setoption name Hash value 64', 'setoption name Clear Hash', 'isready']);
  });

  it('runs a movetime search and emits scored info lines', async () => {
    const e = await start();
    const infos: UciInfo[] = [];
    e.on('info', (i) => infos.push(i));
    e.setOption('MultiPV', 2);

    const r = await e.search(['e2e4', 'e7e5'], { movetime: 30 });
    expect(r.bestmove).toBe('e2e4');
    expect(r.info).toEqual(expect.objectContaining({ depth: 3, multipv: 1, score: { unit: 'cp', value: 29 } }));
    expect(infos.some((i) => i.multipv === 2)).toBe(true);
    expect(infos.some((i) => i.score?.bound === 'lower')).toBe(true);
    expect(infos.every((i) => i.score !== undefined)).toBe(true);

    inOrder(readLog(), ['position startpos moves e2e4 e7e5', 'go movetime 30']);
    await e.search([], { movetime: 10 });
    inOrder(readLog(), ['position startpos']);
  });

  it('resolves an infinite search only when stopped', async () => {
    const e = await start();
    expect(await e.stop()).toBeUndefined();
    expect(readLog()).not.toContain('stop');

    const p = e.search([], 'infinite');
    let settled = false;
    p.then(() => (settled = true));
    await delay(50);
    expect(settled).toBe(false);

    const r = await e.stop();
    expect(r?.bestmove).toBe('e2e4');
    expect(await p).toEqual(r);
    inOrder(readLog(), ['go infinite', 'stop', '> bestmove e2e4']);
  });

  it('stop cancels queued searches too', async () => {
    const e = await start();
    void e.search([], 'infinite');
    const p2 = e.search(['d2d4'], 'infinite');
    await delay(50);
    expect(readLog()).not.toContain('position startpos moves d2d4');

    const r = await e.stop();
    expect(r?.bestmove).toBe('e2e4');
    await p2;
    expect(await e.stop()).toBeUndefined();

    inOrder(readLog(), [
      'go infinite',
      'stop',
      '> bestmove e2e4',
      'position startpos moves d2d4',
      'go infinite',
      'stop',
      '> bestmove e2e4',
    ]);
  });

  it('quit exits cleanly', async () => {
    const e = await start();
    const exit = once(e, 'exit');
    await e.quit();
    expect(e.exited).toBe(true);
    expect(await exit).toEqual([0, null]);
    expect(readLog().at(-1)).toBe('quit');
  });

  it('quit SIGKILLs an engine that ignores quit', async () => {
    const e = await start(['--ignore-quit']);
    const exit = once(e, 'exit');
    await e.quit(100);
    expect(await exit).toEqual([null, 'SIGKILL']);
  });

  it('rejects pending work when the engine crashes mid-search', async () => {
    const e = await start(['--exit-on-go']);
    const exit = once(e, 'exit');
    await expect(e.search([], 'infinite')).rejects.toThrow(/engine exited/);
    expect(await exit).toEqual([3, null]);
    await expect(e.isReady()).rejects.toThrow(/engine exited/);
  });

  it('keeps the last unbounded line of each multipv', async () => {
    const e = await start();
    e.setOption('MultiPV', 3);
    const r = await e.search(['e2e4', 'e7e5'], { movetime: 30 });
    expect(r.lines).toHaveLength(3);
    [1, 2, 3].forEach((k) => {
      expect(r.lines[k - 1]).toEqual(
        expect.objectContaining({ multipv: k, depth: 3, score: { unit: 'cp', value: 30 - k } }),
      );
      expect(r.lines[k - 1].score?.bound).toBeUndefined();
    });
    expect(r.info).toBe(r.lines[0]);
  });

  it('keeps lines to one search', async () => {
    const e = await start();
    e.setOption('MultiPV', 3);
    await e.search([], { movetime: 10 });

    e.setOption('MultiPV', 1);
    const r = await e.search([], { movetime: 10 });
    expect(r.lines).toEqual([expect.objectContaining({ multipv: 1, depth: 3 })]);

    e.setOption('MultiPV', 3);
    const p = e.search([], 'infinite');
    await delay(50);
    await e.stop();
    const stopped = await p;
    expect(stopped.lines.map((l) => l.multipv)).toEqual([1, 2, 3]);
  });

  it('--crash-on exits only on that position', async () => {
    const e = await start(['--crash-on', 'e2e4 e7e5']);
    const exit = once(e, 'exit');
    await expect(e.search(['e2e4'], { movetime: 10 })).resolves.toEqual(expect.objectContaining({ bestmove: 'e2e4' }));
    await expect(e.search(['e2e4', 'e7e5'], { movetime: 10 })).rejects.toThrow(/engine exited/);
    expect(await exit).toEqual([3, null]);
  });

  it('--ply-score derives the score from the move count', async () => {
    const e = await start(['--ply-score']);
    const first = await e.search([], { movetime: 10 });
    expect(first.info?.score).toEqual({ unit: 'cp', value: 29 });
    const second = await e.search(['e2e4', 'e7e5'], { movetime: 10 });
    expect(second.info?.score).toEqual({ unit: 'cp', value: 229 });
    expect(second.lines[0]).toBe(second.info);
  });
});
