import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { storeLastSave, storeWrites } from '../src/metrics.js';
import { dataStore } from '../src/store.js';
import { val } from './helpers/metric.js';
import type { PersistedState, Round } from '../shared/types.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kibitzer-store-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const engine = { path: '/usr/local/bin/berserk', options: { Hash: '1024', Threads: '1' } };
const data = { version: 1, engine, game: null }; // a v1 file

describe('dataStore', () => {
  const event = { tourId: 'T', name: 'Event', link: 'https://lichess.org/broadcast/x/T' };
  const dead = { tourId: 'T', boardId: 'G', board: 1, ply: 3, at: 7 };
  const state: PersistedState = {
    version: 4,
    settings: { engine: null, passesMs: [1000, 10_000, 100_000] }, // what a version 2 or 3 job time becomes
    primary: 'T',
    events: [{ event, topN: 6, current: { tourId: 'T', roundId: 'R' }, dead: [dead] }],
  };
  const v2 = (settings: object, extra: object = {}) => ({
    version: 2,
    settings: { event, engine: null, jobTimeMs: 5000, topN: 6, ...settings },
    current: { tourId: 'T', roundId: 'R' },
    dead: [{ boardId: 'G', board: 1, ply: 3, at: 7 }],
    ...extra,
  });
  const round = (roundId: string): Round => ({
    tourId: 'T',
    roundId,
    name: 'Round 1',
    eventName: 'Event',
    startsAt: null,
    boards: [],
  });

  it('round-trips state at the DATA_FILE path, leaving no tmp file', async () => {
    const s = dataStore(join(dir, 'state.json'));
    expect(await s.load()).toBeNull();
    await s.save(state);
    expect(await s.load()).toEqual(state);
    expect(readdirSync(dir)).toEqual(['state.json']);
  });

  it('counts each file write by store and outcome, coalesced saves once', async () => {
    const writes = async (store: string) => [
      await val(storeWrites, { store, outcome: 'ok' }),
      await val(storeWrites, { store, outcome: 'error' }),
    ];
    const s = dataStore(join(dir, 'state.json'));
    const [ok, err] = await writes('state');
    await s.save(state);
    expect(await writes('state')).toEqual([ok + 1, err]);
    expect(await val(storeLastSave, { store: 'state' })).toBeGreaterThan(0);
    const [rOk] = await writes('round');
    await s.saveRound(round('R'));
    expect((await writes('round'))[0]).toBe(rOk + 1);

    writeFileSync(join(dir, 'file'), ''); // a regular file where the state file's dir should be: mkdir fails
    const bad = dataStore(join(dir, 'file', 'state.json'));
    await expect(bad.save(state)).rejects.toThrow();
    expect(await writes('state')).toEqual([ok + 1, err + 1]);
  });

  it('discards a version 1 file and rejects an unknown version or a malformed v4', async () => {
    const path = join(dir, 'state.json');
    const s = dataStore(path);
    writeFileSync(path, JSON.stringify(data));
    expect(await s.load()).toBeNull();
    for (const bad of [
      { ...state, version: 5 },
      { ...state, settings: { engine: null, passesMs: 3 } },
      { ...state, events: {} },
      { ...state, primary: 3 },
      { ...state, settings: null },
      { ...state, events: [{ ...state.events[0], dead: null }] },
      { ...state, events: [{ topN: 1, current: null, dead: [] }] },
    ]) {
      writeFileSync(path, JSON.stringify(bad));
      await expect(s.load()).rejects.toThrow(/not a lichess-kibitzer state file/);
    }
  });

  it('migrates a version 2 file with an Event: one entry, its Primary, dead gets the tourId', async () => {
    const path = join(dir, 'state.json');
    writeFileSync(path, JSON.stringify(v2({})));
    expect(await dataStore(path).load()).toEqual(state);
  });

  it('migrates an Idle version 2 file to no Events, dropping its topN', async () => {
    const path = join(dir, 'state.json');
    writeFileSync(path, JSON.stringify(v2({ event: null }, { current: null, dead: [] })));
    expect(await dataStore(path).load()).toEqual({
      version: 4,
      settings: { engine: null, passesMs: [1000, 10_000, 100_000] },
      primary: null,
      events: [],
    });
  });

  it('migrates a version 3 job time to the default Passes; an unset one stays unset', async () => {
    const path = join(dir, 'state.json');
    const v3 = (jobTimeMs: number | null) => ({ ...state, version: 3, settings: { engine: null, jobTimeMs } });
    writeFileSync(path, JSON.stringify(v3(15_000)));
    expect(await dataStore(path).load()).toEqual(state);
    writeFileSync(path, JSON.stringify(v3(null)));
    expect((await dataStore(path).load())?.settings).toEqual({ engine: null, passesMs: null });
  });

  it('migrates a pre-copies engine config on load, from version 2 and version 3', async () => {
    const path = join(dir, 'state.json');
    const old = { path: '/e', options: { Threads: '2', Hash: '64', MultiPV: '5' } };
    const migrated = {
      path: '/e',
      options: {},
      main: { threads: 2, hash: 64 },
      multi: { threads: 2, hash: 64, multiPv: 5 },
    };
    writeFileSync(path, JSON.stringify(v2({ engine: old })));
    expect((await dataStore(path).load())?.settings.engine).toEqual(migrated);
    writeFileSync(path, JSON.stringify({ ...state, settings: { ...state.settings, engine: old } }));
    expect((await dataStore(path).load())?.settings.engine).toEqual(migrated);
  });

  it('round-trips a Round under rounds/<tourId>/<roundId>.json without its version', async () => {
    const s = dataStore(join(dir, 'state.json'));
    expect(await s.loadRound('T', 'R')).toBeNull();
    await s.saveRound(round('R'));
    expect(await s.loadRound('T', 'R')).toEqual(round('R'));
    expect(readdirSync(join(dir, 'rounds', 'T'))).toEqual(['R.json']);
  });

  it('coalesces Round saves per file, keeping the latest', async () => {
    const s = dataStore(join(dir, 'state.json'));
    const named = (name: string): Round => ({ ...round('R'), name });
    const stringify = vi.spyOn(JSON, 'stringify');
    await Promise.all([
      s.saveRound(named('a')),
      s.saveRound(named('b')),
      s.saveRound(named('c')),
      s.saveRound(round('S')),
    ]);
    const written = stringify.mock.calls.map(([d]) => (d as Round).name);
    stringify.mockRestore();
    expect(written.filter((n) => n !== 'Round 1')).toEqual(['a', 'c']); // 'b' superseded while 'a' was writing
    expect((await s.loadRound('T', 'R'))?.name).toBe('c');
    expect(await s.loadRound('T', 'S')).toEqual(round('S'));
  });
});

