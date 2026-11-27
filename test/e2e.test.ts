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

// Two more Events (8-char ids: the Archive's store scan and routes validate them). B replays A's updates on other games.
const TOUR_A = 'tourAAAA';
const TOUR_B = 'tourBBBB';
const ROUND_A = 'roundAAA';
const ROUND_B = 'roundBBB';
const IDS_B = IDS.map((id) => `x${id.slice(1)}`);
const roundOf = (tourId: string, id: string, ids: string[]): RoundInfo => ({
  ...ROUND_INFO,
  id,
  tourId,
  boards: ids.map((g, i) => ({
    ...ROUND_INFO.boards[i],
    id: g,
    name: g,
    white: { name: `W ${g}` },
    black: { name: `B ${g}` },
  })),
});
const eventOf = (id: string, round: string): EventInfo => ({
  id,
  name: `Event ${id}`,
  rounds: [{ id: round, name: 'Round 1', ongoing: true, finished: false }],
});
const EVENTS: Record<string, EventInfo> = { A: eventOf(TOUR_A, ROUND_A), B: eventOf(TOUR_B, ROUND_B) }; // by link
const ROUNDS: Record<string, RoundInfo> = {
  [ROUND_A]: roundOf(TOUR_A, ROUND_A, IDS),
  [ROUND_B]: roundOf(TOUR_B, ROUND_B, IDS_B),
};

