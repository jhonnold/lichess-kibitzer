import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Persisted } from '../shared/types.js';
import type { PersistedRound, PersistedState, Round } from '../shared/types-v2.js';

export const DEFAULT_DATA_FILE = 'data/state.json';

export interface Store {
  load(): Promise<Persisted | null>; // null when the file doesn't exist
  save(data: Persisted): Promise<void>;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;

/** Shape check only: enough to refuse a foreign/old file, not a full schema. */
function isPersisted(x: unknown): x is Persisted {
  if (!isObj(x) || x.version !== 1) return false;
  const { engine, game } = x;
  const engineOk = engine === null || (isObj(engine) && typeof engine.path === 'string' && isObj(engine.options));
  const gameOk =
    game === null ||
    (isObj(game) &&
      typeof game.id === 'string' &&
      typeof game.roundId === 'string' &&
      typeof game.result === 'string' &&
      Array.isArray(game.plies) &&
      game.plies.length > 0);
  return engineOk && gameOk;
}

/** JSON file store. Saves are serialised and coalesced (latest wins); each write is tmp + rename. */
export function fileStore(path = process.env.DATA_FILE || DEFAULT_DATA_FILE): Store {
  let pending: Persisted | null = null;
  let flushing: Promise<void> | null = null;
  const flush = async () => {
    try {
      while (pending) {
        const text = JSON.stringify(pending);
        pending = null;
        await mkdir(dirname(path), { recursive: true });
        await writeFile(`${path}.tmp`, text, { flush: true }); // fsync: a power cut can't leave an empty file
        await rename(`${path}.tmp`, path);
      }
    } finally {
      flushing = null;
    }
  };
  return {
    async load() {
      let text: string;
      try {
        text = await readFile(path, 'utf8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw e;
      }
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`${path}: invalid JSON`);
      }
      if (!isPersisted(data)) throw new Error(`${path}: not a lichess-kibitzer state file`);
      return data;
    },
    save(data) {
      pending = data;
      return (flushing ??= flush());
    },
  };
}

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
