import { Chess } from 'chess.js';
import { MIN_LIVE_SLICE_MS, Queue, type Eviction, type Job } from '../shared/queue.js';
import { jobTiming, type JobSample, type JobTiming } from '../shared/timing.js';
import type * as T from '../shared/types.js';
import { Engine, type SearchResult } from './engine/engine.js';
import type { UciInfo } from './engine/uci-parser.js';
import type { RoundInfo } from './lichess/api.js';
import { lichessSource, type GameUpdate, type Source, type SourceFactory } from './lichess/stream.js';
import { evictions, jobDepth, jobDuration } from './metrics.js';
import { OpeningFallback, type OpeningFetch } from './opening.js';
import { pvToSan, toScore } from './pv.js';
import type { RoundState } from './round-state.js';

export const RESTART_MIN_MS = 1000;
export const RESTART_MAX_MS = 60_000;

/** null: no engine wanted (no Round, or after stop()). */
export const TIMING_WINDOW = 200;
export type EngineState = 'up' | 'restarting' | null;

export interface SchedulerOpts {
  defaultEngine: T.EngineConfig; // used while state.settings.engine is null
  launch?: (cfg: T.EngineConfig) => Promise<Engine>; // default Engine.start(cfg.path); tests spawn the fake
  source?: SourceFactory; // default lichessSource
  now?: () => number; // default Date.now
  after?: (ms: number, fn: () => void) => () => void; // restart backoff; default setTimeout(unref) → cancel; tests inject
  afterSlice?: (ms: number, fn: () => void) => () => void; // live slice timer; same default as `after`
  fetchOpening?: OpeningFetch; // masters explorer for untagged Boards; undefined = no fallback (tests, demo)
}

/** The Job being searched. stop = why it was told to stop (null = it ran its full time); evicted = why, for 'preempt'.
 *  sliceMs = how long before another live position may evict it (Infinity: never). */
