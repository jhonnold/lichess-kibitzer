import type { Score } from './accuracy.js';

export type SiteState = 'idle' | 'live' | 'finished';
export type StreamStatus = 'connected' | 'reconnecting';
export type Result = '1-0' | '0-1' | '1/2-1/2' | '*';
/** backfill: `go movetime 100` (never counts for accuracy); final: last eval before `stop` on the next move / game end. */
export type EvalKind = 'backfill' | 'final';

export interface Player {
  name: string;
  title?: string;
  rating?: number;
}

/** Kibitzer settings from the Admin page. Values as sent in `setoption name X value V`; buttons are not stored. */
export interface EngineConfig {
  path: string;
  options: Record<string, string>;
}

/** The Featured game: which Board, and who plays it. */
export interface GameRef {
  tourId: string;
  roundId: string;
  id: string;
  white: Player;
  black: Player;
}

export interface Move {
  san: string;
  uci: string;
  clock: number | null; // ms left for the mover after this move, from [%clk]
}

export interface Eval {
  score: Score; // White POV
  depth: number;
  kind: EvalKind;
  bestmove: string | null; // engine's best move from this position (UCI); for lila's "only judge non-best moves"
}

/** One position. plies[0] = start position (move null); plies[i] = after i moves. eval null = not analysed / terminal. */
export interface Ply {
  move: Move | null;
  eval: Eval | null;
}

export interface Game extends GameRef {
  result: Result;
  plies: Ply[]; // length = moves + 1
}

/** The JSON file at DATA_FILE. */
export interface Persisted {
  version: 1;
  engine: EngineConfig | null; // null = Admin page defaults
  game: Game | null;
}

export interface PvLine {
  score: Score; // White POV
  depth: number;
  san: string[];
}

/** Current search of the Live position. Not persisted. */
export interface LiveInfo {
  ply: number; // index in plies of the position being analysed (lets clients drop stale info)
  engine: string; // UCI id name
  depth: number;
  nps: number | null;
  lines: PvLine[]; // by multipv, best first
}

export interface Snapshot {
  site: SiteState;
  game: Game | null;
  live: LiveInfo | null;
  stream: StreamStatus | null; // null when not Live
}

/** SSE payloads. `snapshot` replaces all client state; `ply` upserts game.plies[index]. */
export type SseEvent =
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'ply'; index: number; ply: Ply }
  | { type: 'info'; live: LiveInfo | null }
  | { type: 'stream-status'; status: StreamStatus };
