import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoundSummary } from '../src/lichess/api.js';
import { Engine } from '../src/engine/engine.js';
import { Follower, POLL_MS } from '../src/follower.js';
import { LichessError, type EventInfo, type RoundInfo } from '../src/lichess/api.js';
import { RoundState } from '../src/round-state.js';
import { Scheduler } from '../src/scheduler.js';
import { dataStore, type DataStore } from '../src/store.js';
import { followerPolls } from '../src/metrics.js';
import { val } from './helpers/metric.js';
import { ReplaySource } from './helpers/replay-source.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-uci.mjs', import.meta.url));
const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;
const LINK = 'https://lichess.org/broadcast/x/T1';

let dir: string, store: DataStore, t: number;
let state: RoundState, sched: Scheduler, follower: Follower;
let rounds: RoundSummary[];
let boardsOf: Record<string, string[]>;
let events: Record<string, EventInfo>;
let sourceIds: string[];
let fetchEvent: ReturnType<typeof vi.fn<(link: string) => Promise<EventInfo>>>;
let every: ReturnType<typeof vi.fn<(ms: number, fn: () => void) => () => void>>;
let cancel: ReturnType<typeof vi.fn<() => void>>;
let live: { sched: Scheduler; follower: Follower }[];

const tourOf = (id: string) => (id.startsWith('B') ? 'T2' : 'T1');
const roundInfo = (id: string): RoundInfo => ({
  id,
  name: id,
  tourId: tourOf(id),
  boards: (boardsOf[id] ?? [`${id}a`, `${id}b`, `${id}c`]).map((b) => ({
    id: b,
    name: b,
    white: { name: `W${b}` },
    black: { name: `B${b}` },
    result: '*',
  })),
});

function build(s: RoundState) {
  const sc = new Scheduler(s, {
    defaultEngine: { path: 'fake', options: {} },
    launch: () => Engine.start(process.execPath, { args: [FAKE, '--ply-score'] }),
    source: (id) => (sourceIds.push(id), new ReplaySource([])),
    now: () => t,
  });
  const f = new Follower(s, sc, {
    lichess: { fetchEvent, fetchRound: async (id) => roundInfo(id) },
    store,
    now: () => t,
    every,
  });
  live.push({ sched: sc, follower: f });
  return { sc, f };
}

const idle = async () => {
  for (let i = 0; i < 400; i++) {
    const q = state.snapshot().queue;
    if (sched.running === null && !q.current.length && !q.backfill) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('idle: timeout');
};
const complete = (id: string) => state.board(id)!.plies[0].eval?.kind === 'complete';
const roundId = () => state.round?.roundId;
const polls = async () => [await val(followerPolls, { outcome: 'ok' }), await val(followerPolls, { outcome: 'error' })];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'follower-'));
  store = dataStore(join(dir, 'state.json'));
  t = T0;
  sourceIds = [];
  live = [];
  boardsOf = {};
  rounds = [
    { id: 'R1', name: 'Round 1', ongoing: true, finished: false, startsAt: T0 },
    { id: 'R2', name: 'Round 2', ongoing: false, finished: false, startsAt: T0 + HOUR },
  ];
  events = {
    [LINK]: {
      id: 'T1',
      name: 'Event 1',
      get rounds() {
        return rounds;
      },
    },
    other: { id: 'T2', name: 'Event 2', rounds: [{ id: 'B1', name: 'B1', ongoing: true, finished: false }] },
  };
  fetchEvent = vi.fn(async (link: string) => events[link]);
  cancel = vi.fn();
  every = vi.fn(() => cancel);
  state = new RoundState(store);
  state.setTopN(2);
  state.setJobTime(15);
  ({ sc: sched, f: follower } = build(state));
});
afterEach(async () => {
  for (const l of live) {
    await l.follower.stop();
    await l.sched.stop();
  }
  await state.saved();
  rmSync(dir, { recursive: true, force: true });
});

