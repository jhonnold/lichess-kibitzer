import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileStore } from '../src/store.js';
import type { Game, Persisted } from '../shared/types.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kibitzer-store-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const engine = { path: '/usr/local/bin/berserk', options: { Hash: '1024', Threads: '1' } };
const data: Persisted = { version: 1, engine, game: null };
const game: Game = {
  tourId: 'T',
  roundId: 'R',
  id: 'G',
  white: { name: 'W' },
  black: { name: 'B' },
  result: '1-0',
  plies: [{ move: null, eval: null }],
};

describe('fileStore', () => {
  it('loads null when the file is missing', async () => {
    expect(await fileStore(join(dir, 'missing', 'state.json')).load()).toBeNull();
  });

  it('round-trips, creating the directory and leaving no tmp file', async () => {
    const sub = join(dir, 'sub');
    const s = fileStore(join(sub, 'state.json'));
    await s.save({ ...data, game });
    expect(await s.load()).toEqual({ ...data, game });
    expect(readdirSync(sub)).toEqual(['state.json']);
  });

  it('coalesces and serialises saves, keeping the latest', async () => {
    const s = fileStore(join(dir, 'state.json'));
    const mk = (path: string): Persisted => ({ ...data, engine: { ...engine, path } });
    await Promise.all([s.save(mk('a')), s.save(mk('b')), s.save(mk('c'))]);
    expect(await s.load()).toEqual(mk('c'));
  });

  it.each([
    ['{', /invalid JSON/],
    ['{"version":2,"engine":null,"game":null}', /not a lichess-kibitzer state file/],
    [JSON.stringify({ version: 1, engine: null, game: { ...game, plies: [] } }), /not a lichess-kibitzer state file/],
  ])('rejects %s', async (text, message) => {
    const path = join(dir, 'bad.json');
    writeFileSync(path, text);
    await expect(fileStore(path).load()).rejects.toThrow(message);
  });

  it('defaults to DATA_FILE from the environment', async () => {
    vi.stubEnv('DATA_FILE', join(dir, 'env.json'));
    await fileStore().save(data);
    expect(existsSync(join(dir, 'env.json'))).toBe(true);
  });
});