const fetchEvent = vi.fn(async (link: string) => EVENTS[link] ?? EVENT);
const WAIT = { timeout: 15_000 }; // slow CI
const TEST_TIMEOUT = 30_000;
let dir: string, logFile: string, multiLog: string, cookie: string, src: ReplaySource, srv: Running;
const srcOf: Record<string, ReplaySource> = {}; // the source of each Round
/** The main copy's UCI log (multiLog: the multi copy's). */
const readLog = (file = logFile) => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n') : []);
const positions = () => readLog().filter((l) => l.startsWith('position startpos moves '));
const boot = async () => {
  cookie = '';
  return startServer({
    port: 0,
    store: dataStore(join(dir, 'state.json')),
    defaultEngine: engineConfig('fake'),
    adminPassword: 'pw',
    scheduler: {
      launch: (_cfg, role) =>
        Engine.start(process.execPath, { args: [FAKE, '--log', role === 'main' ? logFile : multiLog] }),
      source: (roundId) => {
        const all = ReplaySource.fromFile(PGN); // 3 Boards, 7 updates
        if (roundId === ROUND_B) all.updates.forEach((u) => void (u.gameId = IDS_B[IDS.indexOf(u.gameId)]));
        return (src = srcOf[roundId] = all);
      },
    },
    app: { sse: { throttleMs: 20 } },
    lichess: { fetchEvent, fetchRound: async (id: string) => ROUNDS[id] ?? ROUND_INFO, fetchRoundPgn: async () => '' },
  });
};
async function login() {
  const base = `http://127.0.0.1:${srv.port}/api/admin`;
  if (!cookie) {
    const res = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"password":"pw"}',
    });
    cookie = res.headers.getSetCookie()[0].split(';')[0];
  }
}
async function admin(method: 'POST' | 'PUT' | 'DELETE', path: string, body: object = {}) {
  await login();
  const base = `http://127.0.0.1:${srv.port}/api/admin`;
  const res = await fetch(base + path, {
    method,
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(204);
}
const track = () => admin('POST', '/event', { link: 'x', topN: 2 });
const replay = () => {
  for (let i = 0; i < 7; i++) src.next();
};
const tracked = (): Board[] => srv.state.primaryState!.round!.boards.filter((b) => b.tracked);
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
  multiLog = join(dir, 'multi.log');
  srv = await boot();
});
afterEach(async () => {
  await srv.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

const get = async (path: string) => {
  await login();
  return fetch(`http://127.0.0.1:${srv.port}${path}`, { headers: { Cookie: cookie } });
};
const boardIds = (s: Snapshot | null) => s?.round?.boards.map((b) => b.id);

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

      await admin('PUT', '/passes', { ms: null }); // job time unset: the Queue idles
      await track();
      await vi.waitFor(() => expect(c.events.at(-1)?.type).toBe('queue'), WAIT);
      const snap = await freshSnapshot();
      expect(snap.event).toEqual({ tourId: 't', name: 'Event', link: 'x' });
      expect(snap.round?.boards.map((b) => b.id)).toEqual(['gH77VTmz', 'at7GqSzo']); // Tracked, in Lichess order
      src.status('connected');
      replay();
      expect(readLog().filter((l) => l.startsWith('go'))).toEqual([]);

      await admin('PUT', '/passes', { ms: [5, null, null] });
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
      expect(readLog(multiLog).filter((l) => l.startsWith('position startpos moves '))).toEqual(positions()); // paired
      const qb = srv.state.primaryState!.board('qbPxmdQ2')!;
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

      await admin('DELETE', `/event/t`);
      await vi.waitFor(() => expect(rebuild(c.events)).toMatchObject({ event: null, round: null }), WAIT);
      expect(srv.scheduler.engine).toBeNull();
      await c.close();
    },
    TEST_TIMEOUT,
  );

  it(
    'a restart resumes the Current Round and finishes its evals',
    async () => {
      await admin('PUT', '/passes', { ms: [5, null, null] });
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
      expect([srv.state.primaryState?.round?.roundId, srv.scheduler.engine?.exited]).toEqual([ROUND, false]);
      expect(fetchEvent).toHaveBeenCalledTimes(1); // boot resumes following: one poll, no swap
      expect(srv.site.status('t')!.error).toBeNull();
      const kept = srv.state.primaryState!.round!.boards.flatMap((b) =>
        b.plies.filter((p) => p.eval?.kind === 'complete').map((p) => p.eval),
      );
      expect(kept).toEqual(expect.arrayContaining(before));
      replay(); // fresh source replays from the first update
      await vi.waitFor(() => expect([drained(), tracked().every(allComplete)]).toEqual([true, true]), WAIT);
    },
    TEST_TIMEOUT,
  );

  it(
    'two Events over SSE: each stream sees only its Boards; the Archive hides both Current Rounds',
    async () => {
      const url = `http://127.0.0.1:${srv.port}/api/events`;
      await admin('PUT', '/passes', { ms: [5, null, null] });
      await admin('POST', '/event', { link: 'A', topN: 2 });
      await admin('POST', '/event', { link: 'B', topN: 2 });
      const a = await sse(`${url}?tour=${TOUR_A}`);
      const b = await sse(`${url}?tour=${TOUR_B}`);
      const primary = await sse(url); // follows the Primary: A
      await vi.waitFor(() => expect([a, b, primary].every((c) => c.events.length >= 1)).toBe(true), WAIT);
      expect(srcOf[ROUND_A]).not.toBe(srcOf[ROUND_B]);
      for (const s of [ROUND_A, ROUND_B]) {
        srcOf[s].status('connected');
        for (let i = 0; i < 7; i++) srcOf[s].next();
      }
      const done = (t: string) => {
        const rs = srv.state.event(t)!;
        return rs.round!.boards.filter((x) => x.tracked).every(allComplete);
      };
      await vi.waitFor(() => expect([drained(), done(TOUR_A), done(TOUR_B)]).toEqual([true, true, true]), WAIT);

      for (const [c, t] of [
        [a, TOUR_A],
        [b, TOUR_B],
      ] as const)
        await vi.waitFor(() => expect(rebuild(c.events)).toEqual(srv.state.snapshot(t)), WAIT);
      expect(boardIds(rebuild(a.events))).toEqual(IDS.slice(0, 2));
      expect(boardIds(rebuild(b.events))).toEqual(IDS_B.slice(0, 2));
      // Boards only: the Queue (and a snapshot's copy of it) is site-wide
      const boards = (c: { events: SseEvent[] }) =>
        JSON.stringify(
          c.events.map((e) =>
            e.type === 'snapshot' ? e.snapshot.round : ['queue', 'search', 'events'].includes(e.type) ? null : e,
          ),
        );
      expect(boards(a)).not.toContain(IDS_B[0]); // never a Board of the other Event
      expect(boards(b)).not.toContain(IDS[0]);
      expect(rebuild(a.events)?.events.map((e) => [e.tourId, e.primary, e.live, e.tracked])).toEqual([
        [TOUR_A, true, true, 2],
        [TOUR_B, false, true, 2],
      ]);
      await vi.waitFor(() => expect(rebuild(primary.events)).toEqual(srv.state.snapshot(TOUR_A)), WAIT);

      const status = (await (await get('/api/admin/status')).json()) as {
        tracked: number;
        primary: string;
        events: { event: { tourId: string } }[];
      };
      expect([status.tracked, status.primary, status.events.map((e) => e.event.tourId)]).toEqual([
        4,
        TOUR_A,
        [TOUR_A, TOUR_B],
      ]);

      await srv.state.saved();
      const stored = (await dataStore(join(dir, 'state.json')).listRounds()).map((m) => m.roundId);
      expect(stored).toEqual(expect.arrayContaining([ROUND_A, ROUND_B])); // both on disk, both current
      const archive = await (await get('/api/archive')).text();
      expect([archive.includes(ROUND_A), archive.includes(ROUND_B)]).toEqual([false, false]);
      expect((await get(`/api/archive/${TOUR_A}/${ROUND_A}`)).status).toBe(404);
      expect((await get(`/api/archive/${TOUR_B}/${ROUND_B}`)).status).toBe(404);

      await admin('DELETE', `/event/${TOUR_A}`);
      await vi.waitFor(() => expect(rebuild(a.events)).toMatchObject({ event: null, round: null }), WAIT);
      await vi.waitFor(() => expect(rebuild(primary.events)?.event?.tourId).toBe(TOUR_B), WAIT); // rebound
      expect(srv.state.primary).toBe(TOUR_B);
      srcOf[ROUND_B].status('reconnecting');
      await vi.waitFor(() => expect(rebuild(b.events)?.stream).toBe('reconnecting'), WAIT);
      expect(rebuild(b.events)).toEqual(srv.state.snapshot(TOUR_B));
      expect(rebuild(b.events)?.events.map((e) => [e.tourId, e.primary])).toEqual([[TOUR_B, true]]);
      expect(boardIds(rebuild(b.events))).toEqual(IDS_B.slice(0, 2));
      for (const c of [a, b, primary]) await c.close();
    },
    TEST_TIMEOUT,
  );
});
