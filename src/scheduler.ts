import { Chess } from 'chess.js';
import { copyOptions } from '../shared/engine-config.js';
import { MIN_LIVE_SLICE_MS, Queue, type EvictedJob, type Eviction, type Job } from '../shared/queue.js';
import { jobTiming, type JobSample, type JobTiming } from '../shared/timing.js';
import type * as T from '../shared/types.js';
import { Engine, type SearchResult } from './engine/engine.js';
import type { UciInfo } from './engine/uci-parser.js';
import type { RoundInfo } from './lichess/api.js';
import type { SourceFactory } from './lichess/stream.js';
import { evictions, jobDepth, jobDuration, jobNps, jobs } from './metrics.js';
import { Feed } from './feed.js';
import type { OpeningFetch } from './opening.js';
import { pvToSan, toScore } from './pv.js';
import type { RoundState } from './round-state.js';
import type { SiteState } from './site-state.js';

export const RESTART_MIN_MS = 1000;
export const RESTART_MAX_MS = 60_000;

/** null: no engine wanted (no Round, or after stop()). */
export const TIMING_WINDOW = 200;
export const EVICTIONS_KEPT = 10;
export type EngineState = 'up' | 'restarting' | null;
export const ROLES: readonly T.EngineRole[] = ['main', 'multi'];

/** One copy of the engine binary: its process (null: down or not wanted) and its own restart backoff. */
interface Copy {
  engine: Engine | null;
  backoff: number;
  restarts: number; // relaunches scheduled since process start
  cancelRestart: (() => void) | null;
  launchFailed: boolean;
}
const newCopy = (): Copy => ({
  engine: null,
  backoff: RESTART_MIN_MS,
  restarts: 0,
  cancelRestart: null,
  launchFailed: false,
});

export interface SchedulerOpts {
  defaultEngine: T.EngineConfig; // used while state.settings.engine is null
  launch?: (cfg: T.EngineConfig, role: T.EngineRole) => Promise<Engine>; // default Engine.start(cfg.path); tests: fake
  source?: SourceFactory; // default lichessSource
  now?: () => number; // default Date.now
  after?: (ms: number, fn: () => void) => () => void; // restart backoff; default setTimeout(unref) → cancel; tests inject
  afterSlice?: (ms: number, fn: () => void) => () => void; // live slice timer; same default as `after`
  fetchOpening?: OpeningFetch; // masters explorer for untagged Boards; undefined = no fallback (tests, demo)
}

/** One copy's output so far: lines by multipv - 1. */
interface Half {
  lines: T.PvLine[];
  nps: number | null;
}

/** The Job being searched, by both copies (multi null: it was down when the Job started). stop = why it was told to
 *  stop (null = it ran its full time); evicted = why, for 'preempt'. sliceMs = how long before another live position
 *  may evict it (Infinity: never). */
interface Run {
  job: Job;
  epoch: number;
  fen: string;
  engine: string; // the main copy's name
  main: Half;
  multi: Half | null;
  startedAt: number;
  sliceMs: number;
  stop: null | 'preempt' | 'restart' | 'drop';
  evicted: Eviction | null;
}

const timeout = (ms: number, fn: () => void) => {
  const h = setTimeout(fn, ms);
  h.unref();
  return () => clearTimeout(h);
};

const toLine = (i: UciInfo, ply: number, fen: string): T.PvLine | null => {
  const score = i.score && toScore(i.score, ply);
  return score ? { score, depth: i.depth ?? 0, move: i.pv[0] ?? '', san: pvToSan(fen, i.pv) } : null;
};

const toLines = (r: SearchResult, ply: number, fen: string) => r.lines.flatMap((l) => toLine(l, ply, fen) ?? []);

/** From the main copy's search `r` and the multi copy's `multi` (null: none). null when `r` has no scored line. */
export function toEval(
  r: SearchResult,
  ply: number,
  fen: string,
  kind: T.EvalKind,
  multi: SearchResult | null = null,
): T.Eval | null {
  const lines = toLines(r, ply, fen);
  if (!lines.length) return null;
  const others = multi ? toLines(multi, ply, fen) : [];
  return {
    score: lines[0].score,
    depth: lines[0].depth,
    kind,
    bestmove: r.bestmove === '(none)' ? null : r.bestmove,
    lines,
    multi: others.length ? { depth: others[0].depth, lines: others } : null,
  };
}

const play = (chess: Chess, uci: string) =>
  chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });

