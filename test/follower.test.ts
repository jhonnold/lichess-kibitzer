import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoundSummary } from '../src/lichess/api.js';
import { Engine } from '../src/engine/engine.js';
import { POLL_MS } from '../src/follower.js';
import { Site } from '../src/site.js';
import { LichessError, type EventInfo, type RoundInfo } from '../src/lichess/api.js';
import { SiteState } from '../src/site-state.js';
import { Scheduler } from '../src/scheduler.js';
import { dataStore, type DataStore } from '../src/store.js';
import { followerPolls } from '../src/metrics.js';
import { val } from './helpers/metric.js';
import { ReplaySource } from './helpers/replay-source.js';
import { engineConfig } from '../shared/engine-config.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-uci.mjs', import.meta.url));
const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;
const LINK = 'https://lichess.org/broadcast/x/T1';

let dir: string, store: DataStore, t: number;
let site: SiteState, sched: Scheduler, hub: Site;
const follower = (tourId = 'T1') => hub.follower(tourId)!;
const status = (tourId = 'T1') => hub.status(tourId)!;
const state = () => site.primaryState!;
let rounds: RoundSummary[], rounds2: RoundSummary[];
let boardsOf: Record<string, string[]>;
let events: Record<string, EventInfo>;
let sourceIds: string[];
let fetchEvent: ReturnType<typeof vi.fn<(link: string) => Promise<EventInfo>>>;
let every: ReturnType<typeof vi.fn<(ms: number, fn: () => void) => () => void>>;
let cancels: ReturnType<typeof vi.fn<() => void>>[]; // one per every() call
let live: { sched: Scheduler; hub: Site }[];

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

function build(s: SiteState) {
  const sc = new Scheduler(s, {
    defaultEngine: engineConfig('fake'),
    launch: () => Engine.start(process.execPath, { args: [FAKE, '--ply-score'] }),
    source: (id) => (sourceIds.push(id), new ReplaySource([])),
    now: () => t,
  });
  const h = new Site(s, sc, {
    lichess: { fetchEvent, fetchRound: async (id) => roundInfo(id) },
    store,
    now: () => t,
    every,
  });
  live.push({ sched: sc, hub: h });
  return { sc, h };
}

const idle = async () => {
  for (let i = 0; i < 400; i++) {
    const q = site.snapshot().queue;
    if (sched.running === null && !q.current.length && !q.backfill) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('idle: timeout');
};
const complete = (id: string) => state().board(id)!.plies[0].eval?.kind === 'complete';
const roundId = () => state().round?.roundId;
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
  rounds2 = [
    { id: 'B1', name: 'B1', ongoing: true, finished: false, startsAt: T0 },
    { id: 'B2', name: 'B2', ongoing: false, finished: false, startsAt: T0 + 2 * HOUR },
  ];
  events = {
    [LINK]: {
      id: 'T1',
      name: 'Event 1',
      get rounds() {
        return rounds;
      },
    },
    other: {
      id: 'T2',
      name: 'Event 2',
      get rounds() {
        return rounds2;
      },
    },
  };
  fetchEvent = vi.fn(async (link: string) => events[link]);
  cancels = [];
  every = vi.fn(() => {
    cancels.push(vi.fn());
    return cancels.at(-1)!;
  });
  site = new SiteState(store);
  site.setJobTime(15);
  ({ sc: sched, h: hub } = build(site));
});
afterEach(async () => {
  for (const l of live) {
    await l.hub.stop();
    await l.sched.stop();
  }
  await site.saved();
  rmSync(dir, { recursive: true, force: true });
});

