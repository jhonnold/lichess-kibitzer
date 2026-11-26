import { Chess } from 'chess.js';
import { winPercent, type Color, type Score } from './accuracy.js';
import type { Board, PvLine, Ply, SearchInfo } from './types.js';

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
 * The running search if it is for this Board's latest ply (empty lines at Job start: an empty panel, not older
 * lines); else the latest ply whose eval has lines; else null.
 */
export function panelInfo(board: Board, search: SearchInfo | null): PanelInfo | null {
  const latest = board.plies.length - 1;
  if (search?.boardId === board.id && search.ply === latest) {
    return {
      ply: latest,
      searching: true,
      engine: search.engine,
      depth: search.depth,
      nps: search.nps,
      lines: search.lines,
    };
  }
  const ply = board.plies.findLastIndex((p) => p.eval?.lines.length);
  if (ply < 0) return null;
  const e = board.plies[ply].eval!;
  return { ply, searching: false, engine: null, depth: e.depth, nps: null, lines: e.lines };
}
