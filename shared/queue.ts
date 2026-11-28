import { DEEP_PASS } from './passes.js';

export type Tier = 'current' | 'backfill';

/** One search of one position of a Tracked board. since: current tier = waiting since; backfill = entered backfill.
 *  pass: which Pass (search time) it is for (shared/passes.ts); one Job per position at a time. deep: a deep analysis
 *  Job (tier backfill, pass DEEP_PASS, since = its request's `at`) of any Board of Round `roundId`, archived too; it
 *  lives in the deep map, apart from every rule of the regular Jobs, and may share its key with a regular Job. */
export interface Job {
  tourId: string; // the owning Event (Lichess tour id); Board ids are globally unique, so Queue keys stay boardId:ply
  boardId: string;
  board: number;
  ply: number;
  tier: Tier;
  pass: number;
  since: number;
  deep?: true;
  roundId?: string; // deep Jobs only
}

/** A Job that crashed the engine MAX_CRASHES times. at = when it went dead. */
export interface DeadJob {
  tourId: string;
  boardId: string;
  board: number;
  ply: number;
  at: number;
}

export const MAX_CRASHES = 3;

/** A running live Job gets at least this long (capped at the job time) before another live position evicts it. */
export const MIN_LIVE_SLICE_MS = 3000;

/** Why a running Job is stopped early. stale: its Board moved on; live: another live position waits and the slice is
 *  up; backfill: a live position waits; upgrade: a deepening Job (Pass ≥ 1) gives way to a lower Pass, or its Pass is
 *  no longer allowed (an Event went live). */
export type Eviction = 'stale' | 'live' | 'backfill' | 'upgrade';

/** A Job that was evicted, for the Admin status page. depth = the eval it kept (null: none). */
export interface EvictedJob {
  tourId: string;
  boardId: string;
  board: number;
  ply: number;
  reason: Eviction;
  depth: number | null;
  at: number;
}

const key = (boardId: string, ply: number) => `${boardId}:${ply}`;

/** Lower Pass first. Then current tier: longest-waiting first, then lower board. Backfill: most recently queued first,
 *  then higher ply. */
function compare(a: Job, b: Job): number {
  if (a.pass !== b.pass) return a.pass - b.pass;
  if (a.tier !== b.tier) return a.tier === 'current' ? -1 : 1;
  if (a.tier === 'current') return a.since - b.since || a.board - b.board;
  return b.since - a.since || b.ply - a.ply || a.board - b.board;
}

/**
 * Two-tier queue of Jobs, ordered by Pass first, plus a separate FIFO deep map (deep analysis requests) that only runs
 * when no regular Job may. Pure: no timers or I/O; the caller passes `now` (ms). The scheduler owns the running Job:
 * next() removes it, and the caller hands it back via requeue or crashed (a deep Job: requeueDeep or crashedDeep).
 * Nothing but the deep methods touches the deep map: not setLatest, removeBoard, removeEvent, clear, repass or the
 * Dead-letter queue.
 */
export class Queue {
  private readonly jobs = new Map<string, Job>();
  private readonly latest = new Map<string, { tourId: string; board: number; ply: number }>();
  private readonly crashes = new Map<string, number>();
  private readonly deadJobs = new Map<string, DeadJob>();
  private readonly discarded = new Set<string>(); // discarded from the Dead-letter queue: not queued again this Round
  private deepJobs: Job[] = []; // deep analysis: FIFO by request, plies ascending within one; front = next
  private readonly deepCrashes = new Map<string, number>();

  /** Board's latest ply (the Board belongs to Event tourId). Supersedes its waiting current Job (→ backfill).
   *  done = record only, enqueue nothing; else its Job is for `pass`. */
  setLatest(tourId: string, boardId: string, board: number, ply: number, now: number, done = false, pass = 0): void {
    const prev = this.latest.get(boardId);
    if (prev?.ply === ply) return;
    this.latest.set(boardId, { tourId, board, ply });
    const old = prev ? this.jobs.get(key(boardId, prev.ply)) : undefined;
    const since = old?.tier === 'current' ? old.since : now;
    for (const job of this.ownJobs(boardId)) {
      if (job.ply >= ply) this.jobs.delete(key(boardId, job.ply));
      else if (job.tier === 'current') this.jobs.set(key(boardId, job.ply), { ...job, tier: 'backfill', since: now });
    }
    if (prev && ply < prev.ply) {
      // Move correction: plies past the new latest are gone, so are their crash counts and dead entries.
      for (let p = ply + 1; p <= prev.ply; p++) {
        this.crashes.delete(key(boardId, p));
        this.deadJobs.delete(key(boardId, p));
        this.discarded.delete(key(boardId, p));
      }
    }
    if (!done) this.add({ tourId, boardId, board, ply, tier: 'current', pass, since }, now);
  }