const noLegalMoves = (b: Readonly<T.Board>): boolean => {
  const chess = new Chess();
  for (const p of b.plies.slice(1)) play(chess, p.move!.uci);
  return chess.moves().length === 0;
};

/**
 * Drives the Current Round: every Board's moves are recorded from the source; Tracked boards get Jobs from the Queue,
 * run one at a time as `go movetime` searches on both copies at once. The main copy decides the Job's outcome; the
 * multi copy only adds Lines, and the Queue runs without it while it is down. Public methods are serialised; the search loop and the
 * source/engine handlers run outside that and stay synchronous apart from the single `engine.search` await.
 */
export class Scheduler {
  private readonly queue = new Queue();
  private readonly feeds = new Map<string, Feed>();
  private readonly copies: Record<T.EngineRole, Copy> = { main: newCopy(), multi: newCopy() };
  private run: Run | null = null;
  private loop: Promise<void> = Promise.resolve();
  private busy = false;
  private halting = false;
  private ops: Promise<unknown> = Promise.resolve();
  private wanted = false; // some Event has a Round and stop() was not called: keep an engine running
  private samples: JobSample[] = []; // the last TIMING_WINDOW recorded Jobs; resets on boot, not on a Round swap
  private evicted: EvictedJob[] = []; // the last EVICTIONS_KEPT evictions, newest first; resets on boot

  constructor(
    private readonly site: SiteState,
    private readonly opts: SchedulerOpts,
  ) {}

  /** The main copy. Null before the first Round, after stop() or after an exit. */
  get engine(): Engine | null {
    return this.copies.main.engine;
  }

  /** The copies that are up. */
  get engines(): Engine[] {
    return ROLES.flatMap((r) => this.copies[r].engine ?? []);
  }

  /** Jobs run only while the main copy is up. */
  copyState(role: T.EngineRole): EngineState {
    const c = this.copies[role];
    if (!this.wanted) return null;
    return c.engine && !c.cancelRestart && !c.launchFailed ? 'up' : 'restarting';
  }

  /** Relaunches of that copy scheduled since process start. */
  copyRestarts(role: T.EngineRole): number {
    return this.copies[role].restarts;
  }

  /** Job time and depth over the last TIMING_WINDOW Jobs. */
  get timing(): JobTiming {
    return jobTiming(this.samples);
  }

  /** The last EVICTIONS_KEPT evictions, newest first (copies). */
  get evictions(): EvictedJob[] {
    return this.evicted.map((e) => ({ ...e }));
  }

  /** Copy of the Job being searched. */
  get running(): Job | null {
    return this.run && { ...this.run.job };
  }

  /** Replace that Event's Current Round (also its first one): drop its running Job and Queue entries, follow the new
   *  Round's source. Other Events are untouched. existing = that Round's file: continue it, never wipe it. */
  startRound(tourId: string, r: RoundInfo, startsAt: number | null, existing: T.Round | null = null): Promise<void> {
    return this.serial(async () => {
      const rs = this.site.event(tourId);
      if (!rs) return;
      this.feeds.get(tourId)?.stop();
      if (this.run?.job.tourId === tourId) await this.halt('drop');
      if (this.site.event(tourId) !== rs) return; // removed during the halt
      this.queue.removeEvent(tourId);
      this.publishQueue(); // before the new Round's snapshot, which carries the Queue
      if (existing) rs.openRound(existing);
      else rs.startRound(r, startsAt);
      let feed = this.feeds.get(tourId);
      if (feed?.state !== rs) this.feeds.set(tourId, (feed = this.newFeed(rs)));
      feed.start(r.id);
      this.enqueueTracked(rs);
      this.wake();
      this.wanted = true;
      for (const role of ROLES) {
        this.cancelPendingRestart(role);
        this.copies[role].backoff = RESTART_MIN_MS;
        if (!this.copies[role].engine) await this.ensureEngine(role);
      }
      this.kick();
    });
  }

  /** The Event is being removed: stop its Feed, drop its Job and Queue entries, remove it from the site. Quit the
   *  engines when no Event has a Round any more. */
  removeEvent(tourId: string): Promise<void> {
    return this.serial(async () => {
      this.feeds.get(tourId)?.stop();
      this.feeds.delete(tourId);
      if (this.run?.job.tourId === tourId) await this.halt('drop');
      this.queue.removeEvent(tourId);
      this.site.removeEvent(tourId);
      this.wanted = this.site.events.some((rs) => rs.round);
      if (!this.wanted) await this.idleEngines();
      this.publishQueue();
      this.kick();
    });
  }

