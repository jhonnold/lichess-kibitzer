import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyse } from '../shared/analysis.js';
import { applyEvent } from '../shared/live.js';
import type { Board, Snapshot, SseEvent } from '../shared/types.js';
import { Engine } from '../src/engine/engine.js';
import type { Board as LichessBoard, EventInfo, RoundInfo } from '../src/lichess/api.js';
import { startServer, type Running } from '../src/server.js';
import { dataStore } from '../src/store.js';
import { ReplaySource } from './helpers/replay-source.js';
import { sse } from './helpers/sse.js';
import { engineConfig } from '../shared/engine-config.js';

// PRD top-level test: real wiring (startServer), recorded round stream, fake UCI engine, assertions over SSE.
const FAKE = fileURLToPath(new URL('./fixtures/fake-uci.mjs', import.meta.url));
const PGN = fileURLToPath(new URL('./fixtures/lichess/round-stream.pgn', import.meta.url));
const ROUND = 'L3MX2oE3';
const IDS = ['gH77VTmz', 'at7GqSzo', 'qbPxmdQ2']; // Lichess order; qbPxmdQ2 finishes 0-1
const EVENT: EventInfo = {
  id: 't',
  name: 'Event',
  rounds: [{ id: ROUND, name: 'Round 1', ongoing: true, finished: false }],
};
const ROUND_INFO: RoundInfo = {
  id: ROUND,
  name: 'Round 1',
  tourId: 't',
  boards: IDS.map((id): LichessBoard => ({
    id,
    name: id,
    white: { name: `W ${id}` },
    black: { name: `B ${id}` },
    result: '*',
  })),
};