describe('Follower', () => {
  it('registers: picks the ongoing Round, tracks the first N and reports the next', async () => {
    await follower.register(LINK);
    expect(roundId()).toBe('R1');
    expect(state.round!.boards.filter((b) => b.tracked)).toHaveLength(2);
    expect(follower.status).toMatchObject({
      next: { roundId: 'R2', name: 'Round 2', startsAt: T0 + HOUR },
      swapAt: T0 + HOUR - 600_000,
      polledAt: T0,
      error: null,
    });
    await follower.register(LINK);
    expect(every).toHaveBeenCalledTimes(1);
    expect(every).toHaveBeenCalledWith(POLL_MS, expect.any(Function));
  });

  it('swaps 10 minutes before the next Round starts; the old Round file keeps its evals', async () => {
    await follower.register(LINK);
    await idle();
    const swapAt = follower.status.swapAt!;
    t = swapAt - 1;
    await follower.tick();
    expect(roundId()).toBe('R1');
    t = swapAt;
    await follower.tick();
    expect(roundId()).toBe('R2');
    expect(sourceIds).toEqual(['R1', 'R2']);
    expect(state.round!.startsAt).toBe(T0 + HOUR);
    expect(follower.status.next).toBeNull();
    await state.saved();
    const file = JSON.parse(readFileSync(join(dir, 'rounds/T1/R1.json'), 'utf8'));
    expect(file.boards[0].plies[0].eval.kind).toBe('complete');
  });

  it('starts the next Round from the default tracked set', async () => {
    await follower.register(LINK);
    await sched.setTracked(['R1c']);
    t = follower.status.swapAt!;
    await follower.tick();
    expect(state.round!.boards.filter((b) => b.tracked).map((b) => b.id)).toEqual(['R2a', 'R2b']);
  });

  it('never goes back to an earlier Round', async () => {
    await follower.register(LINK);
    t = follower.status.swapAt!;
    await follower.tick();
    rounds[0].ongoing = true;
    await follower.tick();
    expect(roundId()).toBe('R2');
  });

  it('without startsAt, swaps only when Lichess reports the Round ongoing', async () => {
    rounds[1] = { id: 'R2', name: 'Round 2', ongoing: false, finished: false };
    await follower.register(LINK);
    expect(follower.status).toMatchObject({ next: { roundId: 'R2', startsAt: null }, swapAt: null });
    t = T0 + 99 * HOUR;
    await follower.tick();
    expect(roundId()).toBe('R1');
    rounds[1].ongoing = true;
    await follower.tick();
    expect(roundId()).toBe('R2');
  });

  it('keeps the Current Round on a failed poll and recovers on the next', async () => {
    await follower.register(LINK);
    const [ok, err] = await polls(); // register is not a poll
    const keep = state.round;
    fetchEvent.mockRejectedValueOnce(new LichessError(429, 'rate limited'));
    await follower.tick();
    expect(follower.status.error).toBe('rate limited');
    expect(state.round).toBe(keep);
    expect(await polls()).toEqual([ok, err + 1]);
    await follower.tick();
    expect(follower.status.error).toBeNull();
    expect(await polls()).toEqual([ok + 1, err + 1]);
  });

  it('keeps the Current Round when the next Round cannot be fetched, and retries', async () => {
    await follower.register(LINK);
    t = follower.status.swapAt!;
    const fail = vi.spyOn(sched, 'startRound').mockRejectedValueOnce(new Error('launch failed'));
    const [ok, err] = await polls();
    await follower.tick();
    expect(follower.status.error).toBe('launch failed');
    expect(await polls()).toEqual([ok, err + 1]); // the Event was fetched, but the swap failed
    expect(roundId()).toBe('R1');
    fail.mockRestore();
    await follower.tick();
    expect(follower.status.error).toBeNull();
    expect(roundId()).toBe('R2');
  });

  it('registering the same Event again changes nothing; clear then register reopens the Round file', async () => {
    const stop = vi.spyOn(sched, 'stop');
    await follower.register(LINK);
    await idle();
    expect(stop).toHaveBeenCalledTimes(1); // first Event: nothing running, harmless
    await follower.register(LINK);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(complete('R1a')).toBe(true);
    const epoch = state.epoch('R1a');
    await follower.clear();
    expect(state.round).toBeNull();
    await follower.register(LINK);
    expect(roundId()).toBe('R1');
    expect(complete('R1a')).toBe(true);
    expect(state.epoch('R1a')).toBeGreaterThan(epoch);
  });

  it('serialises concurrent registrations: the last Event wins', async () => {
    const stop = vi.spyOn(sched, 'stop');
    const a = follower.register(LINK);
    const b = follower.register('other');
    await Promise.all([a, b]);
    expect(state.settings.event).toMatchObject({ tourId: 'T2', name: 'Event 2' });
    expect(roundId()).toBe('B1');
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it('rejects a bad link and a Lichess error without registering anything', async () => {
    fetchEvent.mockRejectedValueOnce(new LichessError(404, 'not found'));
    await expect(follower.register(LINK)).rejects.toMatchObject({ status: 404 });
    expect(state.settings.event).toBeNull();
    expect(every).not.toHaveBeenCalled();
  });

  it('fills a Round that had no Boards when the first poll finds them', async () => {
    boardsOf = { R1: [] };
    await follower.register(LINK);
    expect(roundId()).toBe('R1');
    expect(state.round!.boards).toHaveLength(0);
    delete boardsOf.R1;
    await follower.tick();
    expect(state.round!.boards).toHaveLength(3);
    expect(state.round!.boards.filter((b) => b.tracked)).toHaveLength(2);
  });

  it('adds a Board the source names but the Round lacks, untracked, on the next poll', async () => {
    await follower.register(LINK);
    const e4 = [{ uci: 'e2e4', san: 'e4', clock: null }];
    expect(state.syncMoves('R1x', e4, t)).toBeNull();
    boardsOf = { R1: ['R1a', 'R1b', 'R1c', 'R1x'] };
    await follower.tick();
    expect(state.board('R1x')).toMatchObject({ board: 4, tracked: false });
    expect(state.epoch('R1x')).toBeGreaterThan(-1);
    expect(state.hasUnknownBoards).toBe(false);
    expect(state.syncMoves('R1x', e4, t)).toBe(0);
    expect(state.board('R1x')!.plies).toHaveLength(2);
  });

  it('a timer tick is skipped while the previous poll is still running', async () => {
    await follower.register(LINK);
    const fire = every.mock.calls[0][1];
    let release!: () => void;
    fetchEvent.mockImplementationOnce(() => new Promise((r) => (release = () => r(events[LINK]))));
    const n = fetchEvent.mock.calls.length;
    fire();
    await vi.waitFor(() => expect(fetchEvent).toHaveBeenCalledTimes(n + 1));
    fire();
    fire();
    release();
    await follower.tick();
    expect(fetchEvent).toHaveBeenCalledTimes(n + 2); // the slow poll + the explicit tick, nothing queued
    fire();
    await follower.tick();
    expect(fetchEvent).toHaveBeenCalledTimes(n + 4);
  });

  it('clear goes Idle and stops polling; a tick after stop() does nothing', async () => {
    const seen: unknown[] = [];
    await follower.register(LINK);
    state.on('event', (e) => seen.push(e));
    await follower.clear();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(seen).toContainEqual({ type: 'snapshot', snapshot: expect.objectContaining({ event: null, round: null }) });
    expect(follower.status).toMatchObject({ next: null, polledAt: null });
    await follower.register(LINK);
    await follower.stop();
    const n = fetchEvent.mock.calls.length;
    await follower.tick();
    expect(fetchEvent).toHaveBeenCalledTimes(n);
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it('resume: with a persisted Event it starts polling and polls once; nothing due, no swap', async () => {
    await follower.register(LINK);
    await state.saved();
    await follower.stop();
    await sched.stop();
    const again = await RoundState.load(store);
    const { f } = build(again);
    state = again;
    const before = fetchEvent.mock.calls.length;
    every.mockClear();
    await f.resume();
    expect(every).toHaveBeenCalledTimes(1);
    expect(fetchEvent).toHaveBeenCalledTimes(before + 1);
    expect(roundId()).toBe('R1');
    expect(f.status.next?.roundId).toBe('R2');
  });

  it('resume without an Event does nothing', async () => {
    await follower.resume();
    expect(every).not.toHaveBeenCalled();
    expect(fetchEvent).not.toHaveBeenCalled();
  });
});