  /** Applies from the next Job. */
  setJobTime(ms: number | null): Promise<void> {
    return this.serial(async () => {
      this.site.setJobTime(ms);
      this.wake();
    });
  }

  /** That Event's exact tracked set. Untracked Boards leave the Queue; newly tracked ones are queued with their
   *  earlier plies. */
  setTracked(tourId: string, boardIds: readonly string[]): Promise<void> {
    return this.serial(async () => {
      const rs = this.site.event(tourId);
      if (!rs) return;
      const boards = rs.round?.boards ?? [];
      const before = new Set(boards.filter((b) => b.tracked).map((b) => b.id));
      rs.setTracked(boardIds);
      for (const b of boards) {
        if (before.has(b.id) && !b.tracked) this.queue.removeBoard(b.id);
        else if (!before.has(b.id) && b.tracked) this.enqueue(rs, b);
      }
      this.persistDead();
      this.wake();
    });
  }

  /** Boot: follow every Event that has a Current Round: rebuild its Queue entries from its plies and follow its
   *  source again. */
  resume(): Promise<void> {
    return this.serial(async () => {
      let any = false;
      for (const rs of this.site.events) {
        if (!rs.round) continue;
        any = true;
        this.feeds.get(rs.event.tourId)?.stop();
        const feed = this.newFeed(rs);
        this.feeds.set(rs.event.tourId, feed);
        feed.start(rs.round.roundId);
        this.queue.restoreDead(rs.dead, rs.event.tourId); // before enqueueTracked: dead positions are not queued again
        this.enqueueTracked(rs);
      }
      if (!any) return;
      this.wake();
      this.wanted = true;
      for (const role of ROLES) await this.ensureEngine(role);
      this.kick();
    });
  }

  /** Save the config; if a Round is followed, restart both copies now (the running Job is requeued unrecorded). A
   *  failed launch rejects (the first error) and that copy keeps retrying with backoff. */
  setEngine(cfg: T.EngineConfig): Promise<void> {
    return this.serial(async () => {
      this.site.setEngine(cfg);
      if (!this.wanted) return;
      await this.halt('restart');
      await this.quitEngines();
      let failed: unknown = null;
      for (const role of ROLES) {
        const c = this.copies[role];
        this.cancelPendingRestart(role); // after the halt: an exit during it scheduled one too
        c.backoff = RESTART_MIN_MS;
        try {
          await this.launchEngine(role);
          c.launchFailed = false;
        } catch (err) {
          c.launchFailed = true;
          this.scheduleRestart(role);
          failed ??= err;
        }
      }
      this.wake(); // publishes the requeued Job, then kicks
      if (failed) throw failed;
    });
  }

  /** Admin: put a Dead-letter queue entry back with a fresh crash count. false = not in the Dead-letter queue. */
  requeueDead(boardId: string, ply: number): Promise<boolean> {
    return this.serialValue(async () => {
      const ok = this.queue.requeueDead(boardId, ply, this.now);
      this.persistDead();
      this.wake();
      return ok;
    });
  }

  /** Admin: drop a Dead-letter queue entry. false = not in the Dead-letter queue. */
  discardDead(boardId: string, ply: number): Promise<boolean> {
    return this.serialValue(async () => {
      const ok = this.queue.discardDead(boardId, ply);
      this.persistDead();
      return ok;
    });
  }

  /** Shutdown: drop the Job, stop every source, quit the engines, clear the Queue. */
  stop(): Promise<void> {
    return this.serial(async () => {
      this.wanted = false;
      for (const feed of this.feeds.values()) feed.stop();
      this.feeds.clear();
      await this.halt('drop');
      await this.idleEngines();
      this.queue.clear();
      this.publishQueue();
    });
  }

  /** Inside serial only, after halt() and with no Round wanted: no restarts pending, engines quit, no search. */
  private async idleEngines(): Promise<void> {
    for (const role of ROLES) {
      this.cancelPendingRestart(role);
      Object.assign(this.copies[role], { backoff: RESTART_MIN_MS, launchFailed: false });
    }
    await this.quitEngines();
    this.site.setSearch(null, null);
  }

  private serial(op: () => Promise<void>): Promise<void> {
    return this.serialValue(op);
  }

  private serialValue<V>(op: () => Promise<V>): Promise<V> {
    const p = this.ops.then(op);
    this.ops = p.catch(() => {});
    return p;
  }

