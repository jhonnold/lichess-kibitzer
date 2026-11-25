import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyse } from '../shared/analysis.js';
import type { Game, SseEvent, Snapshot } from '../shared/types.js';
import { Engine } from '../src/engine/engine.js';
import { startServer, type Running } from '../src/server.js';
import { fileStore } from '../src/store.js';
import { ReplaySource } from './helpers/replay-source.js';
import { sse } from './helpers/sse.js';

// PRD top-level test: real wiring (startServer), recorded round stream, fake UCI engine, assertions over SSE.
const FAKE = fileURLToPath(new URL('./fixtures/fake-uci.mjs', import.meta.url));
const PGN = fileURLToPath(new URL('./fixtures/lichess/round-stream.pgn', import.meta.url));
const ref = { tourId: 't', roundId: 'L3MX2oE3', id: 'at7GqSzo', white: { name: 'W' }, black: { name: 'B' } };

const WAIT = { timeout: 5000 }; // slow CI
let dir: string, logFile: string, src: ReplaySource, srv: Running;
const readLog = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n') : []);
const goes = () => readLog().filter((l) => l === 'go infinite').length;
const boot = () =>
  startServer({
    port: 0,
    store: fileStore(join(dir, 'state.json')),
    defaultEngine: { path: 'fake', options: {} },
    adminPassword: 'pw',
    kibitzer: {
      launch: () => Engine.start(process.execPath, { args: [FAKE, '--log', logFile] }),
      source: () => (src = ReplaySource.fromFile(PGN, ref.id)), // 4 updates: 52 → 55 moves
      backfillMs: 5,
    },
    app: { sse: { throttleMs: 20 } },
  });
async function admin(path: string, body?: object) {
  const base = `http://127.0.0.1:${srv.port}/api/admin`;
  const login = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"password":"pw"}',
  });
  const cookie = login.headers.getSetCookie()[0].split(';')[0];
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  expect(res.status).toBe(204);
}
/** Client-side rebuild: snapshot replaces everything, ply upserts. */
function view(events: SseEvent[]): Snapshot {
  let s: Snapshot | undefined;
  for (const e of events) {
    if (e.type === 'snapshot') s = e.snapshot;
    else if (e.type === 'ply') s!.game!.plies[e.index] = e.ply;
    else if (e.type === 'info') s!.live = e.live;
    else s!.stream = e.status;
  }
  return s!;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'e2e-'));
  logFile = join(dir, 'uci.log');
  srv = await boot();
});
afterEach(async () => {
  await srv.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

describe('live analysis over SSE', () => {
  it('Idle → pick → Backfill → Live moves → reconnect → game end → clear', async () => {
    const c = await sse(`http://127.0.0.1:${srv.port}/api/events`);
    await vi.waitFor(() => expect(view(c.events).site).toBe('idle'), WAIT);
    expect([srv.kibitzer.engine, existsSync(logFile)]).toEqual([null, false]); // Idle: no engine process ever spawned

    await admin('/pick', ref);
    src.status('connected');
    src.next(); // 52 moves: positions 0–51 Backfilled, 52 Live
    await vi.waitFor(() => expect(goes()).toBe(1), WAIT);
    expect(readLog().filter((l) => l === 'go movetime 5')).toHaveLength(52);
    await vi.waitFor(() => expect(view(c.events).live?.ply).toBe(52), WAIT);
    for (const n of [2, 3]) {
      const u = src.next()!; // one new move each
      await vi.waitFor(() => expect(goes()).toBe(n), WAIT);
      expect(readLog().slice(-4)).toEqual([
        'stop',
        '> bestmove e2e4',
        `position startpos moves ${u.uci.join(' ')}`,
        'go infinite',
      ]);
    }

    src.status('reconnecting');
    await vi.waitFor(() => expect(view(c.events).stream).toBe('reconnecting'), WAIT);
    src.status('connected');
    await vi.waitFor(() => expect(view(c.events).stream).toBe('connected'), WAIT);
    const c2 = await sse(`http://127.0.0.1:${srv.port}/api/events`); // Viewer reconnect: fresh snapshot = server state
    await vi.waitFor(() => expect(view(c2.events)).toEqual(srv.state.snapshot()), WAIT);
    await c2.close();

    const engine = srv.kibitzer.engine!;
    src.push({ ...src.updates[3], result: '0-1', status: 'finished' });
    await vi.waitFor(() => expect(view(c.events).site).toBe('finished'), WAIT);
    await vi.waitFor(() => expect(engine.exited).toBe(true), WAIT); // killed at game end
    expect(readLog().slice(-3)).toEqual(['stop', '> bestmove e2e4', 'quit']);
    expect(srv.kibitzer.engine).toBeNull();

    const game = view(c.events).game as Game;
    expect(game).toEqual(srv.state.snapshot().game); // the SSE stream alone rebuilds the server's game
    expect(game.plies.map((p) => p.eval?.kind ?? null)).toEqual([
      ...Array(52).fill('backfill'),
      'final',
      'final',
      'final',
      null, // 55 = final position: not searched
    ]);
    const a = analyse(game.plies); // Backfill excluded: only moves 53 and 54 are scored
    expect(a.fromMove).toBe(27);
    expect([a.white, a.black].every((x) => x !== null)).toBe(true);
    expect(a.marks.slice(0, 53).every((m) => m === null)).toBe(true);

    await admin('/clear');
    await vi.waitFor(() => expect(view(c.events).site).toBe('idle'), WAIT);
    expect(srv.kibitzer.engine).toBeNull();
    await c.close();
  });

  it('SIGTERM keeps the Live game; the next boot resumes it', async () => {
    await admin('/pick', ref);
    src.next();
    await vi.waitFor(() => expect(goes()).toBe(1), WAIT);
    const engine = srv.kibitzer.engine!;
    await srv.shutdown();
    expect(engine.exited).toBe(true);
    expect((await fileStore(join(dir, 'state.json')).load())?.game?.plies).toHaveLength(53);
    srv = await boot();
    expect([srv.state.site, srv.kibitzer.engine?.exited]).toEqual(['live', false]);
    src.next(); // fresh source replays from the first update
    await vi.waitFor(() => expect(goes()).toBe(2), WAIT);
  });
});
