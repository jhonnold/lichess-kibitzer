import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Persisted } from '../shared/types.js';

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