interface Run {
  job: Job;
  epoch: number;
  fen: string;
  lines: T.PvLine[];
  nps: number | null;
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

/** null when the search produced no scored line. */
export function toEval(r: SearchResult, ply: number, fen: string, kind: T.EvalKind): T.Eval | null {
  const lines = r.lines.flatMap((l) => toLine(l, ply, fen) ?? []);
  if (!lines.length) return null;
  return {
    score: lines[0].score,
    depth: lines[0].depth,
    kind,
    bestmove: r.bestmove === '(none)' ? null : r.bestmove,
    lines,
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
 * run one at a time as `go movetime` searches on one engine. Public methods are serialised; the search loop and the
 * source/engine handlers run outside that and stay synchronous apart from the single `engine.search` await.
 */
export class Scheduler {
  private readonly queue = new Queue();
  private source: Source | null = null;
  private engine_: Engine | null = null;
  private run: Run | null = null;
  private loop: Promise<void> = Promise.resolve();
  private busy = false;
  private halting = false;
  private ops: Promise<unknown> = Promise.resolve();
  private wanted = false; // a Round exists and stop() was not called: keep an engine running
  private backoff = RESTART_MIN_MS;
  private restarts_ = 0;
  private samples: JobSample[] = []; // the last TIMING_WINDOW recorded Jobs; resets on boot, not on a Round swap
  private readonly openings: OpeningFallback | null = null;
  private cancelRestart: (() => void) | null = null;
  private launchFailed = false;

  constructor(
    private readonly state: RoundState,
    private readonly opts: SchedulerOpts,
  ) {
    if (opts.fetchOpening) this.openings = new OpeningFallback(state, opts.fetchOpening);
  }

  /** Null before the first Round, after stop() or after an exit. */
  get engine(): Engine | null {
    return this.engine_;
  }

  get engineState(): EngineState {
    if (!this.wanted) return null;
    return this.engine_ && !this.cancelRestart && !this.launchFailed ? 'up' : 'restarting';
  }

  /** Relaunches scheduled since process start. */
  get restarts(): number {
    return this.restarts_;
  }

  /** Job time and depth over the last TIMING_WINDOW Jobs. */
  get timing(): JobTiming {
    return jobTiming(this.samples);
  }

  /** Copy of the Job being searched. */
  get running(): Job | null {
    return this.run && { ...this.run.job };
  }

  /** Replace the Current Round (also the first one): drop the running Job, follow the new Round's source.
   *  existing = that Round's file: continue it, never wipe it. */
  startRound(r: RoundInfo, startsAt: number | null, existing: T.Round | null = null): Promise<void> {
    return this.serial(async () => {
      this.detach();
      await this.halt('drop');
      this.queue.clear();
      this.openings?.clear();
      if (existing) this.state.openRound(existing);
      else this.state.startRound(r, startsAt);
      this.startSource(r.id);
      this.enqueueTracked();
      this.wake();
      this.wanted = true;
      this.cancelPendingRestart();
      this.backoff = RESTART_MIN_MS;
      if (!this.engine_) {
        await this.ensureEngine();
        this.kick();
      }
    });
  }

  /** Applies from the next Job. */
  setJobTime(ms: number | null): Promise<void> {
    return this.serial(async () => {
      this.state.setJobTime(ms);
      this.wake();
    });
  }

  /** Exact tracked set. Untracked Boards leave the Queue; newly tracked ones are queued with their earlier plies. */
  setTracked(boardIds: readonly string[]): Promise<void> {
    return this.serial(async () => {
      const boards = this.state.round?.boards ?? [];
      const before = new Set(boards.filter((b) => b.tracked).map((b) => b.id));
      this.state.setTracked(boardIds);
      for (const b of boards) {
        if (before.has(b.id) && !b.tracked) this.queue.removeBoard(b.id);
        else if (!before.has(b.id) && b.tracked) this.enqueue(b);
      }
      this.persistDead();
      this.wake();
    });
  }

  /** Boot: if there is a Current Round, rebuild the Queue from its plies and follow its source again. */
  resume(): Promise<void> {
    return this.serial(async () => {
      const round = this.state.round;
      if (!round) return;
      this.startSource(round.roundId);
      this.queue.restoreDead(this.state.dead); // before enqueueTracked: dead positions are not queued again
      this.enqueueTracked();
      this.wake();
      this.wanted = true;
      await this.ensureEngine();
      this.kick();
    });
  }

  /** Save the config; if a Round is followed, restart the engine now (the running Job is requeued unrecorded). A failed
   *  launch rejects and keeps retrying with backoff. */
  setEngine(cfg: T.EngineConfig): Promise<void> {
    return this.serial(async () => {
      this.state.setEngine(cfg);
      if (!this.wanted) return;
      if (this.engine_) {
        await this.halt('restart');
        const old = this.engine_;
        this.engine_ = null;
        await old?.quit();
      }
      this.cancelPendingRestart(); // after the halt: an exit during it scheduled one too
      this.backoff = RESTART_MIN_MS;
      try {
        await this.launchEngine();
        this.launchFailed = false;
      } catch (err) {
        this.launchFailed = true;
        this.scheduleRestart();
        throw err;
      }
      this.wake(); // publishes the requeued Job, then kicks
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

  /** Shutdown / Event cleared: drop the Job, stop the source, quit the engine, clear the Queue. */
  stop(): Promise<void> {
    return this.serial(async () => {
      this.wanted = false;
      this.cancelPendingRestart();
      this.backoff = RESTART_MIN_MS;
      this.launchFailed = false;
      this.detach();
      await this.halt('drop');
      const e = this.engine_;
      this.engine_ = null;
      await e?.quit();
      this.queue.clear();
      this.publishQueue();
      this.state.setSearch(null);
    });
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

  private detach(): void {
    this.source?.stop();
    this.source = null;
  }

  private startSource(roundId: string): void {
    const src = (this.opts.source ?? lichessSource)(roundId);
    this.source = src;
    // Stream handler exceptions are swallowed as network errors (and the update lost): never throw from these.
    src.start({
      game: (u) => this.source === src && this.onGame(u),
      status: (s) => this.source === src && this.state.setStream(s),
    });
  }

  private enqueueTracked(): void {
    for (const b of this.state.round?.boards ?? []) if (b.tracked) this.enqueue(b);
  }

  private onGame(u: GameUpdate): void {
    const moves = u.uci.map((uci, i) => ({ uci, san: u.san[i], clock: u.clocks[i] }));
    const before = this.state.board(u.gameId)?.plies.length ?? 0;
    const kept = this.state.syncMoves(u.gameId, moves, this.now);
    if (kept === null) return;
    this.state.setResult(u.gameId, u.result);
    this.state.setOpening(u.gameId, u.opening);
    const b = this.state.board(u.gameId)!;
    if (b.tracked && !u.opening) this.openings?.seen(b.id, u.uci);
    if (b.tracked) {
      // A correction that does not shorten the game: forget the replaced plies first, else setLatest sees no change.
      if (kept + 1 < before && kept + 1 < b.plies.length) this.queue.setLatest(b.id, b.board, kept, this.now, true);
      this.enqueue(b);
      this.persistDead(); // a correction that shortened the game dropped its dead plies
    }
    this.wake();
  }

  /** Persist the Dead-letter queue when it differs from the saved one. */
  private persistDead(): void {
    const now = this.queue.dead();
    const saved = this.state.dead;
    if (now.length === saved.length && now.every((d, i) => d.boardId === saved[i].boardId && d.ply === saved[i].ply)) {
      return;
    }
    this.state.setDead(now);
  }

  /** Idempotent: latest ply → current tier, earlier plies without a Complete eval → backfill. */
  private enqueue(b: Readonly<T.Board>): void {
    const latest = b.plies.length - 1;
    const done = noLegalMoves(b) || b.plies[latest].eval?.kind === 'complete';
    this.queue.setLatest(b.id, b.board, latest, this.now, done);
    const running = this.run?.job; // already out of the Queue
    const missing: number[] = [];
    for (let i = 0; i < latest; i++) {
      if (b.plies[i].eval?.kind !== 'complete' && !(running?.boardId === b.id && running.ply === i)) missing.push(i);
    }
    this.queue.addBackfill(b.id, missing, this.now);
  }

  /** After every Queue change: publish it, then evict the running Job if the Queue says so, or start the loop. */
  private wake(): void {
    this.publishQueue();
    const run = this.run;
    if (!run) return this.kick();
    if (run.stop || !this.engine_) return;
    const why = this.queue.preempt(run.job, this.now - run.startedAt, run.sliceMs);
    if (!why) return;
    run.stop = 'preempt';
    run.evicted = why;
    evictions.inc({ reason: why });
    void this.engine_.stop().catch(() => {});
  }

  private publishQueue(): void {
    this.state.setQueue({
      current: this.queue.current().map(({ boardId, ply }) => ({ boardId, ply })),
      backfill: this.queue.backfillCount(),
    });
  }

  private kick(): void {
    if (this.busy || this.halting || !this.engine_ || this.state.settings.jobTimeMs === null) return;
    this.busy = true;
    this.loop = this.work();
  }

  private async work(): Promise<void> {
    try {
      for (;;) {
        const engine = this.engine_;
        const ms = this.state.settings.jobTimeMs;
        if (this.halting || !engine || ms === null) return;
        const job = this.queue.next();
        if (!job) return;
        await this.runJob(engine, job, ms);
        this.state.setSearch(null);
      }
    } catch (err) {
      console.error('scheduler:', err);
    } finally {
      this.run = null;
      this.busy = false;
    }
  }

  private async runJob(engine: Engine, job: Job, ms: number): Promise<void> {
    const { boardId, ply } = job;
    const moves = this.state
      .board(boardId)!
      .plies.slice(1, ply + 1)
      .map((p) => p.move!.uci);
    const chess = new Chess();
    for (const m of moves) play(chess, m);
    const slice = Math.min(MIN_LIVE_SLICE_MS, ms);
    const run: Run = {
      job,
      epoch: this.state.epoch(boardId),
      fen: chess.fen(),
      lines: [],
      nps: null,
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
    this.state.setSearch({
      boardId,
      ply,
      engine: engine.name,
      depth: 0,
      nps: null,
      lines: [],
      startedAt: run.startedAt,
    });
    let r: SearchResult;
    try {
      r = await engine.search(moves, { movetime: ms });
    } catch {
      cancelSlice();
      // The search rejected: the engine died. A Job we quit the engine under (restart) is not its crash.
      this.run = null;
      if (run.stop === 'restart') this.queue.requeue(job, this.now);
      else if (run.stop !== 'drop' && this.queue.crashed(job, this.now) === 'dead') this.persistDead();
      this.publishQueue();
      return;
    }
    cancelSlice();
    this.run = null;
    this.backoff = RESTART_MIN_MS;
    if (run.stop === 'drop') return;
    if (run.stop !== 'restart') {
      const e = toEval(r, ply, run.fen, run.stop ? 'provisional' : 'complete');
      if (e) {
        this.recordJob(job, this.now - run.startedAt, e);
        // A short eviction (stale) must not replace a deeper Provisional eval of the same ply.
        const prev = this.state.board(boardId)?.plies[ply]?.eval;
        if (e.kind === 'complete' || !prev || prev.depth <= e.depth) this.state.setEval(boardId, ply, e, run.epoch);
      }
    }
    // Evicted for another live position: a full search later, from the top of backfill.
    if (run.stop === 'preempt' && run.evicted === 'live') this.queue.evict(job, this.now);
    // Stopped, or a correction bumped the epoch (eval refused): search it again if the ply still exists.
    else if (run.stop || run.epoch !== this.state.epoch(boardId)) this.queue.requeue(job, this.now);
  }

  private recordJob(job: Job, ms: number, e: T.Eval): void {
    const labels = { tier: job.tier, kind: e.kind };
    jobDuration.observe(labels, ms / 1000);
    jobDepth.observe(labels, e.depth);
    this.samples.push({ ms, depth: e.depth, kind: e.kind });
    if (this.samples.length > TIMING_WINDOW) this.samples.shift();
  }

  private onInfo(engine: Engine, info: UciInfo): void {
    const run = this.run;
    if (!run || run.stop || !info.score || info.score.bound) return;
    const line = toLine(info, run.job.ply, run.fen);
    if (!line) return;
    run.lines[info.multipv - 1] = line;
    run.nps = info.nps ?? run.nps;
    const lines = run.lines.filter(Boolean);
    const { boardId, ply } = run.job;
    this.state.setSearch({
      boardId,
      ply,
      engine: engine.name,
      depth: lines[0]?.depth ?? 0,
      nps: run.nps,
      lines,
      startedAt: run.startedAt,
    });
  }

  private cancelPendingRestart(): void {
    this.cancelRestart?.();
    this.cancelRestart = null;
  }

  /** Relaunch after `backoff` (doubling up to RESTART_MAX_MS); one pending at a time. */
  private scheduleRestart(): void {
    if (!this.wanted || this.cancelRestart) return;
    const delay = this.backoff;
    this.backoff = Math.min(2 * delay, RESTART_MAX_MS);
    this.restarts_++;
    this.cancelRestart = (this.opts.after ?? timeout)(delay, () => {
      this.cancelRestart = null;
      void this.serial(async () => {
        if (!this.wanted || this.engine_) return;
        await this.ensureEngine();
        if (this.engine_) this.wake();
      });
    });
  }

  /** Launch; on failure remember it and retry with backoff. Never throws. */
  private async ensureEngine(): Promise<void> {
    try {
      await this.launchEngine();
      this.launchFailed = false;
    } catch (err) {
      console.error('scheduler: engine launch failed:', err);
      this.launchFailed = true;
      this.scheduleRestart();
    }
  }

  private async launchEngine(): Promise<void> {
    const cfg = this.state.settings.engine ?? this.opts.defaultEngine;
    let started: Engine | undefined;
    try {
      started = await (this.opts.launch ?? ((c) => Engine.start(c.path)))(cfg);
      for (const [k, v] of Object.entries(cfg.options)) started.setOption(k, v);
      await started.isReady();
    } catch (err) {
      void started?.quit();
      throw err;
    }
    const engine = started;
    engine.on('info', (info) => this.onInfo(engine, info));
    engine.on('exit', (code, signal) => {
      if (this.engine_ !== engine) return;
      console.error(`scheduler: engine exited (${code ?? signal})`);
      this.engine_ = null;
      this.publishQueue();
      this.scheduleRestart();
    });
    this.engine_ = engine;
  }

  /** Inside serial only. Stop the running Job (recorded per `how`) and wait for the loop to end. */
  private async halt(how: 'drop' | 'restart'): Promise<void> {
    this.halting = true;
    if (this.run && this.engine_) {
      this.run.stop = how;
      await this.engine_.stop().catch(() => {});
    }
    await this.loop;
    this.halting = false;
  }
}
