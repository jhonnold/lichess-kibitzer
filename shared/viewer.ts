import { Chess, DEFAULT_POSITION } from 'chess.js';
import { winPercent, type Color, type Score } from './accuracy.js';
import { multiOf } from './analysis.js';
import { outcomeOf } from './archive.js';
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
    const lines = search.multi?.lines.length ? search.multi.lines : search.lines;
    return { ply, searching: true, engine: search.engine, depth: search.depth, nps: search.nps, lines };
  }
  const e = board.plies[ply]?.eval;
  const lines = (e && multiOf(e)?.lines.length ? multiOf(e)!.lines : e?.lines) ?? [];
  return e && lines.length ? { ply, searching: false, engine: null, depth: e.depth, nps: null, lines } : null;
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

/** How a Board ended up in the Archive: its result, 'unfinished' (moves but no result) or 'not played'. */
export function archivedResult(b: Board): string {
  const o = outcomeOf(b);
  return o === 'finished' ? formatResult(b.result) : o === 'unfinished' ? 'unfinished' : 'not played';
}

/** 'Hoefelsauer, Thomas' → 'Hoefelsauer'; 'Magnus Carlsen' → 'Carlsen'; 'Gukesh D' → 'Gukesh' (initials skipped). */
export function shortName(name: string): string {
  const n = name.trim();
  if (n.includes(',')) return n.split(',')[0].trim();
  const words = n.split(/\s+/);
  return words.findLast((w) => !/^\p{L}\.?$/u.test(w)) ?? words.at(-1) ?? n;
}

/** The game's page on Lichess (303 to the slugged URL). */
export const lichessUrl = (roundId: string, gameId: string): string =>
  `https://lichess.org/broadcast/-/-/${roundId}/${gameId}`;

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
  if (search?.boardId === board.id && search.ply === ply) {
    const what = search.tier === 'backfill' ? 'Backfill' : 'Searching';
    return { state: 'searching', text: search.depth ? `${what} · depth ${search.depth}` : what };
  }
  const i = queue.current.findIndex((j) => j.boardId === board.id && j.ply === ply);
  if (i >= 0) return { state: 'queued', text: `Queued · ${ordinal(i + 1)}` };
  if (queue.deferred.some((j) => j.boardId === board.id && j.ply === ply))
    return {
      state: 'queued',
      text: e ? `Provisional · depth ${e.depth} · full search queued` : 'Queued · full search',
    };
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

/** Clock after each side's latest move (plies[i] for odd i is White's move). */
export function clockOf(plies: readonly Ply[], color: Color): number | null {
  for (let i = plies.length - 1; i > 0; i--) if ((i % 2 === 1) === (color === 'white')) return plies[i].move!.clock;
  return null;
}

/** Side to move after the latest ply: plies.length odd (an even number of moves) → 'white'. */
export const turnOf = (plies: readonly Ply[]): Color => (plies.length % 2 === 1 ? 'white' : 'black');

/**
 * Clock of `color`. Static = clockOf(plies, color) ?? b.clocks[color]. When `ticking`, `color` is to move, it has
 * a clock from its own earlier move and the latest ply has an arrival time: that clock minus the time since, never
 * below 0. `now` is server time (Date.now() − skew).
 */
export function tickingClock(
  b: Pick<Board, 'plies' | 'clocks'>,
  color: Color,
  ticking: boolean,
  now: number,
): number | null {
  const own = clockOf(b.plies, color);
  const at = b.plies.at(-1)?.at ?? null;
  if (!ticking || color !== turnOf(b.plies) || own === null || at === null) return own ?? b.clocks[color];
  return Math.max(0, own - Math.max(0, now - at));
}
