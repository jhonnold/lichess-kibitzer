import type { Score } from './accuracy.js';
import type { DeadJob, Tier } from './queue.js';
export type { DeadJob, Score, Tier };

export type StreamStatus = 'connected' | 'reconnecting';
export type Result = '1-0' | '0-1' | '1/2-1/2' | '*';

export interface Player {
  name: string;
  title?: string;
  rating?: number;
}

/** The two copies of the Kibitzer's binary: main (MultiPV 1, its line is the best move for accuracy and marks) and
 *  multi (MultiPV N, more Lines for Viewers). */
export type EngineRole = 'main' | 'multi';

/** One copy's own UCI options (Threads, Hash). */
export interface EngineCopy {
  threads: number;
  hash: number; // MB
}

/** Kibitzer settings from the Admin page. options: shared by both copies, as sent in `setoption name X value V`, never
 *  Threads/Hash/MultiPV (each copy sets those); buttons are not stored. */
export interface EngineConfig {
  path: string;
  options: Record<string, string>;
  main: EngineCopy;
  multi: EngineCopy & { multiPv: number };
}

export interface Move {
  san: string;
  uci: string;
  clock: number | null; // ms left for the mover after this move, from [%clk]
}

/** complete: ran its full job time (or ended early on a forced mate); provisional: the Job was interrupted. */
export type EvalKind = 'complete' | 'provisional';

/** One MultiPV line. White POV. `move` = UCI of san[0] (arrows: from = move.slice(0, 2), to = slice(2, 4)). */
export interface PvLine {
  score: Score;
  depth: number;
  move: string;
  san: string[];
}

/** The multi copy's Lines of a position: by multipv, best first; depth = lines[0].depth. */
export interface MultiLines {
  depth: number;
  lines: PvLine[];
}

/** The main copy's search: score White POV (= lines[0].score); bestmove UCI; lines = its line (MultiPV 1), may be
 *  empty. multi: the multi copy's Lines of the same Job; null = it gave none (down, crashed). Absent in evals recorded
 *  before the second copy, whose `lines` held every MultiPV line: read the Lines with multiOf. */
export interface Eval {
  score: Score;
  depth: number;
  kind: EvalKind;
  bestmove: string | null;
  lines: PvLine[];
  multi?: MultiLines | null;
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
/** Job time of a fresh state file (existing state keeps its value). Chosen in docs/jobtime.md. */
export const DEFAULT_JOB_TIME_MS = 15_000;

/** Running Job's output so far: the main copy's (depth, nps, lines) and the multi copy's (null: not searching). Transient. */
export interface SearchInfo {
  boardId: string;
  ply: number;
  engine: string;
  depth: number;
  nps: number | null;
  lines: PvLine[];
  multi: (MultiLines & { nps: number | null }) | null;
  startedAt: number; // ms epoch
  tier: Tier; // of the running Job
}

/** Queue as Viewers need it: current-tier Jobs in run order (position = index + 1), backfill count, and the latest
 *  plies waiting in backfill for a full search after an eviction. Transient. */
export interface QueueView {
  current: { boardId: string; ply: number }[];
  backfill: number;
  deferred: { boardId: string; ply: number }[];
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
  | { type: 'snapshot'; snapshot: Snapshot; now?: number } // event change, startRound; now = server ms, first frame only
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
