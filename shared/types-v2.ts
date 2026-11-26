import type { Score } from './accuracy.js';
import type { DeadJob } from './queue.js';
import type { EngineConfig, Move, Player, Result, StreamStatus } from './types.js';
export type { DeadJob, EngineConfig, Move, Player, Result, Score, StreamStatus };

/** complete: ran its full job time (or ended early on a forced mate); provisional: the Job was interrupted. */
export type EvalKind = 'complete' | 'provisional';

/** One MultiPV line. White POV. `move` = UCI of san[0] (arrows: from = move.slice(0, 2), to = slice(2, 4)). */
export interface PvLine {
  score: Score;
  depth: number;
  move: string;
  san: string[];
}

/** score White POV (= lines[0].score); bestmove UCI; lines by multipv, best first, may be empty. */
export interface Eval {
  score: Score;
  depth: number;
  kind: EvalKind;
  bestmove: string | null;
  lines: PvLine[];
}

/** plies[0] = start position (move null, at null). at = arrival ms epoch; null = start or already played when first seen. */
export interface Ply {
  move: Move | null;
  at: number | null;
  eval: Eval | null;
}

export interface Board {
  id: string; // Lichess game id
  board: number; // 1-based, Lichess order (fetchRound boards[] index + 1)
  white: Player;
  black: Player;
  result: Result;
  tracked: boolean;
  opening: string | null;
  clocks: { white: number | null; black: number | null }; // ms, from fetchRound at startRound
  plies: Ply[]; // recorded for every Board of the Round, tracked or not
}

/** startsAt ms epoch; boards in Lichess order. eventName copied in so a Round file alone re-shows the Round. */
export interface Round {
  tourId: string;
  roundId: string;
  name: string;
  eventName: string;
  startsAt: number | null;
  boards: Board[];
}

/** The registered Event. */
export interface RegisteredEvent {
  tourId: string;
  name: string;
  link: string;
}

export interface Settings {
  event: RegisteredEvent | null; // null = Idle
  engine: EngineConfig | null; // null = Admin page defaults
  jobTimeMs: number | null; // null = unset: Queue idles
  topN: number; // default Tracked boards for the next Round
}

export const DEFAULT_TOP_N = 8;

/** Running Job's output so far. Transient. */
export interface SearchInfo {
  boardId: string;
  ply: number;
  engine: string;
  depth: number;
  nps: number | null;
  lines: PvLine[];
  startedAt: number; // ms epoch
}

/** Queue as Viewers need it: current-tier Jobs in run order (position = index + 1), backfill count. Transient. */
export interface QueueView {
  current: { boardId: string; ply: number }[];
  backfill: number;
}

/** Round in a Snapshot carries only Tracked boards. */
export interface Snapshot {
  event: RegisteredEvent | null;
  round: Round | null;
  search: SearchInfo | null;
  queue: QueueView;
  stream: StreamStatus | null;
}

/** Per-board events carry boardId and are sent only for Tracked boards. */
export type SseEvent =
  | { type: 'snapshot'; snapshot: Snapshot } // event change, startRound
  | { type: 'board'; board: Board } // upsert one Tracked board (newly tracked, or retract)
  | { type: 'untrack'; boardId: string }
  | { type: 'ply'; boardId: string; index: number; ply: Ply } // append (index = plies.length) or eval upsert
  | { type: 'result'; boardId: string; result: Result }
  | { type: 'search'; search: SearchInfo | null }
  | { type: 'queue'; queue: QueueView }
  | { type: 'stream-status'; status: StreamStatus | null };

/** data/state.json */
export interface PersistedState {
  version: 2;
  settings: Settings;
  current: { tourId: string; roundId: string } | null; // Current Round's file
  dead: DeadJob[]; // Dead-letter queue (of the Current Round)
}

/** data/rounds/<tourId>/<roundId>.json. The Archive = every such file except the Current Round's. */
export type PersistedRound = Round & { version: 2 };
