export type Tier = 'current' | 'backfill';

/** One search of one position of a Tracked board. since: current tier = waiting since; backfill = entered backfill. */
export interface Job {
  boardId: string;
  board: number;
  ply: number;
  tier: Tier;
  since: number;
}

/** A Job that crashed the engine MAX_CRASHES times. at = when it went dead. */
export interface DeadJob {
  boardId: string;
  board: number;
  ply: number;
  at: number;
}

export const MAX_CRASHES = 3;

const key = (boardId: string, ply: number) => `${boardId}:${ply}`;

/** Current tier: longest-waiting first, then lower board. Backfill: most recently queued first, then higher ply. */
function compare(a: Job, b: Job): number {
  if (a.tier !== b.tier) return a.tier === 'current' ? -1 : 1;
  if (a.tier === 'current') return a.since - b.since || a.board - b.board;
  return b.since - a.since || b.ply - a.ply || a.board - b.board;
}

/**
 * Two-tier queue of Jobs. Pure: no timers or I/O; the caller passes `now` (ms).
 * The scheduler owns the running Job: next() removes it, and the caller hands it back via requeue or crashed.
 */
export class Queue {
  private readonly jobs = new Map<string, Job>();
  private readonly latest = new Map<string, { board: number; ply: number }>();
  private readonly crashes = new Map<string, number>();
  private readonly deadJobs = new Map<string, DeadJob>();

  /** Board's latest ply. Supersedes its waiting current Job (→ backfill). done = record only, enqueue nothing. */
  setLatest(boardId: string, board: number, ply: number, now: number, done = false): void {
    const prev = this.latest.get(boardId);
    if (prev?.ply === ply) return;
    this.latest.set(boardId, { board, ply });
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
      }
    }
    if (!done) this.add({ boardId, board, ply, tier: 'current', since }, now);
  }

  /** Earlier plies with no Complete eval. Ignored for unknown Boards, plies >= latest, queued or dead keys. */
  addBackfill(boardId: string, plies: number[], now: number): void {
    const latest = this.latest.get(boardId);
    if (!latest) return;
    for (const ply of plies) {
      if (ply < latest.ply) this.add({ boardId, board: latest.board, ply, tier: 'backfill', since: now }, now);
    }
  }

  /** Remove and return the next Job: current tier first, else backfill; null when empty. */
  next(): Job | null {
    const job = this.ordered()[0];
    if (!job) return null;
    this.jobs.delete(key(job.boardId, job.ply));
    return job;
  }

  /** True when the running Job is a backfill Job and any current-tier Job waits. */
  shouldPreempt(running: Job): boolean {
    return running.tier === 'backfill' && [...this.jobs.values()].some((j) => j.tier === 'current');
  }

  /** Put a pre-empted Job back (routing as in place()). false = dropped or already queued or dead. */
  requeue(job: Job, now: number): boolean {
    return this.add(job, now);
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
    this.deadJobs.set(k, { boardId: placed.boardId, board: placed.board, ply: placed.ply, at: now });
    return 'dead';
  }

  /** Drop every Job, crash count and Dead-letter queue entry of a Board, and forget its latest ply. */
  removeBoard(boardId: string): void {
    const own = (k: string) => k.startsWith(`${boardId}:`);
    for (const k of [...this.jobs.keys()]) if (own(k)) this.jobs.delete(k);
    for (const k of [...this.crashes.keys()]) if (own(k)) this.crashes.delete(k);
    for (const k of [...this.deadJobs.keys()]) if (own(k)) this.deadJobs.delete(k);
    this.latest.delete(boardId);
  }

  /** Empty everything, Dead-letter queue included (Round swap). */
  clear(): void {
    this.jobs.clear();
    this.latest.clear();
    this.crashes.clear();
    this.deadJobs.clear();
  }

  /** Admin requeue from the Dead-letter queue (crash count reset). false = not dead, or dropped. */
  requeueDead(boardId: string, ply: number, now: number): boolean {
    const k = key(boardId, ply);
    const dead = this.deadJobs.get(k);
    if (!dead) return false;
    this.deadJobs.delete(k);
    this.crashes.delete(k);
    return this.add({ boardId, board: dead.board, ply, tier: 'current', since: now }, now);
  }

  /** Admin discard from the Dead-letter queue (crash count reset). false = not dead. */
  discardDead(boardId: string, ply: number): boolean {
    const k = key(boardId, ply);
    this.crashes.delete(k);
    return this.deadJobs.delete(k);
  }

  /** Current tier, in pick order (copies). */
  current(): Job[] {
    return this.ordered().filter((j) => j.tier === 'current');
  }

  backfillCount(): number {
    return [...this.jobs.values()].filter((j) => j.tier === 'backfill').length;
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
   * or already queued or dead. ply === latest → current tier; ply < latest → backfill. since is kept when the
   * Job was already in that tier, else now.
   */
  private place(job: Job, now: number): Job | null {
    const k = key(job.boardId, job.ply);
    const latest = this.latest.get(job.boardId);
    if (!latest || job.ply > latest.ply || this.jobs.has(k) || this.deadJobs.has(k)) return null;
    if (job.ply === latest.ply) {
      return { ...job, board: latest.board, tier: 'current', since: job.tier === 'current' ? job.since : now };
    }
    return { ...job, board: latest.board, tier: 'backfill', since: job.tier === 'backfill' ? job.since : now };
  }
}
