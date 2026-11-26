import { describe, expect, it } from 'vitest';
import { MAX_CRASHES, Queue, type Job } from '../shared/queue.js';

/** Put a Board's ply through MAX_CRASHES crashes so it lands in the Dead-letter queue. */
function kill(q: Queue, boardId: string, board: number, ply: number): void {
  q.setLatest(boardId, board, ply, 0);
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
    q.setLatest('a', 3, 5, 0);
    q.setLatest('b', 1, 7, 1);
    expect(q.next()?.boardId).toBe('a');
    expect(q.next()?.boardId).toBe('b');
    expect(q.next()).toBeNull();
  });

  it('breaks a since tie by lower board number', () => {
    const q = new Queue();
    q.setLatest('a', 3, 5, 0);
    q.setLatest('b', 1, 7, 0);
    expect(q.next()?.boardId).toBe('b');
  });

  it('keeps one Job when the same ply is set twice', () => {
    const q = new Queue();
    q.setLatest('a', 1, 5, 0);
    q.setLatest('a', 1, 5, 1);
    expect(q.current()).toEqual([expect.objectContaining({ boardId: 'a', ply: 5, since: 0 })]);
  });

  it('supersedes a waiting Job to backfill and keeps its place in the current tier', () => {
    const q = new Queue();
    q.setLatest('a', 1, 5, 0);
    q.setLatest('b', 2, 3, 1);
    q.setLatest('a', 1, 6, 2);
    expect(q.current().map((j) => [j.boardId, j.ply])).toEqual([
      ['a', 6],
      ['b', 3],
    ]);
    expect(q.backfillCount()).toBe(1);
    expect(q.position('a', 5)).toBe(3);
  });

  it('gives a Board that moved after its Job was popped a new since', () => {
    const q = new Queue();
    q.setLatest('a', 1, 5, 0);
    q.next();
    q.setLatest('a', 1, 6, 5);
    q.setLatest('b', 2, 1, 1);
    expect(q.backfillCount()).toBe(0);
    expect(q.next()?.boardId).toBe('b');
    expect(q.next()).toMatchObject({ boardId: 'a', ply: 6, since: 5 });
  });

  it('runs backfill only when the current tier is empty', () => {
    const q = new Queue();
    q.setLatest('a', 1, 5, 0);
    q.addBackfill('a', [2], 0);
    expect(q.next()).toMatchObject({ ply: 5, tier: 'current' });
    expect(q.next()).toMatchObject({ ply: 2, tier: 'backfill' });
  });

  it('runs backfill most recent first, then higher ply, then lower board', () => {
    const q = new Queue();
    q.setLatest('a', 1, 10, 0);
    q.setLatest('b', 2, 10, 0);
    q.next();
    q.next();
    q.addBackfill('a', [3], 5);
    q.addBackfill('b', [4], 9);
    expect(q.next()).toMatchObject({ boardId: 'b', ply: 4 });
    expect(q.next()).toMatchObject({ boardId: 'a', ply: 3 });
    q.addBackfill('a', [2, 6], 7);
    q.addBackfill('b', [6], 7);
    expect([q.next(), q.next(), q.next()].map((j) => `${j?.boardId}${j?.ply}`)).toEqual(['a6', 'b6', 'a2']);
  });

  it('addBackfill ignores unknown Boards, plies at or past latest, and queued plies', () => {
    const q = new Queue();
    q.setLatest('a', 1, 5, 0);
    q.next();
    q.addBackfill('a', [5, 6, 2], 1);
    q.addBackfill('x', [1], 1);
    q.addBackfill('a', [2], 1);
    expect(q.backfillCount()).toBe(1);
    expect(q.position('a', 2)).toBe(1);
  });

  it('records a done latest without enqueuing it', () => {
    const q = new Queue();
    q.setLatest('a', 1, 5, 0, true);
    expect(q.current()).toEqual([]);
    q.addBackfill('a', [3], 1);
    expect(q.backfillCount()).toBe(1);
    q.setLatest('a', 1, 6, 2);
    expect(q.current()).toEqual([expect.objectContaining({ ply: 6 })]);
  });

  it('pre-empts only a running backfill Job while the current tier waits', () => {
    const q = new Queue();
    q.setLatest('a', 1, 5, 0, true);
    q.addBackfill('a', [3], 0);
    const running = q.next()!;
    expect(q.shouldPreempt(running)).toBe(false);
    q.setLatest('b', 2, 9, 1);
    expect(q.shouldPreempt(running)).toBe(true);
    expect(q.shouldPreempt({ boardId: 'a', board: 1, ply: 5, tier: 'current', since: 0 })).toBe(false);
  });

  it('puts a pre-empted backfill Job back at its old spot', () => {
    const q = new Queue();
    q.setLatest('a', 1, 5, 0, true);
    q.addBackfill('a', [3, 2], 0);
    const running = q.next()!;
    q.setLatest('b', 2, 9, 1);
    expect(q.requeue(running, 2)).toBe(true);
    expect(q.next()?.boardId).toBe('b');
    expect(q.next()).toMatchObject({ boardId: 'a', ply: 3, since: 0 });
    expect(q.next()).toMatchObject({ boardId: 'a', ply: 2 });
  });

  it('routes a requeued Job by the Board latest ply, and drops untracked Boards', () => {
    const q = new Queue();
    q.setLatest('a', 1, 5, 0);
    const running = q.next()!;
    q.setLatest('a', 1, 6, 1);
    expect(q.requeue(running, 2)).toBe(true);
    expect(q.current().map((j) => j.ply)).toEqual([6]);
    expect(q.backfillCount()).toBe(1);
    expect(q.requeue({ boardId: 'zz', board: 9, ply: 1, tier: 'current', since: 0 }, 2)).toBe(false);
    expect(q.current()).toHaveLength(1);
  });

  it('requeues a crashed Job to the front, then moves it to the Dead-letter queue on the last crash', () => {
    const q = new Queue();
    q.setLatest('a', 1, 5, 0);
    q.setLatest('b', 2, 9, 1);
    expect(q.crashed(q.next()!, 1)).toBe('requeued');
    const again = q.next()!;
    expect(again).toMatchObject({ boardId: 'a', ply: 5, since: 0 });
    expect(q.crashed(again, 2)).toBe('requeued');
    expect(q.crashed(q.next()!, 3)).toBe('dead');
    expect(q.dead()).toEqual([{ boardId: 'a', board: 1, ply: 5, at: 3 }]);
    expect(q.next()?.boardId).toBe('b');
    expect(q.next()).toBeNull();
    q.setLatest('a', 1, 7, 5);
    q.addBackfill('a', [5], 6);
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
  });

  it('removeBoard drops only that Board: Jobs, Dead-letter queue entries and latest', () => {
    const q = new Queue();
    kill(q, 'a', 1, 5);
    kill(q, 'c', 3, 7);
    q.setLatest('a', 1, 6, 5);
    q.addBackfill('a', [2], 5);
    q.setLatest('b', 2, 4, 5);
    q.removeBoard('a');
    expect(q.current().map((j) => j.boardId)).toEqual(['b']);
    expect(q.backfillCount()).toBe(0);
    expect(q.dead().map((d) => d.boardId)).toEqual(['c']);
    expect(q.position('a', 6)).toBeNull();
    q.addBackfill('a', [1], 6);
    expect(q.backfillCount()).toBe(0);
    q.next();
    q.setLatest('c', 3, 8, 6);
    q.crashed(q.next()!, 6);
    q.removeBoard('c');
    q.setLatest('c', 3, 8, 7);
    for (let i = 0; i < MAX_CRASHES - 1; i++) expect(q.crashed(q.next()!, 8)).toBe('requeued');
  });

  it('clear empties the queue and the Dead-letter queue', () => {
    const q = new Queue();
    kill(q, 'a', 1, 5);
    q.setLatest('b', 2, 4, 0);
    q.crashed(q.next()!, 0);
    q.clear();
    expect(q.next()).toBeNull();
    expect(q.dead()).toEqual([]);
    expect(q.position('b', 4)).toBeNull();
    q.setLatest('b', 2, 4, 1);
    for (let i = 0; i < MAX_CRASHES - 1; i++) expect(q.crashed(q.next()!, 2)).toBe('requeued');
  });

  it('reports a 1-based position across both tiers, and null for a running Job', () => {
    const q = new Queue();
    q.setLatest('a', 1, 5, 0);
    q.setLatest('b', 2, 9, 1);
    q.addBackfill('b', [3], 2);
    expect(q.position('a', 5)).toBe(1);
    expect(q.position('b', 9)).toBe(2);
    expect(q.position('b', 3)).toBe(3);
    q.next();
    expect(q.position('a', 5)).toBeNull();
  });

  it('drops backfill plies at or past a corrected (lower) latest ply', () => {
    const q = new Queue();
    q.setLatest('a', 1, 9, 0, true);
    q.addBackfill('a', [3, 7, 8], 0);
    q.setLatest('a', 1, 6, 1);
    expect(q.current()).toEqual([expect.objectContaining({ ply: 6, since: 1 })]);
    expect(q.backfillCount()).toBe(1);
    expect(q.position('a', 3)).toBe(2);
  });

  it('forgets dead plies past a corrected latest ply', () => {
    const q = new Queue();
    kill(q, 'a', 1, 5);
    q.setLatest('a', 1, 4, 3);
    expect(q.dead()).toEqual([]);
    q.next();
    q.setLatest('a', 1, 5, 4);
    expect(q.current()).toEqual([expect.objectContaining({ ply: 5 })]);
  });

  it('returns copies from its read-only views', () => {
    const q = new Queue();
    q.setLatest('a', 1, 5, 0);
    const [view] = q.current() as Job[];
    view.since = 99;
    expect(q.current()[0].since).toBe(0);
  });
});
