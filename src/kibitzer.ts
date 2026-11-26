import { Chess } from 'chess.js';
import type { Score } from '../shared/accuracy.js';
import type { EngineConfig, EvalKind, GameRef, PvLine, Result } from '../shared/types.js';
import { Engine, type SearchResult } from './engine/engine.js';
import type { UciInfo, UciScore } from './engine/uci-parser.js';
import { lichessSource, type GameUpdate, type Source, type SourceFactory } from './lichess/stream.js';
import type { State } from './state.js';

export const BACKFILL_MS = 100;

export interface KibitzerOpts {
  defaultEngine: EngineConfig; // used while state.engine is null
  source?: SourceFactory; // default lichessSource
  launch?: (cfg: EngineConfig) => Promise<Engine>; // default Engine.start(cfg.path); tests spawn the fake
  backfillMs?: number; // default BACKFILL_MS
}

/** One pick (or boot resume): its engine, its source, and the worker's progress. */
interface Session {
  engine: Engine;
  source: Source;
  pending: GameUpdate | null; // latest unapplied update (full snapshots, so only the latest matters)
  busy: boolean; // worker running
  tried: Set<number>; // positions backfilled this session (a null result is not retried)
  live: { ply: number; epoch: number; fen: string; lines: PvLine[]; nps: number | null } | null;
}

/** UCI score (side to move at position `ply`) → White POV. Mate 0 = no eval (mated / stalemated). */
export function toScore(s: UciScore, ply: number): Score | null {
  const sign = ply % 2 === 0 ? 1 : -1;
  if (s.unit === 'mate') return s.value === 0 ? null : { mate: sign * s.value };
  return { cp: sign * s.value };
}

/** PV in UCI → SAN from `fen`; stops at the first illegal move. */
export function pvToSan(fen: string, pv: string[]): string[] {
  const chess = new Chess(fen);
  const san: string[] = [];
  for (const m of pv) {
    try {
      san.push(chess.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] }).san);
    } catch {
      break;
    }
  }
  return san;
}

const log = (err: unknown) => console.error('kibitzer:', err);

/**
 * Drives the Kibitzer from the Featured game's source. One worker per session applies updates strictly one at a
 * time: stop the Live search → record its Final eval → sync moves → Backfill positions with no eval → `go infinite`
 * on the Live position.
 */
