import { describe, expect, it } from 'vitest';
import { copyOptions, engineConfig, migrateEngine } from '../shared/engine-config.js';

describe('migrateEngine', () => {
  it('moves Threads/Hash/MultiPV of a pre-copies config into both copies', () => {
    const old = { path: '/e', options: { Threads: '4', Hash: '512', MultiPV: '3', Style: 'Risky' } };
    expect(migrateEngine(old)).toEqual({
      path: '/e',
      options: { Style: 'Risky' },
      main: { threads: 4, hash: 512 },
      multi: { threads: 4, hash: 512, multiPv: 3 },
    });
  });

  it('falls back to the defaults for missing or unusable values (MultiPV 1 is not a multi copy)', () => {
    expect(migrateEngine({ path: '/e', options: { MultiPV: '1', Hash: 'x' } })).toEqual(engineConfig('/e'));
  });

  it('keeps a current config as is', () => {
    const cfg = engineConfig('/e', { Style: 'Solid' }, 7);
    expect(migrateEngine(cfg)).toBe(cfg);
  });
});

describe('copyOptions', () => {
  const cfg = { ...engineConfig('/e', { Style: 'Solid', MultiPV: '9' }, 4), main: { threads: 8, hash: 2048 } };

  it('main: shared options, then its Threads/Hash, then MultiPV 1 last', () => {
    expect(copyOptions(cfg, 'main')).toEqual([
      ['Style', 'Solid'],
      ['Threads', '8'],
      ['Hash', '2048'],
      ['MultiPV', '1'],
    ]);
  });

  it('multi: its own Threads/Hash and MultiPV N; a stray shared MultiPV is never sent', () => {
    expect(copyOptions(cfg, 'multi')).toEqual([
      ['Style', 'Solid'],
      ['Threads', '1'],
      ['Hash', '1024'],
      ['MultiPV', '4'],
    ]);
  });
});