  /** Earlier plies that need a search, each for passOf(ply). Ignored for unknown Boards, plies >= latest, queued or dead
   *  keys. */
  addBackfill(
    tourId: string,
    boardId: string,
    plies: number[],
    now: number,
    passOf: (ply: number) => number = () => 0,
  ) {
    const latest = this.latest.get(boardId);
    if (!latest) return;
    for (const ply of plies) {
      if (ply < latest.ply) {
        const job: Job = { tourId, boardId, board: latest.board, ply, tier: 'backfill', pass: passOf(ply), since: now };
        this.add(job, now);
      }
    }
  }

  /** Remove and return the next Job of Pass ≤ maxPass: lower Pass first, then current tier, then backfill; then, only
   *  while maxPass allows the deep Pass and no regular Job may run, the next deep Job; null when none. */
  next(maxPass = Infinity): Job | null {
    const job = this.ordered().find((j) => j.pass <= maxPass);
    if (!job) return maxPass >= DEEP_PASS ? (this.deepJobs.shift() ?? null) : null;
    this.jobs.delete(key(job.boardId, job.ply));
    return job;
  }

  /** Whether to stop the running Job now, and why; null = let it run. elapsedMs = how long it has run; Jobs above maxPass
   *  may not run. A deep Job gives way (upgrade) to any regular Job that may run. */
  preempt(running: Job, elapsedMs: number, sliceMs: number, maxPass = Infinity): Eviction | null {
    if (running.deep)
      return running.pass > maxPass || [...this.jobs.values()].some((j) => j.pass <= maxPass) ? 'upgrade' : null;
    if (running.tier === 'current' && this.latest.get(running.boardId)?.ply !== running.ply) return 'stale';
    const waiting = [...this.jobs.values()].filter((j) => j.pass <= maxPass);
    if (running.pass > 0)
      return running.pass > maxPass || waiting.some((j) => j.pass < running.pass) ? 'upgrade' : null;
    if (!waiting.some((j) => j.pass === 0 && j.tier === 'current')) return null;
    if (running.tier === 'backfill') return 'backfill';
    return elapsedMs >= sliceMs ? 'live' : null;
  }

  /** Put a Job back (routing as in place()), for its own Pass. false = dropped or already queued or dead. */
  requeue(job: Job, now: number): boolean {
    return this.add(job, now);
  }

  /** A live Job evicted for another live position: to the top of backfill, though it is still its Board's latest ply.
   *  false = dropped or already queued or dead. */
  evict(job: Job, now: number): boolean {
    return this.add({ ...job, tier: 'backfill', since: now }, now);
  }

  /** The running Job crashed the engine: requeue, or move to the Dead-letter queue on the MAX_CRASHES-th crash. */
  crashed(job: Job, now: number): 'requeued' | 'dead' | 'dropped' {
    const placed = this.place(job, now);
    if (!placed) return 'dropped';
    const k = key(job.boardId, job.ply);
    const n = (this.crashes.get(k) ?? 0) + 1;
    this.crashes.set(k, n);
    if (n < MAX_CRASHES) {
      this.jobs.set(k, placed);
      return 'requeued';
    }
    this.deadJobs.set(k, {
      tourId: placed.tourId,
      boardId: placed.boardId,
      board: placed.board,
      ply: placed.ply,
      at: now,
    });
    return 'dead';
  }

