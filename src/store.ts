import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PersistedRound, PersistedState, Round } from '../shared/types.js';

export const DEFAULT_DATA_FILE = 'data/state.json';

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;

/** Serialised + coalesced (latest wins) JSON writes to one path; tmp + rename with flush. */
function jsonWriter(path: string): (data: unknown) => Promise<void> {
  let pending: { data: unknown } | null = null;
  let flushing: Promise<void> | null = null;
  const flush = async () => {
    try {
      while (pending) {
        const text = JSON.stringify(pending.data);
        pending = null;
        await mkdir(dirname(path), { recursive: true });
        await writeFile(`${path}.tmp`, text, { flush: true });
        await rename(`${path}.tmp`, path);
      }
    } finally {
      flushing = null;
    }
  };
  return (data) => {
    pending = { data };
    return (flushing ??= flush());
  };
}

/** Parsed JSON at `path`; null when the file doesn't exist. */
async function readJson(path: string): Promise<unknown | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${path}: invalid JSON`);
  }
}

export interface DataStore {
  load(): Promise<PersistedState | null>; // null: missing, or version 1 (discarded, logged once)
  save(s: PersistedState): Promise<void>;
  loadRound(tourId: string, roundId: string): Promise<Round | null>; // null: missing
  saveRound(r: Round): Promise<void>; // coalesced per file
}

/** state.json at `file`; Round files at `<dirname(file)>/rounds/<tourId>/<roundId>.json`. */
export function dataStore(file = process.env.DATA_FILE || DEFAULT_DATA_FILE): DataStore {
  const writeState = jsonWriter(file);
  const writers = new Map<string, (data: unknown) => Promise<void>>();
  const roundPath = (tourId: string, roundId: string) => join(dirname(file), 'rounds', tourId, `${roundId}.json`);
  return {
    async load() {
      const data = await readJson(file);
      if (data === null) return null;
      if (isObj(data) && data.version === 1) {
        console.warn(`${file}: version 1 state discarded`);
        return null;
      }
      if (!isObj(data) || data.version !== 2 || !isObj(data.settings) || !Array.isArray(data.dead)) {
        throw new Error(`${file}: not a lichess-kibitzer state file`);
      }
      return data as unknown as PersistedState;
    },
    save: writeState,
    async loadRound(tourId, roundId) {
      const path = roundPath(tourId, roundId);
      const data = await readJson(path);
      if (data === null) return null;
      if (!isObj(data) || data.version !== 2 || !Array.isArray(data.boards)) {
        throw new Error(`${path}: not a lichess-kibitzer round file`);
      }
      const round = { ...(data as unknown as PersistedRound) } as Partial<PersistedRound>;
      delete round.version;
      return round as Round;
    },
    saveRound(r) {
      const path = roundPath(r.tourId, r.roundId);
      let write = writers.get(path);
      if (!write) writers.set(path, (write = jsonWriter(path)));
      return write({ version: 2, ...r });
    },
  };
}
