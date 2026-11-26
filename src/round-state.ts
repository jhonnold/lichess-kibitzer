import { EventEmitter } from 'node:events';
import * as T from '../shared/types-v2.js'; // namespace import: v1 types.ts names clash until layer 6
import type { RoundInfo } from './lichess/api.js';
import type { DataStore } from './store.js';

type Events = { event: [T.SseEvent] };

const EMPTY_QUEUE: T.QueueView = { current: [], backfill: 0 };
const DEFAULT_SETTINGS: T.Settings = { event: null, engine: null, jobTimeMs: null, topN: T.DEFAULT_TOP_N };

/** In-memory site state: settings, the Current Round (every Board) and transient search/queue/stream. Events are
 *  emitted for Tracked boards only; persisted parts are saved on every change. */
export class RoundState extends EventEmitter<Events> {
  #settings: T.Settings;
  #round: T.Round | null;
  #dead: T.DeadJob[];
  #search: T.SearchInfo | null = null;
  #queue: T.QueueView = EMPTY_QUEUE;
  #stream: T.StreamStatus | null = null;
  #seq = 0; // epochs are never reused across Rounds
  #epochs = new Map<string, number>();
  #synced = new Set<string>(); // Boards synced since construction/startRound
  #stateSaving: Promise<void> = Promise.resolve();
  #roundSaving: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: DataStore,
    init: { state: T.PersistedState | null; round: T.Round | null } = { state: null, round: null },
  ) {
    super();
    this.setMaxListeners(0); // one listener per SSE client; default cap 10 would warn
    this.#settings = init.state?.settings ?? DEFAULT_SETTINGS;
    this.#dead = init.state?.dead ?? [];
    this.#round = init.round;
    for (const b of init.round?.boards ?? []) this.#epochs.set(b.id, ++this.#seq);
  }

  /** load() then loadRound(current) (null if current is null). */
  static async load(store: DataStore): Promise<RoundState> {
    const state = await store.load();
    const round = state?.current ? await store.loadRound(state.current.tourId, state.current.roundId) : null;
    return new RoundState(store, { state, round });
  }

  get settings(): Readonly<T.Settings> {
    return this.#settings;
  }
  /** Every Board, untracked too. Don't mutate. */
  get round(): Readonly<T.Round> | null {
    return this.#round;
  }
  get dead(): readonly T.DeadJob[] {
    return this.#dead;
  }
  board(boardId: string): Readonly<T.Board> | undefined {
    return this.#round?.boards.find((b) => b.id === boardId);
  }
  /** Read before a Job; pass to setEval. -1 for an unknown Board. */
  epoch(boardId: string): number {
    return this.#epochs.get(boardId) ?? -1;
  }

  snapshot(): T.Snapshot {
    const round = this.#round && { ...this.#round, boards: this.#round.boards.filter((b) => b.tracked) };
    return structuredClone({
      event: this.#settings.event,
      round,
      search: this.#search,
      queue: this.#queue,
      stream: this.#stream,
    });
  }

  /** Resolves when every state + round save requested so far has been written (tests, shutdown). */
  async saved(): Promise<void> {
    await Promise.all([this.#stateSaving, this.#roundSaving]);
  }

  /** Replace the Current Round with fresh Boards, the first settings.topN tracked. */
  startRound(r: RoundInfo, startsAt: number | null): void {
    this.#round = {
      tourId: r.tourId,
      roundId: r.id,
      name: r.name,
      eventName: this.#settings.event?.name ?? '',
      startsAt,
      boards: r.boards.map((b, i) => ({
        id: b.id,
        board: i + 1,
        white: b.white,
        black: b.black,
        result: b.result,
        tracked: i < this.#settings.topN,
        opening: null,
        clocks: { white: b.whiteClockMs ?? null, black: b.blackClockMs ?? null },
        plies: [{ move: null, at: null, eval: null }],
      })),
    };
    this.#epochs = new Map(this.#round.boards.map((b) => [b.id, ++this.#seq]));
    this.#synced.clear();
    this.#dead = [];
    this.resetTransient();
    this.emit('event', { type: 'snapshot', snapshot: this.snapshot() });
    this.saveRound();
    this.saveState();
  }

  /** Exact tracked set; unknown ids ignored. Lasts this Round only. */
  setTracked(boardIds: readonly string[]): void {
    if (!this.#round) return;
    const want = new Set(boardIds);
    let changed = false;
    for (const b of this.#round.boards) {
      if (b.tracked === want.has(b.id)) continue;
      b.tracked = !b.tracked;
      changed = true;
      this.emit('event', b.tracked ? { type: 'board', board: structuredClone(b) } : { type: 'untrack', boardId: b.id });
    }
    if (changed) this.saveRound();
  }

  /**
   * Replace a Board's move list with the source's full list. Plies in the common prefix keep their evals.
   * Returns how many moves were kept, or null for an unknown Board. New plies get at = now, except on the Board's
   * first call (at = null: already played when first seen). Append → one 'ply' event each; retract → 'board'.
   */
  syncMoves(boardId: string, moves: T.Move[], now: number): number | null {
    const b = this.board(boardId) as T.Board | undefined;
    if (!b) return null;
    const at = this.#synced.has(boardId) ? now : null;
    this.#synced.add(boardId);
    let kept = 0;
    while (kept < moves.length && kept + 1 < b.plies.length && b.plies[kept + 1].move!.uci === moves[kept].uci) kept++;
    const retracted = b.plies.length > kept + 1;
    if (!retracted && kept === moves.length) return kept;
    b.plies.length = kept + 1;
    for (const move of moves.slice(kept)) b.plies.push({ move, at, eval: null });
    if (retracted) {
      this.#epochs.set(boardId, ++this.#seq);
      if (b.tracked) this.emit('event', { type: 'board', board: structuredClone(b) });
    } else if (b.tracked) {
      for (let i = kept + 1; i < b.plies.length; i++) {
        this.emit('event', { type: 'ply', boardId, index: i, ply: b.plies[i] });
      }
    }
    this.saveRound();
    return kept;
  }

  /** False: unknown Board, stale epoch, index out of range, or e is provisional and the ply has a Complete eval. */
  setEval(boardId: string, index: number, e: T.Eval, epoch: number): boolean {
    const b = this.board(boardId) as T.Board | undefined;
    if (!b || epoch !== this.#epochs.get(boardId) || !Number.isInteger(index) || index < 0 || index >= b.plies.length) {
      return false;
    }
    if (e.kind === 'provisional' && b.plies[index].eval?.kind === 'complete') return false;
    const ply = (b.plies[index] = { ...b.plies[index], eval: e }); // replace, never mutate: emitted objects stay valid
    if (b.tracked) this.emit('event', { type: 'ply', boardId, index, ply });
    this.saveRound();
    return true;
  }

  /** Set the Board's result ('*' allowed: a correction). 'result' event only when it changed. */
  setResult(boardId: string, result: T.Result): void {
    const b = this.board(boardId) as T.Board | undefined;
    if (!b || b.result === result) return;
    b.result = result;
    if (b.tracked) this.emit('event', { type: 'result', boardId, result });
    this.saveRound();
  }

  setSearch(search: T.SearchInfo | null): void {
    this.#search = search;
    this.emit('event', { type: 'search', search });
  }

  setQueue(queue: T.QueueView): void {
    this.#queue = queue;
    this.emit('event', { type: 'queue', queue });
  }

  setStream(status: T.StreamStatus | null): void {
    if (status === this.#stream) return;
    this.#stream = status;
    this.emit('event', { type: 'stream-status', status });
  }

  /** Register (or clear with null) the Event. Drops the Current Round (its file stays: Archive), the Dead-letter queue
   *  and transient state. */
  setEvent(event: T.RegisteredEvent | null): void {
    this.#settings = { ...this.#settings, event };
    this.#round = null;
    this.#epochs.clear();
    this.#synced.clear();
    this.#dead = [];
    this.resetTransient();
    this.emit('event', { type: 'snapshot', snapshot: this.snapshot() });
    this.saveState();
  }

  setEngine(engine: T.EngineConfig): void {
    this.#settings = { ...this.#settings, engine };
    this.saveState();
  }

  setJobTime(jobTimeMs: number | null): void {
    this.#settings = { ...this.#settings, jobTimeMs };
    this.saveState();
  }

  /** The next Round's default only; the current tracked set is unchanged. */
  setTopN(topN: number): void {
    this.#settings = { ...this.#settings, topN };
    this.saveState();
  }

  /** The Queue is the source of truth; this persists it. */
  setDead(dead: T.DeadJob[]): void {
    this.#dead = dead;
    this.saveState();
  }

  private resetTransient(): void {
    this.#search = null;
    this.#queue = EMPTY_QUEUE;
    this.#stream = null;
  }

  private saveState(): void {
    const current = this.#round && { tourId: this.#round.tourId, roundId: this.#round.roundId };
    this.#stateSaving = this.store
      .save({ version: 2, settings: this.#settings, current, dead: this.#dead })
      .catch((err: unknown) => console.error('round-state: save failed', err));
  }

  private saveRound(): void {
    if (!this.#round) return;
    const saving = this.store
      .saveRound(this.#round)
      .catch((err: unknown) => console.error('round-state: save failed', err));
    // chained: after startRound the previous Round's file may still be writing
    this.#roundSaving = Promise.all([this.#roundSaving, saving]).then(() => {});
  }
}