  /** Deep analysis of a Board of Round roundId: a deep Job per ply (ascending), behind every other request. Replaces
   *  that Board's waiting deep Jobs and crash counts (a repeat request restarts it). */
  addDeep(
    tourId: string,
    roundId: string,
    boardId: string,
    board: number,
    plies: readonly number[],
    since: number,
  ): void {
    this.cancelDeep(boardId);
    for (const ply of [...plies].sort((a, b) => a - b)) {
      this.deepJobs.push({
        tourId,
        roundId,
        boardId,
        board,
        ply,
        tier: 'backfill',
        pass: DEEP_PASS,
        since,
        deep: true,
      });
    }
  }

  /** Put a deep Job back at the front of the deep map (its search was stopped or refused). false = already queued. */
  requeueDeep(job: Job): boolean {
    if (this.deepJobs.some((j) => j.boardId === job.boardId && j.ply === job.ply)) return false;
    this.deepJobs.unshift({ ...job });
    return true;
  }

  /** The running deep Job crashed the engine: true = requeued at the front; false = its MAX_CRASHES-th crash, given up
   *  (never to the Dead-letter queue). */
  crashedDeep(job: Job): boolean {
    const k = key(job.boardId, job.ply);
    const n = (this.deepCrashes.get(k) ?? 0) + 1;
    if (n >= MAX_CRASHES) {
      this.deepCrashes.delete(k);
      return false;
    }
    this.deepCrashes.set(k, n);
    return this.requeueDeep(job);
  }

  /** Drop a Board's deep Jobs and their crash counts. */
  cancelDeep(boardId: string): void {
    this.deepJobs = this.deepJobs.filter((j) => j.boardId !== boardId);
    for (const k of [...this.deepCrashes.keys()]) if (k.startsWith(`${boardId}:`)) this.deepCrashes.delete(k);
  }

  /** Waiting deep Jobs, in pick order (copies). */
  deep(): Job[] {
    return this.deepJobs.map((j) => ({ ...j }));
  }

  /** Drop every Job, crash count and Dead-letter queue entry of a Board, and forget its latest ply. */
  removeBoard(boardId: string): void {
    const own = (k: string) => k.startsWith(`${boardId}:`);
    for (const k of [...this.jobs.keys()]) if (own(k)) this.jobs.delete(k);
    for (const k of [...this.crashes.keys()]) if (own(k)) this.crashes.delete(k);
    for (const k of [...this.deadJobs.keys()]) if (own(k)) this.deadJobs.delete(k);
    for (const k of [...this.discarded]) if (own(k)) this.discarded.delete(k);
    this.latest.delete(boardId);
  }

  /** Drop every Job, crash count, Dead-letter queue entry and discard mark of an Event's Boards, and forget their
   *  latest plies. Other Events are untouched. */
  removeEvent(tourId: string): void {
    const boardIds = new Set<string>();
    for (const [boardId, l] of this.latest) if (l.tourId === tourId) boardIds.add(boardId);
    for (const d of this.deadJobs.values()) if (d.tourId === tourId) boardIds.add(d.boardId);
    for (const j of this.jobs.values()) if (j.tourId === tourId) boardIds.add(j.boardId);
    for (const boardId of boardIds) this.removeBoard(boardId);
  }

  /** Empty everything but the deep map, Dead-letter queue included (Round swap). */
  clear(): void {
    this.jobs.clear();
    this.latest.clear();
    this.crashes.clear();
    this.deadJobs.clear();
    this.discarded.clear();
  }

  /** Admin requeue from the Dead-letter queue (crash count reset). false = not dead, or dropped. */
  requeueDead(boardId: string, ply: number, now: number): boolean {
    const k = key(boardId, ply);
    const dead = this.deadJobs.get(k);
    if (!dead) return false;
    this.deadJobs.delete(k);
    this.crashes.delete(k);
    return this.add(
      { tourId: dead.tourId, boardId, board: dead.board, ply, tier: 'current', pass: 0, since: now },
      now,
    );
  }

  /** Admin discard from the Dead-letter queue: never queued again until the Board is untracked, the ply is
   *  corrected away or the Queue is cleared. false = not dead. */
  discardDead(boardId: string, ply: number): boolean {
    const k = key(boardId, ply);
    if (!this.deadJobs.delete(k)) return false;
    this.crashes.delete(k);
    this.discarded.add(k);
    return true;
  }

