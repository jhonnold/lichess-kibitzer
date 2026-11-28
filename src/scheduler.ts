import { Chess } from 'chess.js';
import { copyOptions } from '../shared/engine-config.js';
import { DEEP_PASS, maxPass, nextPass } from '../shared/passes.js';
import { MAX_CRASHES, MIN_LIVE_SLICE_MS, Queue, type EvictedJob, type Eviction, type Job } from '../shared/queue.js';
import { passTimings, type JobSample, type JobTiming } from '../shared/timing.js';
import type * as T from '../shared/types.js';
import { boardState } from '../shared/viewer.js';
import { Engine, type SearchResult } from './engine/engine.js';
import type { EvalTarget } from './archive-rounds.js';
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

/** requestDeep: ok, the Board is in neither its Event's Current Round nor a Round file, or the deep Pass is off. */
export type DeepResult = 'ok' | 'unknown board' | 'pass 3 off';
/** Why deep Jobs can't run now (null: they can, or there are none): the deep Pass is off, a Tracked Board of that
 *  Event is live, or regular Jobs wait or run (they go first). */
export type DeepHeld = { reason: 'pass 3 off' } | { reason: 'live'; tourId: string; name: string } | { reason: 'busy' };
/** A deep request and its progress: left of total plies still to search. */
export interface DeepProgress {
  tourId: string;
  roundId: string;
  boardId: string;
  board: number;
  left: number;
  total: number;
}

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
  ms: number; // the Job's search time
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
 * run one at a time as `go movetime` searches on both copies at once. Each position is searched once per Pass
 * (shared/passes.ts): Pass 0 first, Pass 1 in the free time; the deep Pass is never queued automatically. The main copy decides the Job's outcome; the
 * multi copy only adds Lines, and the Queue runs without it while it is down. The deep Pass runs on an Admin's request
 * (requestDeep), on any Board of any Round, archived ones via ArchiveRounds, while nothing else may run. Public methods
 * are serialised; the search loop and the source/engine handlers run outside that and stay synchronous apart from the
 * single `engine.search` await (and, for a deep Job, the read of its Round file before it).
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
  private wanted = false; // some Event has a Round or a deep request is pending, and stop() was not called: keep engines running
  private opening: Job | null = null; // a deep Job taken from the Queue, while its Round file is read before its search
  private samples: JobSample[] = []; // the last TIMING_WINDOW recorded Jobs of each Pass; resets on boot, not on a Round swap
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

  /** Job time and depth over the last TIMING_WINDOW Jobs of each Pass (index = Pass). */
  get timing(): JobTiming[] {
    return passTimings(this.samples);
  }

  /** The last EVICTIONS_KEPT evictions, newest first (copies). */
  get evictions(): EvictedJob[] {
    return this.evicted.map((e) => ({ ...e }));
  }

  /** Waiting Jobs per Pass (index = Pass). */
  get passCounts(): number[] {
    return this.queue.passCounts();
  }

  /** Copy of the Job being searched. */
  get running(): Job | null {
    return this.run && { ...this.run.job };
  }

  /** The deep requests, oldest first, with their progress. */
  get deep(): DeepProgress[] {
    return this.site.deep.map(({ tourId, roundId, boardId, board, left, total }) => ({
      tourId,
      roundId,
      boardId,
      board,
      left: left.length,
      total,
    }));
  }

  /** Why the deep requests wait; null when there are none or they may run (as maxPass and Queue.next decide). */
  get deepHeld(): DeepHeld | null {
    if (!this.site.deep.length) return null;
    if (this.site.settings.passesMs?.[DEEP_PASS] == null) return { reason: 'pass 3 off' };
    const live = this.liveEvent;
    if (live) return { reason: 'live', tourId: live.event.tourId, name: live.event.name };
    const waiting = this.queue
      .passCounts()
      .slice(0, DEEP_PASS)
      .some((n) => n > 0);
    return waiting || (this.run && !this.run.job.deep) ? { reason: 'busy' } : null;
  }

  /** Replace that Event's Current Round (also its first one): drop its running Job and Queue entries, follow the new
   *  Round's source. Other Events are untouched. existing = that Round's file: continue it, never wipe it; when
   *  ArchiveRounds holds the Round (deep analysis), its copy is newer and opened instead. A deep Job is halted (and
   *  requeued) only when its Round is the one replaced or the one opened; its deep Jobs are kept. */
  startRound(tourId: string, r: RoundInfo, startsAt: number | null, existing: T.Round | null = null): Promise<void> {
    return this.serial(async () => {
      const rs = this.site.event(tourId);
      if (!rs) return;
      this.feeds.get(tourId)?.stop();
      const job = this.run?.job ?? this.opening;
      const affected = (j: Job) =>
        j.tourId === tourId && (!j.deep || j.roundId === rs.round?.roundId || j.roundId === r.id);
      if (job && affected(job)) await this.halt('drop');
      existing = (await this.site.release(tourId, r.id)) ?? existing;
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
      await this.wantEngines();
      this.kick();
    });
  }

  /** The Event is being removed: stop its Feed, drop its Job and Queue entries, remove it from the site. Its deep
   *  requests stay (a deep Job of its Current Round is halted and requeued: the Round goes to the Archive). Quit the
   *  engines when no Event has a Round and no deep request is left. */
  removeEvent(tourId: string): Promise<void> {
    return this.serial(async () => {
      this.feeds.get(tourId)?.stop();
      this.feeds.delete(tourId);
      const job = this.run?.job ?? this.opening;
      const current = this.site.event(tourId)?.round?.roundId;
      if (job?.tourId === tourId && (!job.deep || job.roundId === current)) await this.halt('drop');
      this.queue.removeEvent(tourId);
      this.site.removeEvent(tourId);
      this.wanted = this.someWork;
      if (!this.wanted) await this.idleEngines();
      this.publishQueue();
      this.kick();
    });
  }

  /** Applies from the next Job: waiting Jobs move to each position's next Pass, positions with a new Pass to reach are
   *  queued. null = the Queue idles. */
  setPasses(passesMs: T.PassesMs | null): Promise<void> {
    return this.serial(async () => {
      this.site.setPasses(passesMs);
      this.queue.repass((j) => {
        const b = this.site.event(j.tourId)?.board(j.boardId);
        return b ? nextPass(b.plies[j.ply]?.eval, j.ply, passesMs) : null;
      });
      for (const rs of this.site.events) this.enqueueTracked(rs);
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
   *  source again. Queue every deep request again. */
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
      if (!(await this.restoreDeep()) && !any) return;
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

  /** Admin: deep analysis of a Board of any Round (its Event's Current Round, or a Round file): the deep Pass on each
   *  of its plies so far, run only while no regular Job may (nothing live, nothing else waiting). A repeat request
   *  restarts it. Later, a deep Pass turned off holds its Jobs (maxPass). */
  requestDeep(tourId: string, roundId: string, boardId: string): Promise<DeepResult> {
    return this.serialValue(async () => {
      if (this.site.settings.passesMs?.[DEEP_PASS] == null) return 'pass 3 off';
      const b = await this.deepBoard(tourId, roundId, boardId);
      if (!b) return 'unknown board';
      const latest = b.plies.length - 1;
      const left = b.plies.map((_, i) => i).filter((i) => i < latest || !noLegalMoves(b));
      await this.haltDeep(boardId); // its old request's Job
      this.queue.addDeep(tourId, roundId, boardId, b.board, left, this.now);
      this.site.setDeep({ tourId, roundId, boardId, board: b.board, at: this.now, left, total: left.length });
      await this.wantEngines();
      this.wake();
      return 'ok';
    });
  }

  /** Admin: stop a Board's deep analysis, its running search too. Quit the engines when nothing is left. False: none. */
  cancelDeep(boardId: string): Promise<boolean> {
    return this.serialValue(async () => {
      await this.haltDeep(boardId);
      this.queue.cancelDeep(boardId);
      const had = this.site.cancelDeep(boardId);
      await this.idleIfDone();
      this.wake();
      return had;
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

  /** Inside serial only: engines wanted from now; launch the copies that are down (a pending relaunch starts now). */
  private async wantEngines(): Promise<void> {
    this.wanted = true;
    for (const role of ROLES) {
      this.cancelPendingRestart(role);
      this.copies[role].backoff = RESTART_MIN_MS;
      if (!this.copies[role].engine) await this.ensureEngine(role);
    }
  }

  /** Boot: queue each persisted deep request again, its plies clamped to its Board's (a malformed ply is dropped); a
   *  request whose Round file or Board is gone is dropped. true = some request is left. */
  private async restoreDeep(): Promise<boolean> {
    for (const req of [...this.site.deep]) {
      const b = await this.deepBoard(req.tourId, req.roundId, req.boardId).catch((err: unknown) => {
        console.error(`scheduler: deep ${req.boardId}:`, err);
        return undefined;
      });
      if (!b) {
        console.warn(`scheduler: deep request for ${req.boardId} dropped: its Board is gone`);
        this.site.cancelDeep(req.boardId);
        continue;
      }
      const bad = (ply: number) => !Number.isInteger(ply) || ply < 0 || ply >= b.plies.length;
      for (const ply of req.left) if (bad(ply)) this.site.deepDone(req.boardId, ply);
      const left = this.site.deepRequest(req.boardId)?.left ?? [];
      if (left.length) this.queue.addDeep(req.tourId, req.roundId, req.boardId, req.board, left, req.at);
    }
    return this.site.deep.length > 0;
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

  /** Idempotent: latest ply → current tier, earlier plies with a Pass left to reach → backfill, each for its next
   *  Pass. */
  private enqueue(rs: RoundState, b: Readonly<T.Board>): void {
    const tourId = rs.event.tourId;
    const latest = b.plies.length - 1;
    const passes = this.site.settings.passesMs;
    const passOf = (i: number) => nextPass(b.plies[i].eval, i, passes);
    const pass = noLegalMoves(b) ? null : passOf(latest);
    const running = this.run?.job; // already out of the Queue
    const runs = (i: number) => !running?.deep && running?.boardId === b.id && running.ply === i; // a deep Job: other map
    this.queue.setLatest(tourId, b.id, b.board, latest, this.now, pass === null, pass ?? 0);
    // Same latest ply (setLatest did nothing): it may have a Pass left that is not queued yet (the Passes changed).
    if (pass !== null && !runs(latest)) {
      this.queue.requeue(
        { tourId, boardId: b.id, board: b.board, ply: latest, tier: 'current', pass, since: this.now },
        this.now,
      );
    }
    const missing: number[] = [];
    for (let i = 0; i < latest; i++) if (passOf(i) !== null && !runs(i)) missing.push(i);
    this.queue.addBackfill(tourId, b.id, missing, this.now, (i) => passOf(i)!);
  }

  /** The highest Pass a Job may run at now: the top one only while no Tracked Board of any Event is being played, and
   *  never one that is off (a running Job of a Pass just turned off is evicted). */
  private get maxPass(): number {
    const live = !!this.liveEvent;
    const on = this.site.settings.passesMs?.findLastIndex((ms) => ms !== null) ?? 0;
    return Math.min(maxPass(live), on);
  }

  /** The first Event with a Tracked Board being played. */
  private get liveEvent(): RoundState | undefined {
    return this.site.events.find((rs) => rs.round?.boards.some((b) => b.tracked && boardState(b) === 'live'));
  }

  /** After every Queue change: publish it, then evict the running Job if the Queue says so, or start the loop. */
  private wake(): void {
    this.publishQueue();
    const run = this.run;
    if (!run) return this.kick();
    if (run.stop || !this.copies.main.engine) return;
    const why = this.queue.preempt(run.job, this.now - run.startedAt, run.sliceMs, this.maxPass);
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
      deep: this.deep.map(({ boardId, left, total }) => ({ boardId, left, total })),
    });
  }

  private kick(): void {
    if (this.busy || this.halting || !this.copies.main.engine || this.site.settings.passesMs === null) return;
    this.busy = true;
    this.loop = this.work();
  }

  private async work(): Promise<void> {
    try {
      for (;;) {
        const engine = this.copies.main.engine;
        const passes = this.site.settings.passesMs;
        if (this.halting || !engine || passes === null) return;
        const job = this.queue.next(this.maxPass);
        if (!job) return;
        // A deep Job reads its search time itself, after its Round file.
        if (job.deep) {
          await this.runDeep(engine, job);
          this.publishQueue(); // its request's progress (left), also when it ended: no next Job publishes it
        } else await this.runJob(engine, this.copies.multi.engine, job, passes[job.pass] ?? passes[0]);
        this.site.setSearch(null, null);
      }
    } catch (err) {
      console.error('scheduler:', err);
    } finally {
      this.run = null;
      this.busy = false;
    }
  }

  /** Search the Job's position (`moves`) on both copies, as the Run in this.run until it ends. r null: the main copy's
   *  search rejected (the engine died). ended/evicted: as decided when the main copy ended. */
  private async search(
    engine: Engine,
    multi: Engine | null,
    job: Job,
    ms: number,
    moves: string[],
    epoch: number,
  ): Promise<{
    run: Run;
    r: SearchResult | null;
    mr: SearchResult | null;
    ended: Run['stop'];
    evicted: Eviction | null;
  }> {
    const chess = new Chess();
    for (const m of moves) play(chess, m);
    const slice = Math.min(MIN_LIVE_SLICE_MS, ms);
    const run: Run = {
      job,
      epoch,
      fen: chess.fen(),
      ms,
      engine: engine.name,
      main: { lines: [], nps: null },
      multi: multi && { lines: [], nps: null },
      startedAt: this.now,
      sliceMs: job.pass === 0 && job.tier === 'current' && slice < ms ? slice : Infinity,
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
      const ended = run.stop; // decided when the main copy ended: not by a stop sent while waiting for the multi copy
      await settled();
      cancelSlice();
      this.run = null;
      return { run, r: null, mr: null, ended, evicted: run.evicted };
    }
    const { stop: ended, evicted } = run; // as for a crash: the Job's outcome is the main copy's
    const mr = await settled();
    cancelSlice();
    this.run = null;
    this.copies.main.backoff = RESTART_MIN_MS;
    if (mr) this.copies.multi.backoff = RESTART_MIN_MS;
    return { run, r, mr, ended, evicted };
  }

  private async runJob(engine: Engine, multi: Engine | null, job: Job, ms: number): Promise<void> {
    const { boardId, ply } = job;
    const rs = this.site.event(job.tourId);
    const labels = { tier: job.tier, pass: String(job.pass) };
    if (!rs) return void jobs.inc({ ...labels, outcome: 'dropped' });
    const moves = rs
      .board(boardId)!
      .plies.slice(1, ply + 1)
      .map((p) => p.move!.uci);
    const { run, r, mr, ended, evicted } = await this.search(engine, multi, job, ms, moves, rs.epoch(boardId));
    // The Event may have been removed meanwhile: then nothing of this Job is recorded or requeued.
    const stop = this.site.event(job.tourId) === rs ? ended : 'drop';
    if (!r) {
      // The search rejected: the engine died. A Job we quit the engine under (restart) is not its crash.
      if (stop === 'restart') {
        this.queue.requeue(job, this.now);
        jobs.inc({ ...labels, outcome: 'interrupted' });
      } else if (stop === 'drop') jobs.inc({ ...labels, outcome: 'dropped' });
      else {
        const crash = this.queue.crashed(job, this.now);
        if (crash === 'dead') this.persistDead();
        jobs.inc({
          ...labels,
          outcome: { requeued: 'crashed', dead: 'dead_lettered', dropped: 'dropped' }[crash],
        });
      }
      this.publishQueue();
      return;
    }
    if (stop === 'drop') return void jobs.inc({ ...labels, outcome: 'dropped' });
    let recorded = false;
    if (stop === 'restart') jobs.inc({ ...labels, outcome: 'interrupted' });
    else {
      if (evicted) evictions.inc({ reason: evicted }); // not before: a halt may override the stop
      const elapsed = this.now - run.startedAt;
      const kind: T.EvalKind = stop ? 'provisional' : 'complete';
      const e = toEval(r, ply, run.fen, kind, mr);
      const prev = rs.board(boardId)?.plies[ply]?.eval;
      // An interrupted deepening Job (Pass ≥ 1) is kept, as Complete, only if it got deeper than the eval it replaces.
      const kept = !!e && !!stop && job.pass > 0 && (!prev || e.depth > prev.depth);
      const reached = prev?.kind === 'complete' ? (prev.ms ?? 0) : 0; // a kept one never lowers the Pass reached
      const record: (T.Eval & { ms: number }) | null =
        e && (!stop || job.pass === 0 || kept)
          ? { ...e, kind: kept ? 'complete' : kind, ms: kept ? Math.max(elapsed, reached) : stop ? elapsed : run.ms }
          : null;
      jobs.inc({ ...labels, outcome: record ? 'recorded' : e ? 'discarded' : 'empty' });
      if (record) {
        recorded = true;
        this.recordJob(job, elapsed, kind, record, run);
        // A short eviction (stale) must not replace a deeper Provisional eval of the same ply; a Complete eval never
        // replaces one that searched longer, unless it is a kept deepening search.
        const replaces =
          !prev ||
          (record.kind === 'complete'
            ? kept || prev.kind !== 'complete' || (prev.ms ?? 0) <= record.ms
            : prev.depth <= record.depth);
        if (replaces) rs.setEval(boardId, ply, record, run.epoch);
      }
      if (evicted) this.noteEviction(job, evicted, rs.board(boardId)?.plies[ply]?.eval?.depth ?? null); // what it kept
    }
    // Evicted for another live position: a full search later, from the top of backfill.
    if (stop === 'preempt' && evicted === 'live') this.queue.evict(job, this.now);
    // Stopped, a correction bumped the epoch (eval refused), or done at this Pass: queue the ply's next Pass, if any and
    // if the ply still exists (an empty search is not searched again).
    else if (stop || run.epoch !== rs.epoch(boardId) || recorded) {
      const pass = nextPass(rs.board(boardId)?.plies[ply]?.eval, ply, this.site.settings.passesMs);
      if (pass !== null) this.queue.requeue({ ...job, pass }, this.now);
    }
  }

  /**
   * A deep Job. Its target is looked up again at every step, never kept: its Round may become an Event's Current Round,
   * or stop being one, while it waits or runs (the epoch of the target it started on then refuses its eval). Read first
   * when ArchiveRounds does not hold its Round. Any stop (eviction, halt, restart) or refusal puts it back at the front
   * of the deep map while its request still wants the ply; a Complete eval always replaces the ply's eval (forced: no
   * keep-the-longer rule). Never the Dead-letter queue, the evict path or a next Pass.
   */
  private async runDeep(engine: Engine, job: Job): Promise<void> {
    const { boardId, ply } = job;
    const labels = { tier: job.tier, pass: String(job.pass) };
    let read: 'held' | 'missing' | 'failed' = 'held';
    if (!this.deepTarget(job)) {
      this.opening = job;
      try {
        read = (await this.site.archive.open(job.tourId, job.roundId!)) ? 'held' : 'missing';
      } catch (err) {
        console.error(`scheduler: deep ${boardId}:`, err);
        read = 'failed';
      }
      this.opening = null;
    }
    if (this.halting || this.copies.main.engine !== engine) return void this.requeueDeep(job);
    if (!this.wants(job)) return void jobs.inc({ ...labels, outcome: 'dropped' }); // cancelled while its Round was read
    // A wake() while the Round was read found no Run to preempt: a regular Job waits now, or the deep Pass is gated.
    if (this.queue.preempt(job, 0, Infinity, this.maxPass)) return void this.requeueDeep(job);
    if (read === 'failed') {
      // An unreadable Round file counts as a crash of the ply: after MAX_CRASHES the request ends (no hot loop).
      if (this.queue.crashedDeep(job)) return;
      return this.endDeep(job, `its Round file is unreadable`);
    }
    if (read === 'missing') return this.endDeep(job, 'its Round file is gone');
    const target = this.deepTarget(job);
    if (!target) return void this.requeueDeep(job); // read, but released meanwhile (about to become current)
    const b = target.board(boardId);
    if (!b) return this.endDeep(job, 'its Board is gone');
    if (ply >= b.plies.length) {
      console.warn(`scheduler: deep ${boardId}:${ply} dropped: no such ply`); // a correction took it away
      this.site.deepDone(boardId, ply);
      jobs.inc({ ...labels, outcome: 'dropped' });
      return this.idleWhenDone();
    }
    const ms = this.site.settings.passesMs![DEEP_PASS]!; // not gated (preempt above): the deep Pass is on
    const moves = b.plies.slice(1, ply + 1).map((p) => p.move!.uci);
    const multi = this.copies.multi.engine;
    const { run, r, mr, ended, evicted } = await this.search(engine, multi, job, ms, moves, target.epoch(boardId));
    if (!r) {
      // The engine died. A Job we stopped (halt, restart) is not its crash; nor is one no longer wanted.
      if (ended === 'drop' || ended === 'restart' || !this.wants(job))
        return void jobs.inc({ ...labels, outcome: this.requeueDeep(job) ? 'interrupted' : 'dropped' });
      if (this.queue.crashedDeep(job)) return void jobs.inc({ ...labels, outcome: 'crashed' });
      console.warn(`scheduler: deep ${boardId}:${ply} given up after ${MAX_CRASHES} crashes`);
      this.site.deepDone(boardId, ply);
      jobs.inc({ ...labels, outcome: 'dropped' });
      return this.idleWhenDone();
    }
    if (ended) {
      // Evicted (upgrade), halted or restarted: discarded, searched again in full.
      const back = this.requeueDeep(job);
      if (ended === 'preempt' && evicted) {
        evictions.inc({ reason: evicted });
        this.noteEviction(job, evicted, this.deepTarget(job)?.board(boardId)?.plies[ply]?.eval?.depth ?? null);
        return void jobs.inc({ ...labels, outcome: 'discarded' });
      }
      return void jobs.inc({ ...labels, outcome: back ? 'interrupted' : 'dropped' });
    }
    const e = toEval(r, ply, run.fen, 'complete', mr);
    if (!e) {
      jobs.inc({ ...labels, outcome: 'empty' });
      this.site.deepDone(boardId, ply); // an empty search is not searched again
      return this.idleWhenDone();
    }
    const record = { ...e, ms: run.ms };
    const now = this.deepTarget(job);
    if (!now?.setEval(boardId, ply, record, run.epoch)) {
      jobs.inc({ ...labels, outcome: 'discarded' });
      const n = now?.board(boardId)?.plies.length;
      if (n === undefined || ply < n) return void this.requeueDeep(job); // stale: a correction, or its Round moved
      this.site.deepDone(boardId, ply); // a correction took the ply away
      return this.idleWhenDone();
    }
    jobs.inc({ ...labels, outcome: 'recorded' });
    this.recordJob(job, this.now - run.startedAt, 'complete', record, run);
    this.site.deepDone(boardId, ply);
    this.idleWhenDone();
  }

  /** The deep request of the Job's Board ends: its Round file or Board is gone. */
  private endDeep(job: Job, why: string): void {
    console.warn(`scheduler: deep request for ${job.boardId} dropped: ${why}`);
    this.queue.cancelDeep(job.boardId);
    this.site.cancelDeep(job.boardId);
    jobs.inc({ tier: job.tier, pass: String(job.pass), outcome: 'dropped' });
    this.idleWhenDone();
  }

  /** Where a deep Job's eval goes now: its Event's RoundState while its Round is current, else ArchiveRounds while it
   *  holds the Round; null: neither (the Round file is not read yet). */
  private deepTarget(job: Pick<Job, 'tourId' | 'roundId'>): EvalTarget | null {
    const rs = this.site.event(job.tourId);
    if (rs?.round && rs.round.roundId === job.roundId) return rs;
    return this.site.archive.round(job.tourId, job.roundId!) ? this.site.archive : null;
  }

  /** That Board as its deep Jobs would see it now: in its Event's Current Round, else in its Round file. */
  private async deepBoard(tourId: string, roundId: string, boardId: string): Promise<Readonly<T.Board> | undefined> {
    const rs = this.site.event(tourId);
    if (rs?.round?.roundId === roundId) return rs.board(boardId);
    return (await this.site.archive.open(tourId, roundId))?.boards.find((b) => b.id === boardId);
  }

  /** The Board's deep request still wants the Job's ply (not cancelled or done). */
  private wants(job: Job): boolean {
    const req = this.site.deepRequest(job.boardId);
    return !!req && req.roundId === job.roundId && req.left.includes(job.ply);
  }

  /** Back to the front of the deep map, while still wanted. */
  private requeueDeep(job: Job): boolean {
    return this.wants(job) && this.queue.requeueDeep(job);
  }

  /** Stop that Board's deep Job if it runs (or its Round is being read): it is requeued while still wanted. */
  private async haltDeep(boardId: string): Promise<void> {
    const job = this.run?.job ?? this.opening;
    if (job?.deep && job.boardId === boardId) await this.halt('drop');
  }

  /** From the search loop, after a deep request may have ended: quit the engines once nothing is left. */
  private idleWhenDone(): void {
    if (!this.someWork) void this.serial(() => this.idleIfDone());
  }

  /** Inside serial only: with no Round and no deep request left, quit the engines (as when the last Event goes). */
  private async idleIfDone(): Promise<void> {
    if (!this.wanted || this.someWork) return;
    this.wanted = false;
    await this.halt('drop');
    await this.idleEngines();
  }

  /** Some Event has a Round, or a deep request is pending: keep the engines running. */
  private get someWork(): boolean {
    return this.site.events.some((rs) => rs.round) || this.site.deep.length > 0;
  }

  private noteEviction(job: Job, reason: Eviction, depth: number | null): void {
    this.evicted.unshift({
      tourId: job.tourId,
      boardId: job.boardId,
      board: job.board,
      ply: job.ply,
      reason,
      depth,
      at: this.now,
    });
    this.evicted.length = Math.min(this.evicted.length, EVICTIONS_KEPT);
  }

  /** Duration and the Admin timing samples are the Job's (main copy's depth); depth and nps also per copy. kind: whether
   *  the Job ran its full time (a kept interrupted deepening search counts as provisional here). */
  private recordJob(job: Job, ms: number, kind: T.EvalKind, e: T.Eval, run: Run): void {
    const labels = { tier: job.tier, pass: String(job.pass), kind };
    jobDuration.observe(labels, ms / 1000);
    jobDepth.observe({ ...labels, role: 'main' }, e.depth);
    if (e.multi) jobDepth.observe({ ...labels, role: 'multi' }, e.multi.depth);
    for (const role of ROLES) {
      const nps = run[role]?.nps ?? null;
      if (nps !== null) jobNps.observe({ ...labels, role }, nps);
    }
    this.samples.push({ ms, depth: e.depth, kind, pass: job.pass });
    if (this.samples.filter((s) => s.pass === job.pass).length > TIMING_WINDOW) {
      this.samples.splice(
        this.samples.findIndex((s) => s.pass === job.pass),
        1,
      );
    }
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
    const { boardId, ply, tier, pass } = run.job;
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
        pass,
        ms: run.ms,
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
