import { readFileSync } from 'node:fs';
import {
  parseGame,
  pgnSplitter,
  type GameUpdate,
  type Source,
  type SourceHandlers,
  type StreamStatus,
} from '../../src/lichess/stream.js';

/** File-replay fake of a Source for layers 6 and 7. */
export class ReplaySource implements Source {
  started = false;
  stopped = false;
  private h?: SourceHandlers;
  private i = 0;
  constructor(readonly updates: GameUpdate[]) {}
  static fromFile(path: string, gameId: string): ReplaySource {
    return new ReplaySource(
      pgnSplitter()(readFileSync(path, 'utf8'))
        .map((p) => parseGame(p, gameId))
        .filter((u): u is GameUpdate => u !== null),
    );
  }
  start(h: SourceHandlers) {
    this.h = h;
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
  next(): GameUpdate | undefined {
    const u = this.updates[this.i++];
    if (u) this.h?.game(u);
    return u;
  }
  push(u: GameUpdate) {
    this.h?.game(u);
    if (u.status === 'finished') this.stopped = true;
  }
  status(s: StreamStatus) {
    this.h?.status(s);
  }
}