const fetchEvent = vi.fn(async () => EVENT);
const WAIT = { timeout: 15_000 }; // slow CI
const TEST_TIMEOUT = 30_000;
let dir: string, logFile: string, cookie: string, src: ReplaySource, srv: Running;
const readLog = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n') : []);
const positions = () => readLog().filter((l) => l.startsWith('position startpos moves '));
const boot = async () => {
  cookie = '';
  return startServer({
    port: 0,
    store: dataStore(join(dir, 'state.json')),
    defaultEngine: engineConfig('fake'),
    adminPassword: 'pw',
    scheduler: {
      launch: () => Engine.start(process.execPath, { args: [FAKE, '--log', logFile] }),
      source: () => (src = ReplaySource.fromFile(PGN)), // 3 Boards, 7 updates
    },
    app: { sse: { throttleMs: 20 } },
    lichess: { fetchEvent, fetchRound: async () => ROUND_INFO },
  });
};
async function admin(method: 'POST' | 'PUT', path: string, body: object = {}) {
  const base = `http://127.0.0.1:${srv.port}/api/admin`;
  if (!cookie) {
    const login = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"password":"pw"}',
    });
    cookie = login.headers.getSetCookie()[0].split(';')[0];
  }
  const res = await fetch(base + path, {
    method,
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(204);
}
const track = () => admin('POST', '/event', { link: 'x' });
const replay = () => {
  for (let i = 0; i < 7; i++) src.next();
};
const tracked = (): Board[] => srv.state.round!.boards.filter((b) => b.tracked);
/** Every ply but a final position nobody can move from has a Complete eval. */
const allComplete = (b: Board) => b.plies.slice(0, -1).every((p) => p.eval?.kind === 'complete');
const drained = () => {
  const s = srv.state.snapshot();
  return s.queue.current.length === 0 && s.queue.backfill === 0 && s.search === null && srv.scheduler.running === null;
};
const rebuild = (events: SseEvent[]) => events.reduce<Snapshot | null>(applyEvent, null);
const freshSnapshot = async (): Promise<Snapshot> => {
  const c = await sse(`http://127.0.0.1:${srv.port}/api/events`);
  await vi.waitFor(() => expect(c.events).toHaveLength(1), WAIT);
  await c.close();
  return (c.events[0] as { snapshot: Snapshot }).snapshot;
};

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
  it(
    'Idle → track a Round → latest before Backfill → Complete evals → reconnect → clear',
    async () => {
      const c = await sse(`http://127.0.0.1:${srv.port}/api/events`);
      await vi.waitFor(
        () =>
          expect(c.events[0]).toEqual({ type: 'snapshot', snapshot: srv.state.snapshot(), now: expect.any(Number) }),
        WAIT,
      );
      expect(srv.state.snapshot()).toMatchObject({ event: null, round: null });
      expect([srv.scheduler.engine, existsSync(logFile)]).toEqual([null, false]); // Idle: no engine process ever spawned

      await admin('PUT', '/topn', { n: 2 });
      await admin('PUT', '/jobtime', { ms: null }); // job time unset: the Queue idles
      await track();
      await vi.waitFor(() => expect(c.events.at(-1)?.type).toBe('queue'), WAIT);
      const snap = await freshSnapshot();
      expect(snap.event).toEqual({ tourId: 't', name: 'Event', link: 'x' });
      expect(snap.round?.boards.map((b) => b.id)).toEqual(['gH77VTmz', 'at7GqSzo']); // Tracked, in Lichess order
      src.status('connected');
      replay();
      expect(readLog().filter((l) => l.startsWith('go'))).toEqual([]);

      await admin('PUT', '/jobtime', { ms: 5 });
      await vi.waitFor(() => expect(positions().length).toBeGreaterThanOrEqual(2), WAIT);
      const latest = (id: string) => src.updates.findLast((u) => u.gameId === id)!.uci.join(' ');
      expect(new Set(positions().slice(0, 2))).toEqual(
        new Set(['gH77VTmz', 'at7GqSzo'].map((id) => `position startpos moves ${latest(id)}`)),
      ); // latest positions first, Backfill after
      await vi.waitFor(() => expect([drained(), tracked().every(allComplete)]).toEqual([true, true]), WAIT);

      const lastTwo = ['gH77VTmz', 'at7GqSzo'].map((id) => `position startpos moves ${latest(id)}`);
      expect(
        positions()
          .slice(2)
          .filter((p) => lastTwo.includes(p)),
      ).toEqual([]); // each latest searched once, first
      const qb = srv.state.board('qbPxmdQ2')!;
      expect([qb.plies.length > 1, qb.tracked, qb.result]).toEqual([true, false, '0-1']); // recorded, not analysed
      expect((await freshSnapshot()).round?.boards.some((b) => b.id === qb.id)).toBe(false);
      expect(positions()).not.toContain(`position startpos moves ${latest(qb.id)}`);

      src.status('reconnecting');
      await vi.waitFor(async () => expect((await freshSnapshot()).stream).toBe('reconnecting'), WAIT);
      src.status('connected');
      await vi.waitFor(async () => expect((await freshSnapshot()).stream).toBe('connected'), WAIT);

      await vi.waitFor(() => expect(rebuild(c.events)).toEqual(srv.state.snapshot()), WAIT); // the stream alone rebuilds it
      for (const b of tracked()) {
        const a = analyse(b.plies);
        const mated = b.plies.at(-1)!.eval === null && b.result !== '*' ? 1 : 0; // no eval after the move into mate
        expect([a.scored, a.white !== null, a.black !== null]).toEqual([a.total - mated, true, true]);
      }

      await admin('POST', '/clear');
      await vi.waitFor(
        () => expect(c.events.at(-1)).toMatchObject({ type: 'snapshot', snapshot: { event: null, round: null } }),
        WAIT,
      );
      expect(srv.scheduler.engine).toBeNull();
      await c.close();
    },
    TEST_TIMEOUT,
  );

  it(
    'a restart resumes the Current Round and finishes its evals',
    async () => {
      await admin('PUT', '/jobtime', { ms: 5 });
      await track();
      replay();
      await vi.waitFor(
        () => expect(tracked().some((b) => b.plies.some((p) => p.eval?.kind === 'complete'))).toBe(true),
        WAIT,
      );
      const engine = srv.scheduler.engine!;
      await srv.shutdown();
      expect(engine.exited).toBe(true);
      const saved = await dataStore(join(dir, 'state.json')).loadRound('t', ROUND);
      expect(saved?.boards.find((b) => b.id === 'at7GqSzo')!.plies.length).toBeGreaterThan(1);
      const before = saved!.boards.flatMap((b) =>
        b.plies.filter((p) => p.eval?.kind === 'complete').map((p) => p.eval),
      );
      expect(before.length).toBeGreaterThan(0);

      fetchEvent.mockClear();
      srv = await boot();
      expect([srv.state.round?.roundId, srv.scheduler.engine?.exited]).toEqual([ROUND, false]);
      expect(fetchEvent).toHaveBeenCalledTimes(1); // boot resumes following: one poll, no swap
      expect(srv.follower.status.error).toBeNull();
      const kept = srv.state.round!.boards.flatMap((b) =>
        b.plies.filter((p) => p.eval?.kind === 'complete').map((p) => p.eval),
      );
      expect(kept).toEqual(expect.arrayContaining(before));
      replay(); // fresh source replays from the first update
      await vi.waitFor(() => expect([drained(), tracked().every(allComplete)]).toEqual([true, true]), WAIT);
    },
    TEST_TIMEOUT,
  );
});
