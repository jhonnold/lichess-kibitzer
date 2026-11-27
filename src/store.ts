import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isLichessId, roundMeta, type RoundMeta } from '../shared/archive.js';
import { migrateEngine } from '../shared/engine-config.js';
import {
  DEFAULT_PASSES_MS,
  type DeadJob,
  type PersistedEvent,
  type PersistedRound,
  type PersistedState,
  type Round,
  type SiteSettings,
} from '../shared/types.js';
import { storeLastSave, storeWrites } from './metrics.js';

export const DEFAULT_DATA_FILE = 'data/state.json';

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;

/** Serialised + coalesced (latest wins) JSON writes to one path; tmp + rename with flush. Each write is counted in
 *  kibitzer_store_writes_total under `store`. */
function jsonWriter(path: string, store: 'state' | 'round'): (data: unknown) => Promise<void> {
  let pending: { data: unknown } | null = null;
  let flushing: Promise<void> | null = null;
  const flush = async () => {
    try {
      while (pending) {
        const text = JSON.stringify(pending.data);
        pending = null;
        try {
          await mkdir(dirname(path), { recursive: true });
          await writeFile(`${path}.tmp`, text, { flush: true });
          await rename(`${path}.tmp`, path);
        } catch (err) {
          storeWrites.inc({ store, outcome: 'error' });
          throw err;
        }
        storeWrites.inc({ store, outcome: 'ok' });
        storeLastSave.setToCurrentTime({ store });
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

/** A version 4 state file, or null when malformed. */
function parseV4(data: Record<string, unknown>): PersistedState | null {
  if (!isObj(data.settings) || (data.settings.passesMs !== null && !Array.isArray(data.settings.passesMs))) return null;
  return parseEvents(data);
}

/** Version 3 settings (a job time) as version 4: a set job time becomes the default Passes, unset stays unset. */
function passesOf(settings: Record<string, unknown>): SiteSettings {
  const { jobTimeMs, ...rest } = settings;
  return { ...(rest as Omit<SiteSettings, 'passesMs'>), passesMs: jobTimeMs === null ? null : [...DEFAULT_PASSES_MS] };
}

/** A version 3 state file as version 4, or null when malformed. */
function parseV3(data: Record<string, unknown>): PersistedState | null {
  const state = parseEvents(data);
  return state && { ...state, version: 4, settings: passesOf(data.settings as Record<string, unknown>) };
}

/** The events and primary of a version 3 or 4 state file (cast as version 4), or null when malformed. */
function parseEvents(data: Record<string, unknown>): PersistedState | null {
  if (!isObj(data.settings) || !Array.isArray(data.events)) return null;
  if (data.primary !== null && typeof data.primary !== 'string') return null;
  if (
    !data.events.every((e) => isObj(e) && isObj(e.event) && typeof e.event.tourId === 'string' && Array.isArray(e.dead))
  ) {
    return null;
  }
  return data as unknown as PersistedState;
}

/** A version 2 state file as version 4, or null when malformed. An Event becomes the one entry and the Primary; Idle
 *  becomes no entries, and its topN is dropped (the in-memory default applies to the next Event). */
function parseV2(data: Record<string, unknown>): PersistedState | null {
  if (!isObj(data.settings) || !Array.isArray(data.dead)) return null;
  const { event, topN, ...site } = data.settings as unknown as Record<string, unknown> &
    Pick<PersistedEvent, 'topN'> & {
      event: PersistedEvent['event'] | null;
    };
  const events: PersistedEvent[] = event
    ? [
        {
          event,
          topN,
          current: (data.current as PersistedEvent['current']) ?? null,
          dead: (data.dead as (Omit<DeadJob, 'tourId'> & { tourId?: string })[]).map((d) => ({
            ...d,
            tourId: d.tourId ?? event.tourId,
          })),
        },
      ]
    : [];
  return { version: 4, settings: passesOf(site), primary: event?.tourId ?? null, events };
}

export interface DataStore {
  load(): Promise<PersistedState | null>; // always version 4 (2 and 3 migrated); null: missing, or version 1 (discarded, logged once)
  save(s: PersistedState): Promise<void>;
  loadRound(tourId: string, roundId: string): Promise<Round | null>; // null: missing
  saveRound(r: Round): Promise<void>; // coalesced per file
  listRounds(): Promise<RoundMeta[]>; // every Round file, the Current Round's too
}

/** state.json at `file`; Round files at `<dirname(file)>/rounds/<tourId>/<roundId>.json`. */
export function dataStore(file = process.env.DATA_FILE || DEFAULT_DATA_FILE): DataStore {
  const writeState = jsonWriter(file, 'state');
  const writers = new Map<string, (data: unknown) => Promise<void>>();
  const roundPath = (tourId: string, roundId: string) => join(dirname(file), 'rounds', tourId, `${roundId}.json`);
  // Round metas by `${tourId}/${roundId}`: `scanned` once from the files on the first listRounds; `saved` (every
  // saveRound this process made) overrides it, so a write still in flight during the scan is not lost.
  let scanned: Promise<Map<string, RoundMeta>> | null = null;
  const saved = new Map<string, RoundMeta>();
  const scan = async () => {
    const metas = new Map<string, RoundMeta>();
    const root = join(dirname(file), 'rounds');
    const tours = await readdir(root, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return [];
      throw e;
    });
    for (const t of tours.filter((d) => d.isDirectory() && isLichessId(d.name))) {
      for (const f of await readdir(join(root, t.name))) {
        const roundId = f.endsWith('.json') ? f.slice(0, -5) : '';
        if (!isLichessId(roundId)) continue;
        try {
          const r = await store.loadRound(t.name, roundId);
          if (r) metas.set(`${t.name}/${roundId}`, roundMeta(r));
        } catch (err) {
          console.warn(`rounds/${t.name}/${f} skipped:`, (err as Error).message);
        }
      }
    }
    return metas;
  };
  const store: DataStore = {
    async load() {
      const data = await readJson(file);
      if (data === null) return null;
      if (isObj(data) && data.version === 1) {
        console.warn(`${file}: version 1 state discarded`);
        return null;
      }
      const parse = isObj(data) ? { 4: parseV4, 3: parseV3, 2: parseV2 }[data.version as number] : undefined;
      const state = parse?.(data as Record<string, unknown>) ?? null;
      if (!state) throw new Error(`${file}: not a lichess-kibitzer state file`);
      const engine = state.settings.engine && migrateEngine(state.settings.engine); // pre-copies configs
      return { ...state, settings: { ...state.settings, engine } };
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
      saved.set(`${r.tourId}/${r.roundId}`, roundMeta(r));
      const path = roundPath(r.tourId, r.roundId);
      let write = writers.get(path);
      if (!write) writers.set(path, (write = jsonWriter(path, 'round')));
      return write({ version: 2, ...r });
    },
    async listRounds() {
      scanned ??= scan().catch((e: unknown) => {
        scanned = null; // retry on the next call
        throw e;
      });
      return [...new Map([...(await scanned), ...saved]).values()];
    },
  };
  return store;
}
