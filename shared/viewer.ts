import { Chess, DEFAULT_POSITION } from 'chess.js';
import { winPercent, type Color, type Score } from './accuracy.js';
import type { Board, PvLine, Ply, QueueView, Result, SearchInfo, Snapshot } from './types.js';

/** A board position as the Viewer draws it. lastMove = [from, to] of the move into it. */
export interface Position {
  fen: string;
  turn: Color;
  check: boolean;
  lastMove: string[] | undefined;
}

/** A move as chess.js takes it: SAN ("Nf3") or squares ({ from: 'g1', to: 'f3' }). */
export type ChessMove = string | { from: string; to: string; promotion?: string };

/** Position after playing `moves` from `fen` (throws on an illegal move). PV lines are legal: the server made them. */
export function play(fen: string, moves: ChessMove[]): Position {
  const chess = new Chess(fen);
  let last;
  for (const m of moves) last = chess.move(m);
  return {
    fen: chess.fen(),
    turn: chess.turn() === 'w' ? 'white' : 'black',
    check: chess.inCheck(),
    lastMove: last && [last.from, last.to],
  };
}

export const START_FEN = DEFAULT_POSITION;

/** 'e7e8q' → { from: 'e7', to: 'e8', promotion: 'q' }; 'g1f3' → { from, to } (no promotion key). */
export function uciMove(uci: string): { from: string; to: string; promotion?: string } {
  const m = { from: uci.slice(0, 2), to: uci.slice(2, 4) };
  return uci.length > 4 ? { ...m, promotion: uci[4] } : m;
}

/** Position after plies[1..n] (n = 0: the start). Games start from the start position; throws on an illegal move. */
export function positionAt(plies: readonly Ply[], n: number): Position {
  return play(
    START_FEN,
    plies.slice(1, n + 1).map((p) => uciMove(p.move!.uci)),
  );
}

/** Legal moves by origin square (chessground's movable.dests). */
export function legalDests(fen: string): Map<string, string[]> {
  const dests = new Map<string, string[]>();
  for (const m of new Chess(fen).moves({ verbose: true })) dests.set(m.from, [...(dests.get(m.from) ?? []), m.to]);
  return dests;
}

/**
 * Eval graph data: White win % per ply (null = no eval), the Live search's score standing in for the current
 * position, and which plies hold a Provisional eval (drawn differently).
 */
export function evalSeries(plies: Ply[], live: Score | null): { win: (number | null)[]; provisional: boolean[] } {
  const win = plies.map((p) => (p.eval ? winPercent(p.eval.score) : null));
  if (live) win[win.length - 1] = winPercent(live);
  return { win, provisional: plies.map((p) => p.eval?.kind === 'provisional') };
}

/** White POV: "+0.35", "-1.20", "#3", "#-2". */
export const formatScore = (s: Score): string =>
  'mate' in s ? `#${s.mate}` : `${s.cp > 0 ? '+' : ''}${(s.cp / 100).toFixed(2)}`;

/** What the engine panel shows for one Board. */
export interface PanelInfo {
  ply: number;
  searching: boolean;
  engine: string | null;
  depth: number;
  nps: number | null;
  lines: PvLine[];
}

/**
 * The panel at the Cursor's `ply`: the running search if it is for this ply (empty lines at Job start: an empty
 * panel, not older lines); else that ply's stored eval with lines; else null (no fallback to an earlier ply).
 */
export function panelInfo(board: Board, ply: number, search: SearchInfo | null): PanelInfo | null {
  if (search?.boardId === board.id && search.ply === ply) {
    return { ply, searching: true, engine: search.engine, depth: search.depth, nps: search.nps, lines: search.lines };
  }
  const e = board.plies[ply]?.eval;
  return e?.lines.length ? { ply, searching: false, engine: null, depth: e.depth, nps: null, lines: e.lines } : null;
}

/**
 * Eval bar at the Cursor's `ply`: the search's score there, else its stored eval; else the last eval before it,
 * dimmed; none → no score.
 */
