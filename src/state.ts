import { EventEmitter } from 'node:events';
import type * as T from '../shared/types.js'; // namespace import: a 12-name list costs ~14 lines after Prettier
import type { Store } from './store.js';

type Events = { event: [T.SseEvent] };

/** In-memory site state. Persisted parts are saved on every change; every client-visible change emits one 'event'. */
export class State extends EventEmitter<Events> {
  #engine: T.EngineConfig | null;
  #game: T.Game | null;
  #live: T.LiveInfo | null = null;
  #stream: T.StreamStatus | null = null;
  #saving: Promise<void> = Promise.resolve();
  #epoch = 0; // bumped on pick, clear and retract: invalidates every in-flight setEval

  constructor(
    private readonly store: Store,
    init: T.Persisted | null = null,
  ) {
    super();
    this.setMaxListeners(0); // one listener per SSE client (layer 7); default cap 10 would warn
    this.#engine = init?.engine ?? null;
    this.#game = init?.game ?? null;
  }

  get site(): T.SiteState {
    return !this.#game ? 'idle' : this.#game.result === '*' ? 'live' : 'finished';
  }
  get engine(): T.EngineConfig | null {
    return this.#engine;
  }
  /** Read-only view for layer 6 (resume: which positions lack a Final eval). Don't mutate. */
  get game(): Readonly<T.Game> | null {
    return this.#game;
  }
  /** Read before starting a search; pass to setEval. */
  get epoch(): number {
    return this.#epoch;
  }

  snapshot(): T.Snapshot {
    return structuredClone({ site: this.site, game: this.#game, live: this.#live, stream: this.#stream });
  }

  /** Resolves when every save requested so far has been written (tests, shutdown). */
  saved(): Promise<void> {
    return this.#saving;
  }

  setEngine(cfg: T.EngineConfig): void {
    this.#engine = cfg;
    this.persist();
  }

  /** Idle/Live/Finished → Live, with a fresh game at the start position. */
  pick(ref: T.GameRef): void {
    this.#game = { ...ref, result: '*', plies: [{ move: null, eval: null }] };
    this.#epoch++;
    this.#live = null;
    this.#stream = null;
    this.changed();
  }

  /**
   * Replace the move list with the source's full list. Plies in the common prefix keep their evals.
   * Returns how many moves were kept (positions 0..kept are unchanged), or null unless Live.
   * Append → one 'ply' event per new position; any retract → 'snapshot'.
   */
  syncMoves(moves: T.Move[]): number | null {
    const g = this.#game;
    if (!g || g.result !== '*') return null;
    let kept = 0;
    while (kept < moves.length && kept + 1 < g.plies.length && g.plies[kept + 1].move!.uci === moves[kept].uci) kept++;
    const retracted = g.plies.length > kept + 1;
    if (!retracted && kept === moves.length) return kept;
    g.plies.length = kept + 1;
    for (const move of moves.slice(kept)) g.plies.push({ move, eval: null });
    if (retracted) {
      this.#epoch++;
      this.changed();
      return kept;
    }
    for (let i = kept + 1; i < g.plies.length; i++) this.emit('event', { type: 'ply', index: i, ply: g.plies[i] });
    this.persist();
    return kept;
  }

  /** Set position `index`'s eval (Live or Finished). False if stale (`epoch` changed: re-pick, clear, retract) or no such position. */
  setEval(index: number, e: T.Eval, epoch: number): boolean {
    const g = this.#game;
    if (!g || epoch !== this.#epoch || !Number.isInteger(index) || index < 0 || index >= g.plies.length) return false;
    const ply = (g.plies[index] = { ...g.plies[index], eval: e }); // replace, never mutate: emitted objects stay valid
    this.emit('event', { type: 'ply', index, ply });
    this.persist();
    return true;
  }

  /** Live → Finished. Live info and stream status are dropped (engine stopped, source stopped itself). */
  finish(result: Exclude<T.Result, '*'>): void {
    if (this.site !== 'live') return;
    this.#game!.result = result;
    this.#live = null;
    this.#stream = null;
    this.changed();
  }

  /** → Idle. Engine config is kept. */
  clear(): void {
    this.#game = null;
    this.#epoch++;
    this.#live = null;
    this.#stream = null;
    this.changed();
  }

  setLive(live: T.LiveInfo | null): void {
    if (this.site !== 'live') return;
    this.#live = live;
    this.emit('event', { type: 'info', live });
  }

  setStream(status: T.StreamStatus): void {
    if (this.site !== 'live' || status === this.#stream) return;
    this.#stream = status;
    this.emit('event', { type: 'stream-status', status });
  }

  private changed(): void {
    this.emit('event', { type: 'snapshot', snapshot: this.snapshot() });
    this.persist();
  }

  private persist(): void {
    this.#saving = this.store
      .save({ version: 1, engine: this.#engine, game: this.#game })
      .catch((err: unknown) => console.error('state: save failed', err));
  }
}