export class Kibitzer {
  private session: Session | null = null;
  private ops: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly state: State,
    private readonly opts: KibitzerOpts,
  ) {}

  /** The engine process (tests). Null when Idle or Finished. */
  get engine(): Engine | null {
    return this.session?.engine ?? null;
  }

  /** Admin pick → Live. Rejects (and leaves the site Idle) if the engine fails to start. */
  pick(ref: GameRef): Promise<void> {
    return this.serial(() => this.open(ref, true));
  }

  /** Boot: if the persisted game is Live, reconnect and carry on. Missed positions are Backfilled. */
  resume(): Promise<void> {
    return this.serial(async () => {
      const g = this.state.game;
      if (this.state.site === 'live' && g) await this.open(g, false);
    });
  }

  /** Admin clear → Idle; kills the engine. */
  clear(): Promise<void> {
    return this.serial(async () => {
      await this.close();
      this.state.clear();
    });
  }

  private serial(op: () => Promise<void>): Promise<void> {
    const p = this.ops.then(op);
    this.ops = p.catch(() => {});
    return p;
  }

  private async open(ref: GameRef, fresh: boolean): Promise<void> {
    await this.close();
    const cfg = this.state.engine ?? this.opts.defaultEngine;
    let engine: Engine | undefined;
    try {
      engine = await (this.opts.launch ?? ((c) => Engine.start(c.path)))(cfg);
      for (const [k, v] of Object.entries(cfg.options)) engine.setOption(k, v);
      await engine.isReady();
    } catch (err) {
      void engine?.quit();
      this.state.clear();
      throw err;
    }
    if (fresh) this.state.pick(ref);
    const source = (this.opts.source ?? lichessSource)(ref.roundId);
    const s: Session = { engine, source, pending: null, busy: false, tried: new Set(), live: null };
    this.session = s;
    engine.on('info', (info) => this.onInfo(s, info));
    engine.on('exit', (code, signal) => {
      if (this.session === s) log(`engine exited (${code ?? signal})`); // no restart: Admin re-picks
    });
    // Stream handler exceptions are swallowed as network errors (and the update lost): never throw from these.
    source.start({
      game: (u) => {
        if (this.session !== s || u.gameId !== ref.id) return;
        s.pending = u;
        this.kick(s);
      },
      status: (st) => {
        if (this.session === s) this.state.setStream(st);
      },
    });
  }

  private async close(): Promise<void> {
    const s = this.session;
    if (!s) return;
    this.session = null;
    s.source.stop();
    await s.engine.quit();
  }

  private kick(s: Session): void {
    if (s.busy) return;
    s.busy = true;
    this.work(s).catch((err) => this.session === s && log(err));
  }

  private async work(s: Session): Promise<void> {
    try {
      while (this.session === s) {
        const u = s.pending;
        s.pending = null;
        if (u) await this.apply(s, u);
        else if (this.state.site !== 'live') return;
        else {
          const plies = this.state.game!.plies;
          const i = plies.findIndex((p, i) => i < plies.length - 1 && !p.eval && !s.tried.has(i));
          if (i < 0) {
            if (!s.live) this.startLive(s); // already searching if the update changed nothing
            return;
          }
          s.tried.add(i);
          const epoch = this.state.epoch;
          const r = await s.engine.search(this.uci(i), { movetime: this.opts.backfillMs ?? BACKFILL_MS });
          this.record(i, r, 'backfill', epoch);
        }
      }
    } finally {
      s.busy = false;
    }
  }

  private async apply(s: Session, u: GameUpdate): Promise<void> {
    const plies = this.state.game!.plies;
    const same = u.uci.length === plies.length - 1 && u.uci.every((m, i) => m === plies[i + 1].move!.uci);
    if (same && u.status === 'ongoing') return;
    const live = s.live;
    s.live = null;
    const r = live ? await s.engine.stop() : undefined;
    if (this.session !== s) return;
    const kept = this.state.syncMoves(u.uci.map((uci, i) => ({ uci, san: u.san[i], clock: u.clocks[i] })));
    if (live) this.record(live.ply, r, 'final', live.epoch); // stale after a retract: the epoch guard drops it
    for (const i of s.tried) if (kept !== null && i > kept) s.tried.delete(i);
    if (u.status === 'finished') {
      this.state.finish(u.result as Exclude<Result, '*'>);
      await this.close(); // game end: Finished has no engine process, same as Idle
    } else if (live) this.state.setLive(null);
  }

  private startLive(s: Session): void {
    const ply = this.state.game!.plies.length - 1;
    const moves = this.uci(ply);
    const chess = new Chess();
    for (const m of moves) chess.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] });
    s.live = { ply, epoch: this.state.epoch, fen: chess.fen(), lines: [], nps: null };
    void s.engine.search(moves, 'infinite');
  }

  private onInfo(s: Session, info: UciInfo): void {
    const live = s.live;
    if (this.session !== s || !live || !info.score || info.score.bound) return; // drained Backfill / stopped searches
    const score = toScore(info.score, live.ply);
    if (!score) return;
    live.lines[info.multipv - 1] = { score, depth: info.depth ?? 0, san: pvToSan(live.fen, info.pv) };
    live.nps = info.nps ?? live.nps;
    const lines = live.lines.filter(Boolean);
    this.state.setLive({ ply: live.ply, engine: s.engine.name, depth: lines[0]?.depth ?? 0, nps: live.nps, lines });
  }

  /** UCI moves reaching position `ply`. */
  private uci(ply: number): string[] {
    return this.state.game!.plies.slice(1, ply + 1).map((p) => p.move!.uci);
  }

  private record(ply: number, r: SearchResult | undefined, kind: EvalKind, epoch: number): void {
    const score = r?.info?.score && r.bestmove !== '(none)' ? toScore(r.info.score, ply) : null;
    if (score) this.state.setEval(ply, { score, depth: r!.info!.depth ?? 0, kind, bestmove: r!.bestmove }, epoch);
  }
}
