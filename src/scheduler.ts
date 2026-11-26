import { Chess } from 'chess.js';
import { Queue, type Job } from '../shared/queue.js';
import type * as T from '../shared/types.js';
import { Engine, type SearchResult } from './engine/engine.js';
import type { UciInfo } from './engine/uci-parser.js';
import type { RoundInfo } from './lichess/api.js';
import { lichessSource, type GameUpdate, type Source, type SourceFactory } from './lichess/stream.js';
import { pvToSan, toScore } from './pv.js';
import type { RoundState } from './round-state.js';

export interface SchedulerOpts {
  defaultEngine: T.EngineConfig; // used while state.settings.engine is null
  launch?: (cfg: T.EngineConfig) => Promise<Engine>; // default Engine.start(cfg.path); tests spawn the fake
  source?: SourceFactory; // default lichessSource
  now?: () => number; // default Date.now
}

/** The Job being searched. stop = why it was told to stop (null = it ran its full time). */
interface Run {
  job: Job;
  epoch: number;
  fen: string;
  lines: T.PvLine[];
  nps: number | null;
  startedAt: number;
  stop: null | 'preempt' | 'restart' | 'drop';
}

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

  constructor(
    private readonly state: RoundState,
    private readonly opts: SchedulerOpts,
  ) {}

  /** Null before the first Round, after stop() or after an exit. */
  get engine(): Engine | null {
    return this.engine_;
  }

  /** Copy of the Job being searched. */
  get running(): Job | null {
    return this.run && { ...this.run.job };
  }

  /** Replace the Current Round (also the first one): drop the running Job, follow the new Round's source. */
  startRound(r: RoundInfo, startsAt: number | null): Promise<void> {
    return this.serial(async () => {
      this.detach();
      await this.halt('drop');
      this.queue.clear();
      this.state.startRound(r, startsAt);
      this.startSource(r.id);
      this.enqueueTracked();
      this.wake();
      if (!this.engine_) {
        await this.launchEngine();
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
      this.wake();
    });
  }

  /** Boot: if there is a Current Round, rebuild the Queue from its plies and follow its source again. */
  resume(): Promise<void> {
    return this.serial(async () => {
      const round = this.state.round;
      if (!round) return;
      this.startSource(round.roundId);
      this.enqueueTracked();
      this.wake();
      await this.launchEngine();
      this.kick();
    });
  }

  /** Save the config; if an engine runs, restart it (the running Job is requeued unrecorded). */
  setEngine(cfg: T.EngineConfig): Promise<void> {
    return this.serial(async () => {
      this.state.setEngine(cfg);
      if (!this.engine_) return;
      await this.halt('restart');
      const old = this.engine_;
      this.engine_ = null;
      await old?.quit();
      await this.launchEngine();
      this.wake(); // publishes the requeued Job, then kicks
    });
  }

  /** Shutdown / Event cleared: drop the Job, stop the source, quit the engine, clear the Queue. */
  stop(): Promise<void> {
    return this.serial(async () => {
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
    const b = this.state.board(u.gameId)!;
    if (b.tracked) {
      // A correction that does not shorten the game: forget the replaced plies first, else setLatest sees no change.
      if (kept + 1 < before && kept + 1 < b.plies.length) this.queue.setLatest(b.id, b.board, kept, this.now, true);
      this.enqueue(b);
    }
    this.wake();
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

  /** After every Queue change: publish it, then pre-empt a backfill Job for a waiting current one, or start the loop. */
  private wake(): void {
    this.publishQueue();
    const run = this.run;
    if (!run) return this.kick();
    if (!run.stop && this.engine_ && this.queue.shouldPreempt(run.job)) {
      run.stop = 'preempt';
      void this.engine_.stop().catch(() => {});
    }
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
    const run: Run = {
      job,
      epoch: this.state.epoch(boardId),
      fen: chess.fen(),
      lines: [],
      nps: null,
      startedAt: this.now,
      stop: null,
    };
    this.run = run;
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
      this.run = null;
      this.onEngineExit(run.stop === 'drop' ? null : job);
      return;
    }
    this.run = null;
    if (run.stop === 'drop') return;
    if (run.stop !== 'restart') {
      const e = toEval(r, ply, run.fen, run.stop ? 'provisional' : 'complete');
      if (e) this.state.setEval(boardId, ply, e, run.epoch);
    }
    // Stopped, or a correction bumped the epoch (eval refused): search it again if the ply still exists.
    if (run.stop || run.epoch !== this.state.epoch(boardId)) this.queue.requeue(job, this.now);
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

  /** Layer 10 replaces the requeue with crash counting and relaunches with backoff. */
  private onEngineExit(job: Job | null): void {
    this.engine_ = null;
    if (job) this.queue.requeue(job, this.now);
    this.publishQueue();
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
      this.onEngineExit(null);
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