describe('Site and Follower', () => {
  it('registers: picks the ongoing Round, tracks the first N and reports the next', async () => {
    await hub.add(LINK, 2);
    expect(roundId()).toBe('R1');
    expect(state().round!.boards.filter((b) => b.tracked)).toHaveLength(2);
    expect(status()).toMatchObject({
      next: { roundId: 'R2', name: 'Round 2', startsAt: T0 + HOUR },
      swapAt: T0 + HOUR - 600_000,
      polledAt: T0,
      error: null,
    });
    await hub.add(LINK, 2);
    expect(every).toHaveBeenCalledTimes(1);
    expect(every).toHaveBeenCalledWith(POLL_MS, expect.any(Function));
  });

  it('swaps 10 minutes before the next Round starts; the old Round file keeps its evals', async () => {
    await hub.add(LINK, 2);
    await idle();
    const swapAt = status().swapAt!;
    t = swapAt - 1;
    await follower().tick();
    expect(roundId()).toBe('R1');
    t = swapAt;
    await follower().tick();
    expect(roundId()).toBe('R2');
    expect(sourceIds).toEqual(['R1', 'R2']);
    expect(state().round!.startsAt).toBe(T0 + HOUR);
    expect(status().next).toBeNull();
    await site.saved();
    const file = JSON.parse(readFileSync(join(dir, 'rounds/T1/R1.json'), 'utf8'));
    expect(file.boards[0].plies[0].eval.kind).toBe('complete');
  });

  it('starts the next Round from the default tracked set', async () => {
    await hub.add(LINK, 2);
    await sched.setTracked('T1', ['R1c']);
    t = status().swapAt!;
    await follower().tick();
    expect(
      state()
        .round!.boards.filter((b) => b.tracked)
        .map((b) => b.id),
    ).toEqual(['R2a', 'R2b']);
  });

  it('never goes back to an earlier Round', async () => {
    await hub.add(LINK, 2);
    t = status().swapAt!;
    await follower().tick();
    rounds[0].ongoing = true;
    await follower().tick();
    expect(roundId()).toBe('R2');
  });

  it('without startsAt, swaps only when Lichess reports the Round ongoing', async () => {
    rounds[1] = { id: 'R2', name: 'Round 2', ongoing: false, finished: false };
    await hub.add(LINK, 2);
    expect(status()).toMatchObject({ next: { roundId: 'R2', startsAt: null }, swapAt: null });
    t = T0 + 99 * HOUR;
    await follower().tick();
    expect(roundId()).toBe('R1');
    rounds[1].ongoing = true;
    await follower().tick();
    expect(roundId()).toBe('R2');
  });

  it('keeps the Current Round on a failed poll and recovers on the next', async () => {
    await hub.add(LINK, 2);
    const [ok, err] = await polls(); // register is not a poll
    const keep = state().round;
    fetchEvent.mockRejectedValueOnce(new LichessError(429, 'rate limited'));
    await follower().tick();
    expect(status().error).toBe('rate limited');
    expect(state().round).toBe(keep);
    expect(await polls()).toEqual([ok, err + 1]);
    await follower().tick();
    expect(status().error).toBeNull();
    expect(await polls()).toEqual([ok + 1, err + 1]);
  });

  it('keeps the Current Round when the next Round cannot be fetched, and retries', async () => {
    await hub.add(LINK, 2);
    t = status().swapAt!;
    const fail = vi.spyOn(sched, 'startRound').mockRejectedValueOnce(new Error('launch failed'));
    const [ok, err] = await polls();
    await follower().tick();
    expect(status().error).toBe('launch failed');
    expect(await polls()).toEqual([ok, err + 1]); // the Event was fetched, but the swap failed
    expect(roundId()).toBe('R1');
    fail.mockRestore();
    await follower().tick();
    expect(status().error).toBeNull();
    expect(roundId()).toBe('R2');
  });

  it('registering the same Event again changes nothing; clear then register reopens the Round file', async () => {
    const remove = vi.spyOn(sched, 'removeEvent');
    await hub.add(LINK, 2);
    await idle();
    expect(remove).toHaveBeenCalledTimes(0); // first Event: nothing to remove
    await hub.add(LINK, 2);
    expect(remove).toHaveBeenCalledTimes(0);
    expect(complete('R1a')).toBe(true);
    const epoch = state().epoch('R1a');
    await hub.remove('T1');
    expect(site.primaryState).toBeNull();
    await hub.add(LINK, 2);
    expect(roundId()).toBe('R1');
    expect(complete('R1a')).toBe(true);
    expect(state().epoch('R1a')).toBeGreaterThan(epoch);
  });

  it('concurrent adds are serialised: both Events registered in order, the first is Primary', async () => {
    const remove = vi.spyOn(sched, 'removeEvent');
    const a = hub.add(LINK, 2);
    const b = hub.add('other', 2);
    await Promise.all([a, b]);
    expect(site.events.map((rs) => rs.event.tourId)).toEqual(['T1', 'T2']);
    expect(site.primary).toBe('T1');
    expect(site.event('T2')!.round?.roundId).toBe('B1');
    expect(remove).not.toHaveBeenCalled();
  });

  it('rejects a bad link and a Lichess error without registering anything', async () => {
    fetchEvent.mockRejectedValueOnce(new LichessError(404, 'not found'));
    await expect(hub.add(LINK, 2)).rejects.toMatchObject({ status: 404 });
    expect(site.primaryState?.event ?? null).toBeNull();
    expect(every).not.toHaveBeenCalled();
  });

  it('fills a Round that had no Boards when the first poll finds them', async () => {
    boardsOf = { R1: [] };
    await hub.add(LINK, 2);
    expect(roundId()).toBe('R1');
    expect(state().round!.boards).toHaveLength(0);
    delete boardsOf.R1;
    await follower().tick();
    expect(state().round!.boards).toHaveLength(3);
    expect(state().round!.boards.filter((b) => b.tracked)).toHaveLength(2);
  });

  it('adds a Board the source names but the Round lacks, untracked, on the next poll', async () => {
    await hub.add(LINK, 2);
    const e4 = [{ uci: 'e2e4', san: 'e4', clock: null }];
    expect(state().syncMoves('R1x', e4, t)).toBeNull();
    boardsOf = { R1: ['R1a', 'R1b', 'R1c', 'R1x'] };
    await follower().tick();
    expect(state().board('R1x')).toMatchObject({ board: 4, tracked: false });
    expect(state().epoch('R1x')).toBeGreaterThan(-1);
    expect(state().hasUnknownBoards).toBe(false);
    expect(state().syncMoves('R1x', e4, t)).toBe(0);
    expect(state().board('R1x')!.plies).toHaveLength(2);
  });

  it('a timer tick is skipped while the previous poll is still running', async () => {
    await hub.add(LINK, 2);
    const fire = every.mock.calls[0][1];
    let release!: () => void;
    fetchEvent.mockImplementationOnce(() => new Promise((r) => (release = () => r(events[LINK]))));
    const n = fetchEvent.mock.calls.length;
    fire();
    await vi.waitFor(() => expect(fetchEvent).toHaveBeenCalledTimes(n + 1));
    fire();
    fire();
    release();
    await follower().tick();
    expect(fetchEvent).toHaveBeenCalledTimes(n + 2); // the slow poll + the explicit tick, nothing queued
    fire();
    await follower().tick();
    expect(fetchEvent).toHaveBeenCalledTimes(n + 4);
  });

  it('clear goes Idle and stops polling; a tick after stop() does nothing', async () => {
    const seen: unknown[] = [];
    await hub.add(LINK, 2);
    site.on('event', (_t, e) => seen.push(e));
    await hub.remove('T1');
    expect(cancels[0]).toHaveBeenCalledTimes(1);
    expect(seen).toContainEqual({ type: 'snapshot', snapshot: expect.objectContaining({ event: null, round: null }) });
    expect(hub.status('T1')).toBeNull();
    await hub.add(LINK, 2);
    await hub.stop();
    const n = fetchEvent.mock.calls.length;
    await follower().tick();
    expect(fetchEvent).toHaveBeenCalledTimes(n);
    expect(cancels[1]).toHaveBeenCalledTimes(1);
  });

  it('resume: with a persisted Event it starts polling and polls once; nothing due, no swap', async () => {
    await hub.add(LINK, 2);
    await site.saved();
    await hub.stop();
    await sched.stop();
    site = await SiteState.load(store);
    const { h } = build(site);
    const before = fetchEvent.mock.calls.length;
    every.mockClear();
    await h.resume();
    expect(every).toHaveBeenCalledTimes(1);
    expect(fetchEvent).toHaveBeenCalledTimes(before + 1);
    expect(roundId()).toBe('R1');
    expect(h.status('T1')!.next?.roundId).toBe('R2');
  });

  it('resume without an Event does nothing', async () => {
    await hub.resume();
    expect(every).not.toHaveBeenCalled();
    expect(fetchEvent).not.toHaveBeenCalled();
  });

  it("removing A leaves B polling and B's Round running", async () => {
    await hub.add(LINK, 2);
    await hub.add('other', 2);
    await idle();
    expect(await hub.remove('T1')).toBe(true);
    expect(cancels[0]).toHaveBeenCalledTimes(1);
    expect(cancels[1]).not.toHaveBeenCalled();
    expect(site.event('T1')).toBeUndefined();
    expect(site.event('T2')!.round?.roundId).toBe('B1');
    expect(sched.engine).not.toBeNull();
    t = status('T2').swapAt!;
    await follower('T2').tick();
    expect(site.event('T2')!.round?.roundId).toBe('B2');
  });

  it('swaps are independent', async () => {
    await hub.add(LINK, 2);
    await hub.add('other', 2);
    const seen: [string | null, string][] = [];
    site.on('event', (tour, e) => e.type === 'snapshot' && seen.push([tour, e.snapshot.round?.roundId ?? '']));
    t = status('T1').swapAt!; // only A is due
    await follower('T1').tick();
    await follower('T2').tick();
    expect(site.event('T1')!.round?.roundId).toBe('R2');
    expect(site.event('T2')!.round?.roundId).toBe('B1');
    expect(seen.filter(([tour]) => tour === 'T2')).toEqual([]); // no Idle frame for B's Viewers
    t = status('T2').swapAt!;
    await follower('T2').tick();
    expect(site.event('T2')!.round?.roundId).toBe('B2');
    expect(site.event('T1')!.round?.roundId).toBe('R2');
  });

  it('removing the Primary hands it to the oldest remaining Event; removing the last leaves none', async () => {
    await hub.add(LINK, 2);
    await hub.add('other', 2);
    expect(site.primary).toBe('T1');
    await hub.remove('T1');
    expect(site.primary).toBe('T2');
    await hub.remove('T2');
    expect(site.primary).toBeNull();
    expect(site.events).toHaveLength(0);
  });

  it('a second Event added while one is live gets topN 4; an explicit topN wins; existing Events keep theirs', async () => {
    await hub.add(LINK);
    expect(site.event('T1')!.topN).toBe(8);
    await hub.add('other');
    expect(site.event('T2')!.topN).toBe(4);
    expect(site.event('T1')!.topN).toBe(8);
    await hub.remove('T2');
    await hub.add('other', 3);
    expect(site.event('T2')!.topN).toBe(3);
    await hub.add('other', 6); // re-add: only a tick
    expect(site.event('T2')!.topN).toBe(3);
  });

  it('resume follows every persisted Event: one Follower each, one poll each', async () => {
    await hub.add(LINK, 2);
    await hub.add('other', 2);
    await idle();
    await site.saved();
    await hub.stop();
    await sched.stop();
    site = await SiteState.load(store);
    const { sc, h } = build(site);
    sched = sc;
    const before = fetchEvent.mock.calls.length;
    every.mockClear();
    await sc.resume();
    // sequential: the second Event is not fetched until the first fetch resolves
    let release!: () => void;
    const first = fetchEvent.getMockImplementation()!;
    fetchEvent.mockImplementationOnce(async (link) => {
      await new Promise<void>((r) => (release = r));
      return first(link);
    });
    const resumed = h.resume();
    await vi.waitFor(() => expect(fetchEvent).toHaveBeenCalledTimes(before + 1));
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchEvent).toHaveBeenCalledTimes(before + 1);
    release();
    await resumed;
    expect(every).toHaveBeenCalledTimes(2);
    expect(fetchEvent).toHaveBeenCalledTimes(before + 2);
    expect([site.event('T1')!.round?.roundId, site.event('T2')!.round?.roundId]).toEqual(['R1', 'B1']);
    expect(h.follower('T1')).not.toBe(h.follower('T2'));
    expect(h.status('T2')!.next?.roundId).toBe('B2');
  });

  it('after stop(), add of a known link re-arms nothing and starts no Round', async () => {
    await hub.add(LINK, 2);
    await hub.stop();
    const start = vi.spyOn(sched, 'startRound');
    const n = every.mock.calls.length;
    t = status('T1').swapAt!;
    await hub.add(LINK, 2).catch(() => {});
    await hub.resume();
    expect(every).toHaveBeenCalledTimes(n);
    expect(start).not.toHaveBeenCalled();
    expect(await hub.remove('T1')).toBe(false);
  });

  it('remove of an unknown tourId → false', async () => {
    expect(await hub.remove('nope')).toBe(false);
  });
});
