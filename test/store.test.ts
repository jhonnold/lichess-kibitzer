import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataStore } from '../src/store.js';
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
  const state: PersistedState = {
    version: 2,
    settings: { event: null, engine: null, jobTimeMs: 5000, topN: 8 },
    current: { tourId: 'T', roundId: 'R' },
    dead: [{ boardId: 'G', board: 1, ply: 3, at: 7 }],
  };
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

  it('discards a version 1 file and rejects an unknown version', async () => {
    const path = join(dir, 'state.json');
    const s = dataStore(path);
    writeFileSync(path, JSON.stringify(data));
    expect(await s.load()).toBeNull();
    writeFileSync(path, JSON.stringify({ ...state, version: 3 }));
    await expect(s.load()).rejects.toThrow(/not a lichess-kibitzer state file/);
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