  private get now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private newFeed(rs: RoundState): Feed {
    return new Feed(rs, {
      source: this.opts.source,
      now: () => this.now,
      fetchOpening: this.opts.fetchOpening,
      onMoves: (tourId, id, kept, before) => this.onMoves(tourId, id, kept, before),
    });
  }

  private enqueueTracked(rs: RoundState): void {
    for (const b of rs.round?.boards ?? []) if (b.tracked) this.enqueue(rs, b);
  }

  private onMoves(tourId: string, boardId: string, kept: number, before: number): void {
    const rs = this.site.event(tourId);
    if (!rs) return;
    const b = rs.board(boardId);
    if (b?.tracked) {
      // A correction that does not shorten the game: forget the replaced plies first, else setLatest sees no change.
      if (kept + 1 < before && kept + 1 < b.plies.length)
        this.queue.setLatest(tourId, b.id, b.board, kept, this.now, true);
      this.enqueue(rs, b);
      this.persistDead(); // a correction that shortened the game dropped its dead plies
    }
    this.wake();
  }

  /** Persist each Event's Dead-letter queue when it differs from the saved one. */
  private persistDead(): void {
    const now = this.queue.dead();
    for (const rs of this.site.events) {
      const mine = now.filter((d) => d.tourId === rs.event.tourId);
      const saved = rs.dead;
      if (
        mine.length === saved.length &&
        mine.every((d, i) => d.boardId === saved[i].boardId && d.ply === saved[i].ply)
      )
        continue;
      rs.setDead(mine);
    }
  }

  /** Idempotent: latest ply → current tier, earlier plies without a Complete eval → backfill. */
  private enqueue(rs: RoundState, b: Readonly<T.Board>): void {
    const tourId = rs.event.tourId;
    const latest = b.plies.length - 1;
    const done = noLegalMoves(b) || b.plies[latest].eval?.kind === 'complete';
    this.queue.setLatest(tourId, b.id, b.board, latest, this.now, done);
    const running = this.run?.job; // already out of the Queue
    const missing: number[] = [];
    for (let i = 0; i < latest; i++) {
      if (b.plies[i].eval?.kind !== 'complete' && !(running?.boardId === b.id && running.ply === i)) missing.push(i);
    }
    this.queue.addBackfill(tourId, b.id, missing, this.now);
  }

  /** After every Queue change: publish it, then evict the running Job if the Queue says so, or start the loop. */
  private wake(): void {
    this.publishQueue();
    const run = this.run;
    if (!run) return this.kick();
    if (run.stop || !this.copies.main.engine) return;
    const why = this.queue.preempt(run.job, this.now - run.startedAt, run.sliceMs);
    if (!why) return;
    run.stop = 'preempt';
    run.evicted = why;
    void this.stopEngines();
  }

  private publishQueue(): void {
    this.site.setQueue({
      current: this.queue.current().map(({ boardId, ply }) => ({ boardId, ply })),
      backfill: this.queue.backfillCount(),
      deferred: this.queue.deferred().map(({ boardId, ply }) => ({ boardId, ply })),
    });
  }

  private kick(): void {
    if (this.busy || this.halting || !this.copies.main.engine || this.site.settings.jobTimeMs === null) return;
    this.busy = true;
    this.loop = this.work();
  }

  private async work(): Promise<void> {
    try {
      for (;;) {
        const engine = this.copies.main.engine;
        const ms = this.site.settings.jobTimeMs;
        if (this.halting || !engine || ms === null) return;
        const job = this.queue.next();
        if (!job) return;
        await this.runJob(engine, this.copies.multi.engine, job, ms);
        this.site.setSearch(null, null);
      }
    } catch (err) {
      console.error('scheduler:', err);
    } finally {
      this.run = null;
      this.busy = false;
    }
  }

