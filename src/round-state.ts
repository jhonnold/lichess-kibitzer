import * as T from '../shared/types.js';
import type { RoundInfo } from './lichess/api.js';
import type { DataStore } from './store.js';

/** What a RoundState needs from its SiteState: the only emitter, the state file, the shared epoch counter and the
 *  site-wide search/queue. After the Event is removed, emit and save do nothing. */
export interface RoundHost {
  emit(e: T.SseEvent): void; // tagged with this Event
  save(): void; // state.json of every Event
  nextEpoch(): number;
  search(): T.SearchInfo | null; // the running Job's search if that Job is this Event's, else null
  queue(): T.QueueView; // the global Queue
}

const newBoard = (b: RoundInfo['boards'][number], i: number, tracked: boolean): T.Board => ({
  id: b.id,
  board: i + 1,
  white: b.white,
  black: b.black,
  result: b.result,
  tracked,
  opening: null,
  clocks: { white: b.whiteClockMs ?? null, black: b.blackClockMs ?? null },
  plies: [{ move: null, at: null, eval: null }],
});
/** One Event's in-memory state: its Current Round (every Board), Dead-letter queue and stream status. Events go to
 *  the host for Tracked boards only; persisted parts are saved (via the host) on every change. */
export class RoundState {
  readonly event: T.RegisteredEvent;
  #topN: number;
  #round: T.Round | null;
  #dead: T.DeadJob[];
  #stream: T.StreamStatus | null = null;
  #epochs = new Map<string, number>();
  #synced = new Set<string>(); // Boards synced since construction/startRound
  #unknown = false; // the source sent a game the Round lacks (a Board added on Lichess after the Round was fetched)
  #roundSaving: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: Pick<DataStore, 'saveRound'>,
    private readonly host: RoundHost,
    init: { entry: T.PersistedEvent; round: T.Round | null },
  ) {
    this.event = init.entry.event;
    this.#topN = init.entry.topN;
    this.#dead = init.entry.dead;
    this.#round = init.round;
    for (const b of init.round?.boards ?? []) this.#epochs.set(b.id, host.nextEpoch());
  }

  /** Default Tracked boards for the next Round. */
  get topN(): number {
    return this.#topN;
  }
  /** Every Board, untracked too. Don't mutate. */
  get round(): Readonly<T.Round> | null {
    return this.#round;
  }
  get stream(): T.StreamStatus | null {
    return this.#stream;
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

  /** The state file's entry for this Event. */
  persisted(): T.PersistedEvent {
    const current = this.#round && { tourId: this.#round.tourId, roundId: this.#round.roundId };
    return { event: this.event, topN: this.#topN, current, dead: this.#dead };
  }

  snapshot(): T.Snapshot {
    const round = this.#round && { ...this.#round, boards: this.#round.boards.filter((b) => b.tracked) };
    return structuredClone({
      event: this.event,
      round,
      search: this.host.search(),
      queue: this.host.queue(),
      stream: this.#stream,
    });
  }

  /** Resolves when every Round save requested so far has been written (tests, shutdown). */
  saved(): Promise<void> {
    return this.#roundSaving;
  }

  /** Replace the Current Round with fresh Boards, the first topN tracked. */
  startRound(r: RoundInfo, startsAt: number | null): void {
    this.#round = {
      tourId: r.tourId,
      roundId: r.id,
      name: r.name,
      eventName: this.event.name,
      startsAt,
      boards: r.boards.map((b, i) => newBoard(b, i, i < this.#topN)),
    };
    this.#epochs = new Map(this.#round.boards.map((b) => [b.id, this.host.nextEpoch()]));
    this.#synced.clear();
    this.#unknown = false;
    this.#dead = [];
    this.resetTransient();
    this.host.emit({ type: 'snapshot', snapshot: this.snapshot() });
    this.saveRound();
    this.host.save();
  }

  /** Make a Round loaded from its file current again (evals and tracked set kept): new epochs, #synced cleared,
   *  dead [], transient reset, 'snapshot' event, saveState (no saveRound: nothing changed). */
  openRound(round: T.Round): void {
    this.#round = round;
    this.#epochs = new Map(round.boards.map((b) => [b.id, this.host.nextEpoch()]));
    this.#synced.clear();
    this.#unknown = false;
    this.#dead = [];
    this.resetTransient();
    this.host.emit({ type: 'snapshot', snapshot: this.snapshot() });
    this.host.save();
  }

  /** Lichess moved the start. No-op when equal or no Round; else saveRound + 'snapshot' event. */
  setStartsAt(startsAt: number | null): void {
    if (!this.#round || this.#round.startsAt === startsAt) return;
    this.#round.startsAt = startsAt;
    this.host.emit({ type: 'snapshot', snapshot: this.snapshot() });
    this.saveRound();
  }

  /** True once the source sent a game that is not a Board of the Current Round. */
  get hasUnknownBoards(): boolean {
    return this.#unknown;
  }

  /** Append the Boards Lichess lists that the Round lacks, untracked, in Lichess order. Clears hasUnknownBoards. */
  addBoards(boards: RoundInfo['boards']): void {
    this.#unknown = false;
    const r = this.#round;
    if (!r) return;
    const add = boards.filter((b) => !r.boards.some((x) => x.id === b.id));
    for (const b of add) {
      r.boards.push(newBoard(b, r.boards.length, false));
      this.#epochs.set(b.id, this.host.nextEpoch());
    }
    if (add.length) this.saveRound();
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
      this.host.emit(b.tracked ? { type: 'board', board: structuredClone(b) } : { type: 'untrack', boardId: b.id });
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
    if (!b) {
      this.#unknown = !!this.#round;
      return null;
    }
    const at = this.#synced.has(boardId) ? now : null;
    this.#synced.add(boardId);
    let kept = 0;
    while (kept < moves.length && kept + 1 < b.plies.length && b.plies[kept + 1].move!.uci === moves[kept].uci) kept++;
    const retracted = b.plies.length > kept + 1;
    if (!retracted && kept === moves.length) return kept;
    b.plies.length = kept + 1;
    for (const move of moves.slice(kept)) b.plies.push({ move, at, eval: null });
    if (retracted) {
      this.#epochs.set(boardId, this.host.nextEpoch());
      if (b.tracked) this.host.emit({ type: 'board', board: structuredClone(b) });
    } else if (b.tracked) {
      for (let i = kept + 1; i < b.plies.length; i++) {
        this.host.emit({ type: 'ply', boardId, index: i, ply: b.plies[i] });
      }
    }
    this.saveRound();
    return kept;
  }

  /** Unknown Board, null or an unchanged name: no-op (a name is never cleared). Else set, save, 'board' event (Tracked). */
  setOpening(boardId: string, opening: string | null): void {
    const b = this.board(boardId) as T.Board | undefined;
    if (!b || !opening || b.opening === opening) return;
    b.opening = opening;
    if (b.tracked) this.host.emit({ type: 'board', board: structuredClone(b) });
    this.saveRound();
  }

  /** False: unknown Board, stale epoch, index out of range, or e is provisional and the ply has a Complete eval. */
  setEval(boardId: string, index: number, e: T.Eval, epoch: number): boolean {
    const b = this.board(boardId) as T.Board | undefined;
    if (!b || epoch !== this.#epochs.get(boardId) || !Number.isInteger(index) || index < 0 || index >= b.plies.length) {
      return false;
    }
    if (e.kind === 'provisional' && b.plies[index].eval?.kind === 'complete') return false;
    const ply = (b.plies[index] = { ...b.plies[index], eval: e }); // replace, never mutate: emitted objects stay valid
    if (b.tracked) this.host.emit({ type: 'ply', boardId, index, ply });
    this.saveRound();
    return true;
  }

  /** Set the Board's result ('*' allowed: a correction). 'result' event only when it changed. */
  setResult(boardId: string, result: T.Result): void {
    const b = this.board(boardId) as T.Board | undefined;
    if (!b || b.result === result) return;
    b.result = result;
    if (b.tracked) this.host.emit({ type: 'result', boardId, result });
    this.saveRound();
  }

  setStream(status: T.StreamStatus | null): void {
    if (status === this.#stream) return;
    this.#stream = status;
    this.host.emit({ type: 'stream-status', status });
  }

  /** The next Round's default only; the current tracked set is unchanged. */
  setTopN(topN: number): void {
    this.#topN = topN;
    this.host.save();
  }

  /** The Queue is the source of truth; this persists it. */
  setDead(dead: T.DeadJob[]): void {
    this.#dead = dead;
    this.host.save();
  }

  private resetTransient(): void {
    this.#stream = null;
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