describe('dataStore.listRounds', () => {
  const round = (roundId: string, name = 'Round 1', tracked = true): Round => ({
    tourId: 'ABCDEFGH',
    roundId,
    name,
    eventName: 'Event',
    startsAt: 5,
    boards: [{ tracked }, { tracked: false }] as Round['boards'],
  });
  const file = () => join(dir, 'state.json');

  it('is empty on a fresh dir', async () => {
    expect(await dataStore(file()).listRounds()).toEqual([]);
  });

  it('scans files another store wrote, with Tracked board counts', async () => {
    const w = dataStore(file());
    await w.saveRound(round('abcdefg1'));
    await w.saveRound(round('abcdefg2', 'Round 2'));
    const metas = await dataStore(file()).listRounds();
    expect(metas.map((m) => [m.roundId, m.name, m.boards, m.eventName]).sort()).toEqual([
      ['abcdefg1', 'Round 1', 1, 'Event'],
      ['abcdefg2', 'Round 2', 1, 'Event'],
    ]);
  });

  it('reflects a saveRound after the first listing, without a re-scan', async () => {
    const s = dataStore(file());
    await s.saveRound(round('abcdefg1'));
    expect((await s.listRounds()).map((m) => m.name)).toEqual(['Round 1']);
    await s.saveRound(round('abcdefg1', 'Renamed', false));
    await s.saveRound(round('abcdefg2'));
    expect((await s.listRounds()).map((m) => [m.name, m.boards])).toEqual([
      ['Renamed', 0],
      ['Round 1', 1],
    ]);
  });

  it('skips junk: bad names, tmp files, other dirs, invalid JSON', async () => {
    const s = dataStore(file());
    await s.saveRound(round('abcdefg1'));
    const tour = join(dir, 'rounds', 'ABCDEFGH');
    writeFileSync(join(tour, 'x.json'), '{}');
    writeFileSync(join(tour, 'abcdefg2.json.tmp'), '{}');
    writeFileSync(join(tour, 'ZZZZZZZZ.json'), '{not json');
    mkdirSync(join(dir, 'rounds', 'bad'));
    writeFileSync(join(dir, 'rounds', 'bad', 'abcdefg3.json'), '{}');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const metas = await dataStore(file()).listRounds();
    expect(metas.map((m) => m.roundId)).toEqual(['abcdefg1']);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
