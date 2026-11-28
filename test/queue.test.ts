import { describe, expect, it } from 'vitest';
import { MAX_CRASHES, Queue, type Job } from '../shared/queue.js';

const T = 'T1';

/** Put a Board's ply through MAX_CRASHES crashes so it lands in the Dead-letter queue. */
function kill(q: Queue, boardId: string, board: number, ply: number, tourId = T): void {
  q.setLatest(tourId, boardId, board, ply, 0);
  for (let i = 0; i < MAX_CRASHES; i++) q.crashed(q.next()!, i);
}

describe('Queue', () => {
  it('starts empty', () => {
    const q = new Queue();
    expect(q.next()).toBeNull();
    expect(q.current()).toEqual([]);
    expect(q.backfillCount()).toBe(0);
  });

  it('orders the current tier longest-waiting first', () => {
    const q = new Queue();
    q.setLatest(T, 'a', 3, 5, 0);
    q.setLatest(T, 'b', 1, 7, 1);
    expect(q.next()?.boardId).toBe('a');
    expect(q.next()?.boardId).toBe('b');
    expect(q.next()).toBeNull();
  });

  it('breaks a since tie by lower board number', () => {
    const q = new Queue();
    q.setLatest(T, 'a', 3, 5, 0);
    q.setLatest(T, 'b', 1, 7, 0);
    expect(q.next()?.boardId).toBe('b');
  });

  it('keeps one Job when the same ply is set twice', () => {
    const q = new Queue();
    q.setLatest(T, 'a', 1, 5, 0);
    q.setLatest(T, 'a', 1, 5, 1);
    expect(q.current()).toEqual([expect.objectContaining({ boardId: 'a', ply: 5, since: 0 })]);
  });

  it('supersedes a waiting Job to backfill and keeps its place in the current tier', () => {
    const q = new Queue();
    q.setLatest(T, 'a', 1, 5, 0);
    q.setLatest(T, 'b', 2, 3, 1);
    q.setLatest(T, 'a', 1, 6, 2);
    expect(q.current().map((j) => [j.boardId, j.ply])).toEqual([
      ['a', 6],
      ['b', 3],
    ]);
    expect(q.backfillCount()).toBe(1);
    expect(q.position('a', 5)).toBe(3);
  });

  it('gives a Board that moved after its Job was popped a new since', () => {
    const q = new Queue();
    q.setLatest(T, 'a', 1, 5, 0);
    q.next();
    q.setLatest(T, 'a', 1, 6, 5);
    q.setLatest(T, 'b', 2, 1, 1);
    expect(q.backfillCount()).toBe(0);
    expect(q.next()?.boardId).toBe('b');
    expect(q.next()).toMatchObject({ boardId: 'a', ply: 6, since: 5 });
  });

  it('runs backfill only when the current tier is empty', () => {
    const q = new Queue();
    q.setLatest(T, 'a', 1, 5, 0);
    q.addBackfill(T, 'a', [2], 0);
    expect(q.next()).toMatchObject({ ply: 5, tier: 'current' });
    expect(q.next()).toMatchObject({ ply: 2, tier: 'backfill' });
  });

  it('runs backfill most recent first, then higher ply, then lower board', () => {
    const q = new Queue();
    q.setLatest(T, 'a', 1, 10, 0);
    q.setLatest(T, 'b', 2, 10, 0);
    q.next();
    q.next();
    q.addBackfill(T, 'a', [3], 5);
    q.addBackfill(T, 'b', [4], 9);
    expect(q.next()).toMatchObject({ boardId: 'b', ply: 4 });
    expect(q.next()).toMatchObject({ boardId: 'a', ply: 3 });
    q.addBackfill(T, 'a', [2, 6], 7);
    q.addBackfill(T, 'b', [6], 7);
    expect([q.next(), q.next(), q.next()].map((j) => `${j?.boardId}${j?.ply}`)).toEqual(['a6', 'b6', 'a2']);
  });

  it('addBackfill ignores unknown Boards, plies at or past latest, and queued plies', () => {
    const q = new Queue();
    q.setLatest(T, 'a', 1, 5, 0);
    q.next();
    q.addBackfill(T, 'a', [5, 6, 2], 1);
    q.addBackfill(T, 'x', [1], 1);
    q.addBackfill(T, 'a', [2], 1);
    expect(q.backfillCount()).toBe(1);
    expect(q.position('a', 2)).toBe(1);
  });

  it('records a done latest without enqueuing it', () => {
    const q = new Queue();
    q.setLatest(T, 'a', 1, 5, 0, true);
    expect(q.current()).toEqual([]);
    q.addBackfill(T, 'a', [3], 1);
    expect(q.backfillCount()).toBe(1);
    q.setLatest(T, 'a', 1, 6, 2);
    expect(q.current()).toEqual([expect.objectContaining({ ply: 6 })]);
  });

  it('evicts a running backfill Job as soon as the current tier waits', () => {
    const q = new Queue();
    q.setLatest(T, 'a', 1, 5, 0, true);
    q.addBackfill(T, 'a', [3], 0);
    const running = q.next()!;
    expect(q.preempt(running, 0, 3000)).toBeNull();
    q.setLatest(T, 'b', 2, 9, 1);
    expect(q.preempt(running, 0, 3000)).toBe('backfill');
  });

  it('evicts a running live Job for another live position only once its slice is up', () => {
    const q = new Queue();
    q.setLatest(T, 'a', 1, 5, 0);
    const running = q.next()!;
    expect(q.preempt(running, 5000, 3000)).toBeNull(); // nothing waits
    q.setLatest(T, 'b', 2, 9, 1);
    expect(q.preempt(running, 2999, 3000)).toBeNull();
    expect(q.preempt(running, 3000, 3000)).toBe('live');
  });

  it('evicts a running live Job at once when its Board moves on or is untracked', () => {
    const q = new Queue();
    q.setLatest(T, 'a', 1, 5, 0);
    const running = q.next()!;
    q.setLatest(T, 'a', 1, 6, 1);
    expect(q.preempt(running, 0, 3000)).toBe('stale');
    q.removeBoard('a');
    expect(q.preempt(running, 0, 3000)).toBe('stale');
  });

  it('puts an evicted live Job at the top of backfill, where it stays while it is the latest ply', () => {
    const q = new Queue();
    q.setLatest(T, 'a', 1, 5, 0, true);
    q.addBackfill(T, 'a', [4], 0);
    q.setLatest(T, 'b', 2, 9, 1);
    const running = q.next()!;
    q.setLatest(T, 'c', 3, 2, 2);
    expect(q.evict(running, 3)).toBe(true);
    expect(q.current().map((j) => j.boardId)).toEqual(['c']);
    expect(q.deferred()).toEqual([{ tourId: T, boardId: 'b', board: 2, pass: 0, ply: 9, tier: 'backfill', since: 3 }]);
    expect(q.position('b', 9)).toBe(2);
    expect(q.requeue(q.next()!, 4)).toBe(true); // c back; b still waits in backfill
    q.next();
    expect(q.next()).toMatchObject({ boardId: 'b', ply: 9, tier: 'backfill' });
    expect(q.requeue({ boardId: 'b', board: 2, ply: 9, tier: 'backfill', since: 3 }, 5)).toBe(true);
    expect(q.current()).toEqual([]);
    q.setLatest(T, 'b', 2, 10, 6);
    expect(q.deferred()).toEqual([]);
    expect(q.position('b', 9)).toBe(2);
  });

  it('puts a pre-empted backfill Job back at its old spot', () => {
    const q = new Queue();
    q.setLatest(T, 'a', 1, 5, 0, true);
    q.addBackfill(T, 'a', [3, 2], 0);
    const running = q.next()!;
    q.setLatest(T, 'b', 2, 9, 1);
    expect(q.requeue(running, 2)).toBe(true);
    expect(q.next()?.boardId).toBe('b');
    expect(q.next()).toMatchObject({ boardId: 'a', ply: 3, since: 0 });
    expect(q.next()).toMatchObject({ boardId: 'a', ply: 2 });
  });

  it('routes a requeued Job by the Board latest ply, and drops untracked Boards', () => {
    const q = new Queue();
    q.setLatest(T, 'a', 1, 5, 0);
    const running = q.next()!;
    q.setLatest(T, 'a', 1, 6, 1);
    expect(q.requeue(running, 2)).toBe(true);
    expect(q.current().map((j) => j.ply)).toEqual([6]);
    expect(q.backfillCount()).toBe(1);
    expect(q.requeue({ boardId: 'zz', board: 9, ply: 1, tier: 'current', since: 0 }, 2)).toBe(false);
    expect(q.current()).toHaveLength(1);
  });

  it('requeues a crashed Job to the front, then moves it to the Dead-letter queue on the last crash', () => {
    const q = new Queue();
    q.setLatest(T, 'a', 1, 5, 0);
    q.setLatest(T, 'b', 2, 9, 1);
    expect(q.crashed(q.next()!, 1)).toBe('requeued');
    const again = q.next()!;
    expect(again).toMatchObject({ boardId: 'a', ply: 5, since: 0 });
    expect(q.crashed(again, 2)).toBe('requeued');
    expect(q.crashed(q.next()!, 3)).toBe('dead');
    expect(q.dead()).toEqual([{ tourId: T, boardId: 'a', board: 1, ply: 5, at: 3 }]);
    expect(q.next()?.boardId).toBe('b');
    expect(q.next()).toBeNull();
    q.setLatest(T, 'a', 1, 7, 5);
    q.addBackfill(T, 'a', [5], 6);
    expect(q.current().map((j) => j.ply)).toEqual([7]);
    expect(q.backfillCount()).toBe(0);
  });

  it('requeues a dead Job with its crash count reset', () => {
    const q = new Queue();
    kill(q, 'a', 1, 5);
    expect(q.requeueDead('a', 5, 10)).toBe(true);
    expect(q.dead()).toEqual([]);
    expect(q.current()).toEqual([expect.objectContaining({ ply: 5, since: 10 })]);
    for (let i = 0; i < MAX_CRASHES - 1; i++) expect(q.crashed(q.next()!, 11)).toBe('requeued');
    expect(q.crashed(q.next()!, 12)).toBe('dead');
    expect(q.requeueDead('a', 99, 13)).toBe(false);
  });

  it('discards a dead Job', () => {
    const q = new Queue();
    kill(q, 'a', 1, 5);
    expect(q.discardDead('a', 5)).toBe(true);
    expect(q.dead()).toEqual([]);
    expect(q.discardDead('a', 5)).toBe(false);
    expect(q.requeueDead('a', 5, 1)).toBe(false);
    q.addBackfill(T, 'a', [5], 2);
    q.setLatest(T, 'a', 1, 6, 2);
    q.addBackfill(T, 'a', [5], 2);
    expect(q.position('a', 5)).toBeNull(); // stays out for the Round
    q.setLatest(T, 'a', 1, 4, 3); // corrected away: a new position may come at ply 5
    q.setLatest(T, 'a', 1, 5, 3);
    expect(q.position('a', 5)).toBe(1);
  });

  it('removeBoard drops only that Board: Jobs, Dead-letter queue entries and latest', () => {
    const q = new Queue();
    kill(q, 'a', 1, 5);
    kill(q, 'c', 3, 7);
    q.setLatest(T, 'a', 1, 6, 5);
    q.addBackfill(T, 'a', [2], 5);
    q.setLatest(T, 'b', 2, 4, 5);
    q.removeBoard('a');
    expect(q.current().map((j) => j.boardId)).toEqual(['b']);
    expect(q.backfillCount()).toBe(0);
    expect(q.dead().map((d) => d.boardId)).toEqual(['c']);
    expect(q.position('a', 6)).toBeNull();
    q.addBackfill(T, 'a', [1], 6);
    expect(q.backfillCount()).toBe(0);
    q.next();
    q.setLatest(T, 'c', 3, 8, 6);
    q.crashed(q.next()!, 6);
    q.removeBoard('c');
    q.setLatest(T, 'c', 3, 8, 7);
    for (let i = 0; i < MAX_CRASHES - 1; i++) expect(q.crashed(q.next()!, 8)).toBe('requeued');
  });

  it('clear empties the queue and the Dead-letter queue', () => {
    const q = new Queue();
    kill(q, 'a', 1, 5);
    q.setLatest(T, 'b', 2, 4, 0);
    q.crashed(q.next()!, 0);
    q.clear();
    expect(q.next()).toBeNull();
    expect(q.dead()).toEqual([]);
    expect(q.position('b', 4)).toBeNull();
    q.setLatest(T, 'b', 2, 4, 1);
    for (let i = 0; i < MAX_CRASHES - 1; i++) expect(q.crashed(q.next()!, 2)).toBe('requeued');
  });

  it('reports a 1-based position across both tiers, and null for a running Job', () => {
    const q = new Queue();
    q.setLatest(T, 'a', 1, 5, 0);
    q.setLatest(T, 'b', 2, 9, 1);
    q.addBackfill(T, 'b', [3], 2);
    expect(q.position('a', 5)).toBe(1);
    expect(q.position('b', 9)).toBe(2);
    expect(q.position('b', 3)).toBe(3);
    q.next();
    expect(q.position('a', 5)).toBeNull();
  });

  it('drops backfill plies at or past a corrected (lower) latest ply', () => {
    const q = new Queue();
    q.setLatest(T, 'a', 1, 9, 0, true);
    q.addBackfill(T, 'a', [3, 7, 8], 0);
    q.setLatest(T, 'a', 1, 6, 1);
    expect(q.current()).toEqual([expect.objectContaining({ ply: 6, since: 1 })]);
    expect(q.backfillCount()).toBe(1);
    expect(q.position('a', 3)).toBe(2);
  });

  it('forgets dead plies past a corrected latest ply', () => {
    const q = new Queue();
    kill(q, 'a', 1, 5);
    q.setLatest(T, 'a', 1, 4, 3);
    expect(q.dead()).toEqual([]);
    q.next();
    q.setLatest(T, 'a', 1, 5, 4);
    expect(q.current()).toEqual([expect.objectContaining({ ply: 5 })]);
  });

  it('restores persisted Dead-letter queue entries before anything is queued', () => {
    const q = new Queue();
    q.restoreDead([{ tourId: T, boardId: 'a', board: 1, ply: 5, at: 7 }], T);
    q.setLatest(T, 'a', 1, 5, 10);
    q.addBackfill(T, 'a', [3, 5], 10);
    expect(q.current()).toEqual([]);
    expect(q.dead()).toEqual([{ tourId: T, boardId: 'a', board: 1, ply: 5, at: 7 }]);
    expect(q.requeueDead('a', 5, 11)).toBe(true);
    expect(q.next()).toMatchObject({ ply: 5 });
    expect(q.crashed({ tourId: T, boardId: 'a', board: 1, ply: 5, tier: 'current', since: 11 }, 12)).toBe('requeued');
  });

  it('restores a persisted entry without a tourId under the given one', () => {
    const q = new Queue();
    q.restoreDead([{ boardId: 'a', board: 1, ply: 5, at: 7 }], 'T9');
    expect(q.dead()).toEqual([{ tourId: 'T9', boardId: 'a', board: 1, ply: 5, at: 7 }]);
    expect(q.requeueDead('a', 5, 8)).toBe(false); // Board not tracked yet
    q.setLatest('T9', 'a', 1, 6, 9);
    q.removeEvent('T9');
    expect(q.dead()).toEqual([]);
  });

  it('stamps Jobs with their Event', () => {
    const q = new Queue();
    q.setLatest('A', 'a', 1, 5, 0);
    q.addBackfill('A', 'a', [2], 0);
    q.setLatest('B', 'b', 1, 3, 1);
    expect(q.current().map((j) => [j.tourId, j.boardId])).toEqual([
      ['A', 'a'],
      ['B', 'b'],
    ]);
    expect(q.next()?.tourId).toBe('A');
    expect(q.next()?.tourId).toBe('B');
    expect(q.next()).toMatchObject({ tourId: 'A', tier: 'backfill', ply: 2 });
  });

  it('serves a current Job of any Event before a backfill Job of another', () => {
    const q = new Queue();
    q.setLatest('A', 'a', 1, 5, 0);
    q.addBackfill('A', 'a', [2], 0);
    q.setLatest('B', 'b', 1, 3, 100);
    expect(q.next()).toMatchObject({ tourId: 'A', ply: 5 });
    expect(q.next()).toMatchObject({ tourId: 'B', tier: 'current' });
    expect(q.next()).toMatchObject({ tourId: 'A', tier: 'backfill' });
  });

  it('removeEvent drops one Event and leaves the others and their order intact', () => {
    const build = (withA: boolean) => {
      const q = new Queue();
      if (withA) {
        kill(q, 'ad', 1, 5, 'A'); // dead
        q.setLatest('A', 'a1', 2, 6, 5);
        q.addBackfill('A', 'a1', [2], 5);
        q.crashed(q.next()!, 5); // a1:6 crashed once
        kill(q, 'adisc', 3, 4, 'A');
        q.discardDead('adisc', 4); // discarded
      }
      kill(q, 'bd', 1, 3, 'B');
      q.setLatest('B', 'b1', 2, 7, 6);
      q.addBackfill('B', 'b1', [1, 2], 6);
      q.setLatest('B', 'b2', 3, 4, 7);
      if (withA) q.setLatest('A', 'a1', 2, 6, 8);
      return q;
    };
    const q = build(true);
    q.removeEvent('A');
    const ref = build(false);
    expect(q.dead()).toEqual(ref.dead());
    expect(q.current()).toEqual(ref.current());
    expect(q.backfillCount()).toBe(ref.backfillCount());
    expect(q.position('b1', 1)).toBe(ref.position('b1', 1));
    expect(q.position('a1', 6)).toBeNull();
    expect(q.dead().map((d) => d.tourId)).toEqual(['B']);
    // A's crash count and discard mark are gone: the same positions queue again, with a fresh count.
    q.setLatest('A', 'a1', 2, 6, 20);
    q.setLatest('A', 'adisc', 3, 4, 20);
    expect(q.position('adisc', 4)).not.toBeNull();
    q.removeEvent('A');
    const rest = (x: Queue) => {
      const out: string[] = [];
      for (let j = x.next(); j; j = x.next()) if (j.tourId === 'B') out.push(`${j.boardId}:${j.ply}`);
      return out;
    };
    expect(rest(q)).toEqual(rest(ref));
  });

  it('returns copies from its read-only views', () => {
    const q = new Queue();
    q.setLatest(T, 'a', 1, 5, 0);
    const [view] = q.current() as Job[];
    view.since = 99;
    expect(q.current()[0].since).toBe(0);
  });

  it('orders by Pass first; next(maxPass) holds back the higher Passes', () => {
    const q = new Queue();
    q.setLatest(T, 'a', 1, 5, 0, false, 1); // a deepening Job of the latest ply
    q.addBackfill(T, 'a', [3, 2], 1, (ply) => (ply === 3 ? 2 : 0));
    q.setLatest(T, 'b', 2, 9, 2);
    expect(q.passCounts()).toEqual([2, 1, 1]);
    expect(q.current().map((j) => j.boardId)).toEqual(['b']); // Pass 0 only
    expect(q.backfillCount()).toBe(1);
    expect([q.next(1), q.next(1), q.next(1)].map((j) => `${j?.boardId}${j?.ply}:${j?.pass}`)).toEqual([
      'b9:0',
      'a2:0',
      'a5:1',
    ]);
    expect(q.next(1)).toBeNull();
    expect(q.next()).toMatchObject({ boardId: 'a', ply: 3, pass: 2 });
  });

  it('evicts a deepening Job for a lower Pass, or when its Pass may no longer run', () => {
    const q = new Queue();
    q.setLatest(T, 'a', 1, 5, 0, false, 2);
    const running = q.next()!;
    expect(q.preempt(running, 0, Infinity, 2)).toBeNull();
    expect(q.preempt(running, 0, Infinity, 1)).toBe('upgrade'); // an Event went live
    q.addBackfill(T, 'a', [3], 1, () => 2);
    expect(q.preempt(running, 0, Infinity, 2)).toBeNull(); // same Pass waits: keep going
    q.addBackfill(T, 'a', [2], 1, () => 1);
    expect(q.preempt(running, 0, Infinity, 2)).toBe('upgrade');
    q.setLatest(T, 'a', 1, 6, 2);
    expect(q.preempt(running, 0, Infinity, 2)).toBe('stale');
  });

  it('a Pass 0 Job is not evicted by a waiting deepening Job', () => {
    const q = new Queue();
    q.setLatest(T, 'a', 1, 5, 0);
    q.setLatest(T, 'b', 2, 9, 1, false, 1);
    const running = q.next()!;
    expect(running.boardId).toBe('a');
    expect(q.preempt(running, 5000, 3000, 2)).toBeNull();
  });

  it('repass moves waiting Jobs to their new Pass, keeps their place, and drops the finished ones', () => {
    const q = new Queue();
    q.setLatest(T, 'a', 1, 5, 0, false, 1);
    q.addBackfill(T, 'a', [3, 2], 1, () => 1);
    kill(q, 'x', 3, 1);
    q.repass((j) => (j.ply === 2 ? null : 2));
    expect(q.passCounts()).toEqual([0, 0, 2]);
    expect(q.next()).toMatchObject({ ply: 5, pass: 2, since: 0, tier: 'current' });
    expect(q.next()).toMatchObject({ ply: 3, pass: 2 });
    expect(q.dead()).toHaveLength(1);
  });

  it("requeue keeps a Job's Pass; a dead entry comes back at Pass 0", () => {
    const q = new Queue();
    q.setLatest(T, 'a', 1, 5, 0);
    const job = q.next()!;
    expect(q.requeue({ ...job, pass: 1 }, 1)).toBe(true);
    expect(q.next()).toMatchObject({ ply: 5, pass: 1, tier: 'current' });
    kill(q, 'b', 2, 4);
    expect(q.requeueDead('b', 4, 9)).toBe(true);
    expect(q.next()).toMatchObject({ boardId: 'b', pass: 0 });
  });

  describe('deep map', () => {
    const tag = (j: Job | null) => j && `${j.boardId}${j.ply}${j.deep ? 'd' : ''}`;
    const deep = (q: Queue, boardId: string, plies: number[], since = 0) =>
      q.addDeep(T, 'R0', boardId, 9, plies, since);

    it('runs deep Jobs after every regular one, FIFO by request, plies ascending, only up to maxPass', () => {
      const q = new Queue();
      deep(q, 'x', [2, 0, 1]);
      deep(q, 'y', [0]);
      q.setLatest(T, 'a', 1, 5, 0, false, 1);
      expect(q.passCounts()).toEqual([0, 1, 4]);
      expect(q.next(1)).toMatchObject({ boardId: 'a', pass: 1 });
      expect(q.next(1)).toBeNull(); // the deep Pass is gated
      expect(q.deep()).toHaveLength(4);
      const order = [q.next(2), q.next(2), q.next(2), q.next(2), q.next(2)].map(tag);
      expect(order).toEqual(['x0d', 'x1d', 'x2d', 'y0d', null]);
      deep(q, 'x', [0]);
      expect(q.next()).toMatchObject({ tourId: T, roundId: 'R0', boardId: 'x', board: 9, deep: true, pass: 2 });
    });

    it('a repeat request restarts the Board at the back', () => {
      const q = new Queue();
      deep(q, 'x', [0, 1]);
      deep(q, 'y', [0]);
      deep(q, 'x', [3]);
      expect(q.deep().map(tag)).toEqual(['y0d', 'x3d']);
    });

    it('evicts a running deep Job (upgrade) when a regular Job may run, or when the deep Pass is gated', () => {
      const q = new Queue();
      deep(q, 'x', [0, 1]);
      const running = q.next(2)!;
      expect(q.preempt(running, 0, Infinity, 2)).toBeNull(); // other deep Jobs wait: keep going
      expect(q.preempt(running, 0, Infinity, 1)).toBe('upgrade'); // an Event went live
      q.setLatest(T, 'a', 1, 5, 0, false, 1);
      expect(q.preempt(running, 0, Infinity, 2)).toBe('upgrade');
      q.next();
      expect(q.preempt(running, 0, Infinity, 2)).toBeNull();
    });

    it('requeues a stopped deep Job at the front, once', () => {
      const q = new Queue();
      deep(q, 'x', [0, 1]);
      deep(q, 'y', [0]);
      const job = q.next()!;
      expect(q.requeueDeep(job)).toBe(true);
      expect(q.requeueDeep(job)).toBe(false);
      expect(q.deep().map(tag)).toEqual(['x0d', 'x1d', 'y0d']);
    });

    it('requeues a crashed deep Job at the front, and gives it up on the last crash, never dead-lettered', () => {
      const q = new Queue();
      deep(q, 'x', [0, 1]);
      for (let i = 1; i < MAX_CRASHES; i++) expect(q.crashedDeep(q.next()!)).toBe(true);
      expect(q.crashedDeep(q.next()!)).toBe(false);
      expect(q.dead()).toEqual([]);
      expect(q.deep().map(tag)).toEqual(['x1d']);
      deep(q, 'x', [0]); // a new request counts afresh
      expect(q.crashedDeep(q.next()!)).toBe(true);
    });

    it('cancelDeep drops only that Board', () => {
      const q = new Queue();
      deep(q, 'x', [0, 1]);
      deep(q, 'y', [0]);
      q.cancelDeep('x');
      expect(q.deep().map(tag)).toEqual(['y0d']);
    });

    it('is untouched by setLatest, removeBoard, removeEvent, clear and repass; the same key may be in both maps', () => {
      const q = new Queue();
      deep(q, 'a', [0, 1, 2]);
      q.setLatest(T, 'a', 1, 1, 0);
      q.setLatest(T, 'a', 1, 0, 1); // a correction past the deep plies
      q.repass(() => null);
      q.removeBoard('a');
      q.removeEvent(T);
      q.clear();
      expect(q.deep().map(tag)).toEqual(['a0d', 'a1d', 'a2d']);
      q.setLatest(T, 'a', 1, 0, 2);
      expect([q.next(), q.next()].map(tag)).toEqual(['a0', 'a0d']);
    });
  });
});