  private async runJob(engine: Engine, multi: Engine | null, job: Job, ms: number): Promise<void> {
    const { boardId, ply } = job;
    const rs = this.site.event(job.tourId);
    if (!rs) return void jobs.inc({ tier: job.tier, outcome: 'dropped' });
    const moves = rs
      .board(boardId)!
      .plies.slice(1, ply + 1)
      .map((p) => p.move!.uci);
    const chess = new Chess();
    for (const m of moves) play(chess, m);
    const slice = Math.min(MIN_LIVE_SLICE_MS, ms);
    const run: Run = {
      job,
      epoch: rs.epoch(boardId),
      fen: chess.fen(),
      engine: engine.name,
      main: { lines: [], nps: null },
      multi: multi && { lines: [], nps: null },
      startedAt: this.now,
      sliceMs: job.tier === 'current' && slice < ms ? slice : Infinity,
      stop: null,
      evicted: null,
    };
    this.run = run;
    // At the end of the slice, a live position that waits evicts this Job: wake() looks again then.
    const cancelSlice =
      run.sliceMs === Infinity ? () => {} : (this.opts.afterSlice ?? timeout)(run.sliceMs, () => this.wake());
    this.publishQueue(); // after `run` is set: a Job is never in neither place
    this.publishSearch(run);
    // The multi copy's failure is not the Job's: its exit handler restarts it, and the Job keeps the main copy's eval.
    const other = multi?.search(moves, { movetime: ms }).catch(() => null) ?? Promise.resolve(null);
    // Both copies end together: when the main one is done (full time, early mate, stop, crash), so is the multi one.
    const settled = () => (void multi?.stop().catch(() => {}), other);
    let r: SearchResult;
    try {
      r = await engine.search(moves, { movetime: ms });
    } catch {
      // The Event may have been removed meanwhile: then nothing of this Job is recorded or requeued.
      const ended = run.stop; // decided when the main copy ended: not by a stop sent while waiting for the multi copy
      await settled();
      const stop = this.site.event(job.tourId) === rs ? ended : 'drop';
      cancelSlice();
      // The search rejected: the engine died. A Job we quit the engine under (restart) is not its crash.
      this.run = null;
      if (stop === 'restart') {
        this.queue.requeue(job, this.now);
        jobs.inc({ tier: job.tier, outcome: 'interrupted' });
      } else if (stop === 'drop') jobs.inc({ tier: job.tier, outcome: 'dropped' });
      else {
        const crash = this.queue.crashed(job, this.now);
        if (crash === 'dead') this.persistDead();
        jobs.inc({
          tier: job.tier,
          outcome: { requeued: 'crashed', dead: 'dead_lettered', dropped: 'dropped' }[crash],
        });
      }
      this.publishQueue();
      return;
    }
    const { stop: ended, evicted } = run; // as for a crash: the Job's outcome is the main copy's
    const mr = await settled();
    cancelSlice();
    this.run = null;
    this.copies.main.backoff = RESTART_MIN_MS;
    if (mr) this.copies.multi.backoff = RESTART_MIN_MS;
    const stop = this.site.event(job.tourId) === rs ? ended : 'drop'; // the Event may be gone: drop the result
    if (stop === 'drop') return void jobs.inc({ tier: job.tier, outcome: 'dropped' });
    if (stop === 'restart') jobs.inc({ tier: job.tier, outcome: 'interrupted' });
    else {
      if (evicted) evictions.inc({ reason: evicted }); // not before: a halt may override the stop
      const e = toEval(r, ply, run.fen, stop ? 'provisional' : 'complete', mr);
      jobs.inc({ tier: job.tier, outcome: e ? 'recorded' : 'empty' });
      if (e) {
        this.recordJob(job, this.now - run.startedAt, e, run);
        // A short eviction (stale) must not replace a deeper Provisional eval of the same ply.
        const prev = rs.board(boardId)?.plies[ply]?.eval;
        if (e.kind === 'complete' || !prev || prev.depth <= e.depth) rs.setEval(boardId, ply, e, run.epoch);
      }
      if (evicted) {
        const depth = rs.board(boardId)?.plies[ply]?.eval?.depth ?? null; // what the ply kept
        this.evicted.unshift({
          tourId: job.tourId,
          boardId,
          board: job.board,
          ply,
          reason: evicted,
          depth,
          at: this.now,
        });
        this.evicted.length = Math.min(this.evicted.length, EVICTIONS_KEPT);
      }
    }
    // Evicted for another live position: a full search later, from the top of backfill.
    if (stop === 'preempt' && evicted === 'live') this.queue.evict(job, this.now);
    // Stopped, or a correction bumped the epoch (eval refused): search it again if the ply still exists.
    else if (stop || run.epoch !== rs.epoch(boardId)) this.queue.requeue(job, this.now);
  }

