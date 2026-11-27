import type { SourceFactory, Source, GameUpdate } from './lichess/stream.js';
import { lichessSource } from './lichess/stream.js';
import { OpeningFallback, type OpeningFetch } from './opening.js';
import type { RoundState } from './round-state.js';

export interface FeedOpts {
  source?: SourceFactory; // default lichessSource
  now: () => number;
  fetchOpening?: OpeningFetch;
  /** After `state` recorded an update of a Board it has. kept = moves kept; before = plies.length before. */
  onMoves(tourId: string, boardId: string, kept: number, before: number): void;
}

/** One Event's live input: the source of its Current Round, recorded into its RoundState, and its opening lookups. */
export class Feed {
  private source: Source | null = null;
  private readonly openings: OpeningFallback | null;

  constructor(
    readonly state: RoundState,
    private readonly opts: FeedOpts,
  ) {
    this.openings = opts.fetchOpening
      ? new OpeningFallback({ setOpening: (id, o) => this.state.setOpening(id, o) }, opts.fetchOpening)
      : null;
  }

  /** Follow that Round: the previous source is stopped and its late updates ignored. */
  start(roundId: string): void {
    this.stop();
    const src = (this.opts.source ?? lichessSource)(roundId);
    this.source = src;
    // Stream handler exceptions are swallowed as network errors (and the update lost): never throw from these.
    src.start({
      game: (u) => this.source === src && this.onGame(u),
      status: (s) => this.source === src && this.state.setStream(s),
    });
  }

  /** Idempotent. Replies of lookups in flight are dropped. */
  stop(): void {
    this.source?.stop();
    this.source = null;
    this.openings?.clear();
  }

  private onGame(u: GameUpdate): void {
    const { state } = this;
    const moves = u.uci.map((uci, i) => ({ uci, san: u.san[i], clock: u.clocks[i] }));
    const before = state.board(u.gameId)?.plies.length ?? 0;
    const kept = state.syncMoves(u.gameId, moves, this.opts.now());
    if (kept === null) return;
    state.setResult(u.gameId, u.result);
    state.setOpening(u.gameId, u.opening);
    const b = state.board(u.gameId)!;
    if (b.tracked && !u.opening) this.openings?.seen(b.id, u.uci);
    this.opts.onMoves(state.event.tourId, b.id, kept, before);
  }
}