export function barScore(board: Board, ply: number, search: SearchInfo | null): { score: Score | null; dim: boolean } {
  const live = search?.boardId === board.id && search.ply === ply ? search.lines[0]?.score : undefined;
  const own = live ?? board.plies[ply]?.eval?.score;
  if (own) return { score: own, dim: false };
  const before = board.plies.slice(0, ply).findLast((p) => p.eval)?.eval?.score ?? null;
  return { score: before, dim: before !== null };
}

export type BoardState = 'upcoming' | 'live' | 'finished';

export function boardState(b: Board): BoardState {
  if (b.result !== '*') return 'finished';
  return b.plies.length === 1 ? 'upcoming' : 'live';
}

export const formatResult = (r: Result): string => (r === '1/2-1/2' ? '½-½' : r);

/** 'Hoefelsauer, Thomas' → 'Hoefelsauer'; 'Magnus Carlsen' → 'Carlsen'. */
export function shortName(name: string): string {
  const n = name.trim();
  return n.includes(',') ? n.split(',')[0].trim() : (n.split(/\s+/).pop() ?? n);
}

/** The Tracked board with Lichess number n, else the lowest-numbered one; null when none. */
export function selectedBoard(boards: readonly Board[], n: number | null): Board | null {
  return (
    boards.find((b) => b.board === n) ?? boards.reduce<Board | null>((a, b) => (!a || b.board < a.board ? b : a), null)
  );
}

export function ordinal(n: number): string {
  const r = n % 100;
  const suffix = r >= 11 && r <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] || 'th';
  return `${n}${suffix}`;
}

export type JobState = 'queued' | 'searching' | 'done' | 'none';
export interface StatusLine {
  state: JobState;
  text: string;
}

/** Where the Job for `ply` of `board` stands. First match wins; see docs/plans for the reasons for the order. */
export function statusLine(board: Board, ply: number, search: SearchInfo | null, queue: QueueView): StatusLine {
  const latest = board.plies.length - 1;
  const e = board.plies[ply]?.eval ?? null;
  if (e?.kind === 'complete') return { state: 'done', text: `Done · depth ${e.depth}` };
  if (search?.boardId === board.id && search.ply === ply)
    return { state: 'searching', text: search.depth ? `Searching · depth ${search.depth}` : 'Searching' };
  const i = queue.current.findIndex((j) => j.boardId === board.id && j.ply === ply);
  if (i >= 0) return { state: 'queued', text: `Queued · ${ordinal(i + 1)}` };
  if (ply < latest && queue.backfill > 0) return { state: 'queued', text: 'Queued · backfill' };
  if (ply === latest && board.result !== '*' && !e) return { state: 'none', text: 'Game over' };
  if (e) return { state: 'none', text: `Provisional · depth ${e.depth}` };
  return { state: 'none', text: 'Waiting' };
}

/** Time left until startsAt: null when startsAt is null; under a second left → 'starting'; < 1 h → 'm:ss';
 *  < 24 h → 'Hh MMm'; else 'Dd Hh'. Never negative. */
export function countdown(startsAt: number | null, now: number): string | null {
  if (startsAt === null) return null;
  const s = Math.floor((startsAt - now) / 1000);
  if (s <= 0) return 'starting';
  const [m, h, d] = [Math.floor(s / 60), Math.floor(s / 3600), Math.floor(s / 86400)];
  if (h < 1) return `${m}:${String(s % 60).padStart(2, '0')}`;
  if (d < 1) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${d}d ${h % 24}h`;
}

/** Full-page message when no Board can be shown, else null. */
export function viewerMessage(snap: Snapshot): string | null {
  const { event, round } = snap;
  if (!event) return 'Nothing live right now';
  if (!round) return `${event.name} · waiting for the first Round`;
  return round.boards.length ? null : `${event.name} · ${round.name} · no pairings yet`;
}