  /** Duration and the Admin timing samples are the Job's (main copy's depth); depth and nps also per copy. */
  private recordJob(job: Job, ms: number, e: T.Eval, run: Run): void {
    const labels = { tier: job.tier, kind: e.kind };
    jobDuration.observe(labels, ms / 1000);
    jobDepth.observe({ ...labels, role: 'main' }, e.depth);
    if (e.multi) jobDepth.observe({ ...labels, role: 'multi' }, e.multi.depth);
    for (const role of ROLES) {
      const nps = run[role]?.nps ?? null;
      if (nps !== null) jobNps.observe({ ...labels, role }, nps);
    }
    this.samples.push({ ms, depth: e.depth, kind: e.kind });
    if (this.samples.length > TIMING_WINDOW) this.samples.shift();
  }

  private onInfo(role: T.EngineRole, info: UciInfo): void {
    const run = this.run;
    const half = run?.[role];
    if (!run || !half || run.stop || !info.score || info.score.bound) return;
    const line = toLine(info, run.job.ply, run.fen);
    if (!line) return;
    half.lines[info.multipv - 1] = line;
    half.nps = info.nps ?? half.nps;
    this.publishSearch(run);
  }

  private publishSearch(run: Run): void {
    const lines = run.main.lines.filter(Boolean);
    const others = run.multi?.lines.filter(Boolean);
    const { boardId, ply, tier } = run.job;
    this.site.setSearch(
      {
        boardId,
        ply,
        engine: run.engine,
        depth: lines[0]?.depth ?? 0,
        nps: run.main.nps,
        lines,
        multi: others ? { depth: others[0]?.depth ?? 0, nps: run.multi!.nps, lines: others } : null,
        startedAt: run.startedAt,
        tier,
      },
      run.job.tourId,
    );
  }

  private cancelPendingRestart(role: T.EngineRole): void {
    const c = this.copies[role];
    c.cancelRestart?.();
    c.cancelRestart = null;
  }

  /** Relaunch that copy after its backoff (doubling up to RESTART_MAX_MS); one pending per copy. */
  private scheduleRestart(role: T.EngineRole): void {
    const c = this.copies[role];
    if (!this.wanted || c.cancelRestart) return;
    const delay = c.backoff;
    c.backoff = Math.min(2 * delay, RESTART_MAX_MS);
    c.restarts++;
    c.cancelRestart = (this.opts.after ?? timeout)(delay, () => {
      c.cancelRestart = null;
      void this.serial(async () => {
        if (!this.wanted || c.engine) return;
        await this.ensureEngine(role);
        if (c.engine) this.wake();
      });
    });
  }

  /** Launch; on failure remember it and retry with backoff. Never throws. */
  private async ensureEngine(role: T.EngineRole): Promise<void> {
    const c = this.copies[role];
    try {
      await this.launchEngine(role);
      c.launchFailed = false;
    } catch (err) {
      console.error(`scheduler: ${role} engine launch failed:`, err);
      c.launchFailed = true;
      this.scheduleRestart(role);
    }
  }

  private async launchEngine(role: T.EngineRole): Promise<void> {
    const cfg = this.site.settings.engine ?? this.opts.defaultEngine;
    let started: Engine | undefined;
    try {
      started = await (this.opts.launch ?? ((c) => Engine.start(c.path)))(cfg, role);
      for (const [k, v] of copyOptions(cfg, role)) started.setOption(k, v);
      await started.isReady();
    } catch (err) {
      void started?.quit();
      throw err;
    }
    const engine = started;
    const c = this.copies[role];
    engine.on('info', (info) => this.onInfo(role, info));
    engine.on('exit', (code, signal) => {
      if (c.engine !== engine) return;
      console.error(`scheduler: ${role} engine exited (${code ?? signal})`);
      c.engine = null;
      this.publishQueue();
      this.scheduleRestart(role);
    });
    c.engine = engine;
  }

  /** Tell both copies to stop searching; resolves once each has. */
  private async stopEngines(): Promise<void> {
    await Promise.all(this.engines.map((e) => e.stop().catch(() => {})));
  }

  /** Inside serial only, after halt(). */
  private async quitEngines(): Promise<void> {
    const old = this.engines;
    for (const role of ROLES) this.copies[role].engine = null;
    await Promise.all(old.map((e) => e.quit()));
  }

  /** Inside serial only. Stop the running Job (recorded per `how`) and wait for the loop to end. */
  private async halt(how: 'drop' | 'restart'): Promise<void> {
    this.halting = true;
    if (this.run && this.copies.main.engine) {
      this.run.stop = how;
      await this.stopEngines();
    }
    await this.loop;
    this.halting = false;
  }
}
