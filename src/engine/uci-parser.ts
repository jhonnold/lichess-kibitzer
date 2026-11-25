export type UciOptionType = 'check' | 'spin' | 'combo' | 'button' | 'string';

export interface UciOption {
  name: string;
  type: UciOptionType;
  default?: string; // raw string; '<empty>' -> ''
  min?: number;
  max?: number;
  vars?: string[]; // combo only
}

/** Raw UCI score, side-to-move POV. */
export interface UciScore {
  unit: 'cp' | 'mate';
  value: number;
  bound?: 'lower' | 'upper';
}

export interface UciInfo {
  multipv: number; // defaults to 1
  depth?: number;
  seldepth?: number;
  score?: UciScore;
  nodes?: number;
  nps?: number;
  time?: number;
  pv: string[]; // [] if absent
}

export type UciMessage =
  | { type: 'id'; name: string }
  | { type: 'option'; option: UciOption }
  | { type: 'uciok' }
  | { type: 'readyok' }
  | { type: 'info'; info: UciInfo }
  | { type: 'bestmove'; move: string; ponder?: string };

const OPTION_TYPES = new Set<string>(['check', 'spin', 'combo', 'button', 'string']);
const OPTION_KEYS = new Set(['name', 'type', 'default', 'min', 'max', 'var']);
const INFO_INT_KEYS = ['depth', 'seldepth', 'multipv', 'nodes', 'nps', 'time'] as const;
type InfoIntKey = (typeof INFO_INT_KEYS)[number];

export function parseLine(raw: string): UciMessage | null {
  const line = raw.trim();
  const [head, ...rest] = line.split(/\s+/);
  switch (head) {
    case 'id':
      return rest[0] === 'name' ? { type: 'id', name: rest.slice(1).join(' ') } : null;
    case 'uciok':
      return rest.length === 0 ? { type: 'uciok' } : null;
    case 'readyok':
      return rest.length === 0 ? { type: 'readyok' } : null;
    case 'option':
      return parseOption(rest);
    case 'info':
      return parseInfo(rest);
    case 'bestmove':
      return rest[0]
        ? { type: 'bestmove', move: rest[0], ...(rest[1] === 'ponder' && rest[2] ? { ponder: rest[2] } : {}) }
        : null;
    default:
      return null;
  }
}

function parseOption(tokens: string[]): UciMessage | null {
  let key: string | null = null;
  const seg: Record<string, string[]> = {};
  const vars: string[][] = [];
  for (const t of tokens) {
    if (OPTION_KEYS.has(t)) {
      key = t;
      if (t === 'var') vars.push([]);
      else seg[t] = [];
      continue;
    }
    if (key === 'var') vars[vars.length - 1].push(t);
    else if (key) seg[key].push(t);
  }

  const name = seg.name?.join(' ');
  const type = seg.type?.[0];
  if (!name || !type || !OPTION_TYPES.has(type)) return null;

  const option: UciOption = { name, type: type as UciOptionType };
  if (seg.default !== undefined) {
    const d = seg.default.join(' ');
    option.default = d === '<empty>' ? '' : d;
  }
  if (seg.min !== undefined) option.min = Number(seg.min[0]);
  if (seg.max !== undefined) option.max = Number(seg.max[0]);
  if (vars.length) option.vars = vars.map((v) => v.join(' '));
  return { type: 'option', option };
}

function parseInfo(tokens: string[]): UciMessage | null {
  if (tokens[0] === 'string') return null;
  const info: UciInfo = { multipv: 1, pv: [] };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === 'pv') {
      info.pv = tokens.slice(i + 1);
      break;
    }
    if (t === 'score' && (tokens[i + 1] === 'cp' || tokens[i + 1] === 'mate')) {
      const score: UciScore = { unit: tokens[i + 1] as 'cp' | 'mate', value: parseInt(tokens[i + 2], 10) };
      i += 2;
      const bound = tokens[i + 1];
      if (bound === 'lowerbound' || bound === 'upperbound') {
        score.bound = bound === 'lowerbound' ? 'lower' : 'upper';
        i++;
      }
      info.score = score;
      continue;
    }
    if (INFO_INT_KEYS.includes(t as InfoIntKey) && tokens[i + 1] !== undefined) {
      info[t as InfoIntKey] = parseInt(tokens[i + 1], 10);
      i++;
    }
    // Unknown tokens (hashfull, tbhits, currmove, wdl, ...) are skipped one at a time.
  }
  return { type: 'info', info };
}
