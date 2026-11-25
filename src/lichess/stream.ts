import { Chess } from 'chess.js';
import { USER_AGENT, RATE_LIMIT_MS, type Fetch, type Player, type Result } from './api.js';

export type StreamStatus = 'connected' | 'reconnecting';
/** Full snapshot of the Featured game, not a delta. `uci`/`san` may shrink or diverge between emits (broadcast retracts). */
export interface GameUpdate {
  gameId: string;
  white: Player;
  black: Player;
  uci: string[]; // for `position startpos moves …`
  san: string[]; // same plies, for the move list
  clocks: (number | null)[]; // ms left for the mover after ply i, from [%clk]; null if absent
  result: Result;
  status: 'ongoing' | 'finished'; // finished ⇔ result !== '*'
}
export interface SourceHandlers {
  game(u: GameUpdate): void;
  status(s: StreamStatus): void;
}
export interface Source {
  start(h: SourceHandlers): void;
  stop(): void;
}
export type SourceFactory = (roundId: string, gameId: string) => Source;
export const MIN_BACKOFF_MS = 1_000;
export const MAX_BACKOFF_MS = 60_000;

// A complete game = header lines, blank line, movetext (no blank lines inside), blank line.
const GAME = /^\s*((?:\[[^\n]*\]\n)+\n[^\n][\s\S]*?)\n\n/;
export function pgnSplitter() {
  let buf = '';
  return (chunk: string) => {
    buf += chunk;
    const out: string[] = [];
    for (let m = GAME.exec(buf); m; m = GAME.exec(buf)) {
      out.push(m[1]);
      buf = buf.slice(m[0].length);
    }
    return out;
  };
}

const RESULTS = new Set(['1-0', '0-1', '1/2-1/2', '*']);
const tag = (pgn: string, k: string) => pgn.match(new RegExp(`^\\[${k} "(.*)"\\]$`, 'm'))?.[1];
const clk = (c: string) => {
  const m = c.match(/\[%clk (\d+):(\d\d):(\d\d(?:\.\d+)?)\]/);
  return m ? Math.round((+m[1] * 3600 + +m[2] * 60 + +m[3]) * 1000) : null;
};

export function parseGame(text: string, gameId: string): GameUpdate | null {
  if (tag(text, 'GameURL')?.split('/').pop() !== gameId) return null; // GameURL, not Site (see findings)
  if (tag(text, 'FEN') || (tag(text, 'Variant') ?? 'Standard') !== 'Standard') return null; // layer 6 sends startpos
  const chess = new Chess();
  const uci: string[] = [],
    san: string[] = [],
    clocks: (number | null)[] = [];
  let depth = 0;
  const movetext = text.slice(text.indexOf('\n\n') + 2);
  try {
    for (const [, comment, paren, tok] of movetext.matchAll(/\{([^}]*)\}|([()])|([^\s{}()]+)/g)) {
      if (comment !== undefined) {
        if (depth === 0 && san.length) clocks[san.length - 1] = clk(comment) ?? clocks[san.length - 1];
        continue;
      }
      if (paren) {
        depth += paren === '(' ? 1 : -1;
        continue;
      } // skip variations
      const t = tok.replace(/^\d+\.+/, '').replace(/[?!]+$/, '');
      if (!t || depth > 0 || RESULTS.has(t) || t.startsWith('$')) continue;
      const m = chess.move(t);
      uci.push(m.lan);
      san.push(m.san);
      clocks.push(null);
    }
  } catch {
    return null;
  } // illegal/corrupt movetext: skip this update
  const result = (RESULTS.has(tag(text, 'Result') ?? '') ? tag(text, 'Result') : '*') as Result;
  const player = (c: 'White' | 'Black'): Player => ({
    name: tag(text, c) ?? '?',
    title: tag(text, `${c}Title`),
    rating: Number(tag(text, `${c}Elo`)) || undefined,
  });
  return {
    gameId,
    white: player('White'),
    black: player('Black'),
    uci,
    san,
    clocks,
    result,
    status: result === '*' ? 'ongoing' : 'finished',
  };
}

export interface StreamOpts {
  fetch?: Fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

// Remove the abort listener when the timer fires: one listener per reconnect would pile up on the long-lived signal
// (Node warns "Possible EventTarget memory leak" after 10).
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((r) => {
    if (signal.aborted) return r();
    const done = () => {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      r();
    };
    const t = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });

export class RoundStream implements Source {
  private ctrl = new AbortController();
  private last = '';
  done: Promise<void> = Promise.resolve();
  constructor(
    private roundId: string,
    private gameId: string,
    private opts: StreamOpts = {},
  ) {}
  start(h: SourceHandlers) {
    this.done = this.run(h);
  }
  stop() {
    this.ctrl.abort();
  }

  private async run(h: SourceHandlers) {
    const { signal } = this.ctrl;
    const url = `https://lichess.org/api/stream/broadcast/round/${this.roundId}.pgn`;
    let delay = MIN_BACKOFF_MS;
    while (!signal.aborted) {
      let wait = delay;
      try {
        const res = await (this.opts.fetch ?? fetch)(url, { signal, headers: { 'User-Agent': USER_AGENT } });
        if (res.status === 429) {
          void res.body?.cancel();
          wait = RATE_LIMIT_MS;
        } else if (!res.ok || !res.body) {
          void res.body?.cancel();
          throw new Error(`HTTP ${res.status}`);
        } else {
          h.status('connected');
          const split = pgnSplitter(),
            dec = new TextDecoder(),
            reader = res.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            for (const pgn of split(dec.decode(value, { stream: true }))) {
              delay = wait = MIN_BACKOFF_MS; // Lichess sends the full snapshot first, so any game = healthy connection
              const u = parseGame(pgn, this.gameId);
              if (!u) continue;
              const key = JSON.stringify(u);
              if (key !== this.last) {
                this.last = key;
                h.game(u);
              } // dedupe re-sends after reconnect
              if (u.status === 'finished') {
                this.stop();
                return;
              } // nothing more to follow
            }
          }
        }
      } catch {
        /* network error / abort → fall through */
      }
      if (signal.aborted) return;
      h.status('reconnecting');
      await (this.opts.sleep ?? sleep)(wait, signal);
      if (wait !== RATE_LIMIT_MS) delay = Math.min(delay * 2, MAX_BACKOFF_MS);
    }
  }
}

export const lichessSource: SourceFactory = (roundId, gameId) => new RoundStream(roundId, gameId);
