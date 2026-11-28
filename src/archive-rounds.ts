import type * as T from '../shared/types.js';
import type { DataStore } from './store.js';

/** Where a Job's eval is recorded: the Boards of a Round, each with an epoch read before the Job and checked by
 *  setEval (a stale one is refused). Implemented by RoundState (an Event's Current Round) and ArchiveRounds. */
export interface EvalTarget {
  board(boardId: string): Readonly<T.Board> | undefined;
  epoch(boardId: string): number; // -1 for an unknown Board
  /** False: unknown Board, stale epoch, index out of range, or e is provisional and the ply has a Complete eval. */
  setEval(boardId: string, index: number, e: T.Eval, epoch: number): boolean;
}

/** What ArchiveRounds needs from its SiteState. */
export interface ArchiveHost {
  nextEpoch(): number;
  saved(): Promise<void>; // every state + Round write requested so far has been written
  wanted(tourId: string, roundId: string): boolean; // a deep request is for that Round, and it is no Event's Current Round
}

const key = (tourId: string, roundId: string) => `${tourId}/${roundId}`;

/**
 * The Rounds that are no Event's Current Round (the Archive) while they have deep analysis left: loaded from their file
 * on demand, kept in memory while wanted, and meanwhile the only writer of their files. Board ids are globally unique,
 * so the EvalTarget methods look a Board up across every Round held. Emits nothing.
 */
export class ArchiveRounds implements EvalTarget {
  #rounds = new Map<string, T.Round>();
  #epochs = new Map<string, number>(); // by boardId, of the Rounds held
  #loading = new Map<string, Promise<T.Round | null>>();
  #saving: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: Pick<DataStore, 'loadRound' | 'saveRound'>,
    private readonly host: ArchiveHost,
  ) {}

  /** The Round if held. Don't mutate. */
  round(tourId: string, roundId: string): Readonly<T.Round> | undefined {
    return this.#rounds.get(key(tourId, roundId));
  }

  /** The Round: held, else read from its file once every write requested so far is written (host.saved()), and held
   *  from then on only while host.wanted. Concurrent opens share one read. null: no such file; rejects: a corrupt one. */
  async open(tourId: string, roundId: string): Promise<Readonly<T.Round> | null> {
    const k = key(tourId, roundId);
    const held = this.#rounds.get(k);
    if (held) return held;
    let loading = this.#loading.get(k);
    if (!loading) {
      loading = this.host
        .saved()
        .then(() => this.store.loadRound(tourId, roundId))
        .finally(() => this.#loading.delete(k));
      this.#loading.set(k, loading);
    }
    const round = await loading;
    if (!round) return null;
    const again = this.#rounds.get(k); // another open held it first
    if (again) return again;
    if (this.host.wanted(tourId, roundId)) {
      this.#rounds.set(k, round);
      for (const b of round.boards) this.#epochs.set(b.id, this.host.nextEpoch());
    }
    return round;
  }

  board(boardId: string): Readonly<T.Board> | undefined {
    return this.#find(boardId)?.board;
  }

  epoch(boardId: string): number {
    return this.#epochs.get(boardId) ?? -1;
  }

  setEval(boardId: string, index: number, e: T.Eval, epoch: number): boolean {
    const found = this.#find(boardId);
    if (!found || epoch !== this.#epochs.get(boardId) || !Number.isInteger(index) || index < 0) return false;
    const b = found.board as T.Board;
    if (index >= b.plies.length) return false;
    if (e.kind === 'provisional' && b.plies[index].eval?.kind === 'complete') return false;
    b.plies[index] = { ...b.plies[index], eval: e };
    this.#save(found.round);
    return true;
  }

  /** The Round is about to become an Event's Current Round: stop holding it (after a read in flight), wait for its
   *  writes, and return the copy held (newer than its file), or null when none was. */
  async release(tourId: string, roundId: string): Promise<T.Round | null> {
    await this.#loading.get(key(tourId, roundId))?.catch(() => null);
    const round = this.#rounds.get(key(tourId, roundId)) ?? null;
    this.drop(tourId, roundId);
    await this.#saving;
    return round;
  }

  /** Stop holding the Round (its last deep request ended); its writes still complete. */
  drop(tourId: string, roundId: string): void {
    const k = key(tourId, roundId);
    const round = this.#rounds.get(k);
    if (!round) return;
    this.#rounds.delete(k);
    for (const b of round.boards) this.#epochs.delete(b.id);
  }

  /** Resolves when every Round write requested so far has been written. */
  saved(): Promise<void> {
    return this.#saving;
  }

  #find(boardId: string): { round: T.Round; board: Readonly<T.Board> } | undefined {
    for (const round of this.#rounds.values()) {
      const board = round.boards.find((b) => b.id === boardId);
      if (board) return { round, board };
    }
    return undefined;
  }

  #save(round: T.Round): void {
    const saving = this.store
      .saveRound(round)
      .catch((err: unknown) => console.error('archive-rounds: save failed', err));
    this.#saving = Promise.all([this.#saving, saving]).then(() => {});
  }
}