  /** Boot: put persisted Dead-letter queue entries back (crash count MAX_CRASHES). Call before any setLatest or
   *  addBackfill, so place() refuses those keys. Entries saved before Jobs carried a tourId get `tourId`. */
  restoreDead(dead: readonly (Omit<DeadJob, 'tourId'> & { tourId?: string })[], tourId: string): void {
    for (const d of dead) {
      const k = key(d.boardId, d.ply);
      this.jobs.delete(k);
      this.crashes.set(k, MAX_CRASHES);
      this.deadJobs.set(k, { ...d, tourId: d.tourId ?? tourId });
    }
  }

  /** Current tier of Pass 0, in pick order (copies). */
  current(): Job[] {
    return this.ordered().filter((j) => j.pass === 0 && j.tier === 'current');
  }

  /** Pass 0 backfill Jobs at their Board's latest ply (evicted live Jobs waiting for a full search), in pick order. */
  deferred(): Job[] {
    return this.ordered().filter(
      (j) => j.pass === 0 && j.tier === 'backfill' && j.ply === this.latest.get(j.boardId)?.ply,
    );
  }

  /** Pass 0 backfill Jobs. */
  backfillCount(): number {
    return [...this.jobs.values()].filter((j) => j.pass === 0 && j.tier === 'backfill').length;
  }

  /** Waiting Jobs per Pass, deep Jobs included: index = Pass, up to the highest Pass queued. */
  passCounts(): number[] {
    const n: number[] = [];
    for (const j of this.jobs.values()) n[j.pass] = (n[j.pass] ?? 0) + 1;
    if (this.deepJobs.length) n[DEEP_PASS] = (n[DEEP_PASS] ?? 0) + this.deepJobs.length;
    return Array.from(n, (x) => x ?? 0);
  }

  /** The Passes changed: each waiting Job gets passOf(job) (null: none left, dropped). Order within a Pass is kept. */
  repass(passOf: (job: Readonly<Job>) => number | null): void {
    for (const [k, j] of this.jobs) {
      const pass = passOf(j);
      if (pass === null) this.jobs.delete(k);
      else if (pass !== j.pass) this.jobs.set(k, { ...j, pass });
    }
  }

  /** Dead-letter queue by `at` ascending (copies). */
  dead(): DeadJob[] {
    return [...this.deadJobs.values()].map((d) => ({ ...d })).sort((a, b) => a.at - b.at);
  }

  /** 1-based place of (boardId, ply) in full pick order (current then backfill); null if not queued. */
  position(boardId: string, ply: number): number | null {
    const i = this.ordered().findIndex((j) => j.boardId === boardId && j.ply === ply);
    return i < 0 ? null : i + 1;
  }

  private ordered(): Job[] {
    return [...this.jobs.values()].map((j) => ({ ...j })).sort(compare);
  }

  private ownJobs(boardId: string): Job[] {
    return [...this.jobs.values()].filter((j) => j.boardId === boardId);
  }

  private add(job: Job, now: number): boolean {
    const placed = this.place(job, now);
    if (!placed) return false;
    this.jobs.set(key(placed.boardId, placed.ply), placed);
    return true;
  }

  /**
   * Route a Job by its ply against the Board's latest ply. null = dropped (Board untracked or ply past latest),
   * or already queued, dead or discarded. A current Job at ply === latest stays current; ply < latest → backfill. A
   * backfill Job never goes up (an evicted latest ply stays there). since is kept when the Job was already in that tier,
   * else now.
   */
  private place(job: Job, now: number): Job | null {
    const k = key(job.boardId, job.ply);
    const latest = this.latest.get(job.boardId);
    if (!latest || job.ply > latest.ply || this.jobs.has(k) || this.deadJobs.has(k) || this.discarded.has(k)) {
      return null;
    }
    if (job.ply === latest.ply && job.tier === 'current') {
      return { ...job, board: latest.board, tier: 'current', since: job.tier === 'current' ? job.since : now };
    }
    return { ...job, board: latest.board, tier: 'backfill', since: job.tier === 'backfill' ? job.since : now };
  }
}
