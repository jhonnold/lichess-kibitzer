import type { RoundState } from './round-state.js';

/** Explorer lookups stop past this many plies: the masters book is empty by then. */
export const OPENING_MAX_PLY = 30;
export type OpeningFetch = (uci: readonly string[]) => Promise<string | null>;

/** Fallback for tracked Boards whose PGN has no Opening tag: the masters explorer, at most one request in flight per Board. */
export class OpeningFallback {
  #asked = new Map<string, number>(); // boardId → uci length last asked
  #stopped = new Set<string>();
  #inFlight = new Set<string>();
  #generation = 0;

  constructor(
    private readonly state: Pick<RoundState, 'setOpening'>,
    private readonly fetchOpening: OpeningFetch,
  ) {}

  /** An untagged update of a tracked Board. Looks up the latest position when 0 < uci.length <= OPENING_MAX_PLY, the
   *  Board is not stopped, uci.length > the last length asked, and no lookup for it is in flight (a move arriving
   *  meanwhile is skipped; the next one asks). A name → setOpening; null or a throw → stop for that Board. */
  seen(boardId: string, uci: readonly string[]): void {
    const n = uci.length;
    if (n === 0 || n > OPENING_MAX_PLY || this.#stopped.has(boardId) || this.#inFlight.has(boardId)) return;
    if (n <= (this.#asked.get(boardId) ?? 0)) return;
    this.#asked.set(boardId, n);
    this.#inFlight.add(boardId);
    const gen = this.#generation;
    this.fetchOpening(uci).then(
      (name) => this.#done(gen, boardId, name),
      () => this.#done(gen, boardId, null),
    );
  }

  #done(gen: number, boardId: string, name: string | null): void {
    if (gen !== this.#generation) return; // a reply for the previous Round
    this.#inFlight.delete(boardId);
    if (name) this.state.setOpening(boardId, name);
    else this.#stopped.add(boardId);
  }

  /** Round swap: forget everything; replies still in flight are dropped. */
  clear(): void {
    this.#generation++;
    this.#asked.clear();
    this.#stopped.clear();
    this.#inFlight.clear();
  }
}
