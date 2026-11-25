import { describe, expect, it } from 'vitest';
import { changedOptions, initialValues, type UciOption } from '../shared/engine-form.js';

const options: UciOption[] = [
  { name: 'Threads', type: 'spin', default: '1', min: 1, max: 512 },
  { name: 'Hash', type: 'spin', default: '16', min: 1, max: 65536 },
  { name: 'Ponder', type: 'check', default: 'false' },
  { name: 'Style', type: 'combo', default: 'Normal', vars: ['Solid', 'Normal', 'Risky'] },
  { name: 'SyzygyPath', type: 'string', default: '' },
  { name: 'Clear Hash', type: 'button' },
];

describe('initialValues', () => {
  it('overlays the config on the engine defaults; skips buttons and unknown keys', () => {
    expect(initialValues(options, { Threads: '1', Hash: '1024', Unknown: 'x' })).toEqual({
      Threads: '1',
      Hash: '1024',
      Ponder: 'false',
      Style: 'Normal',
      SyzygyPath: '',
    });
  });

  it('uses an empty string when the engine reports no default', () => {
    expect(initialValues([{ name: 'Name', type: 'string' }], {})).toEqual({ Name: '' });
  });
});

describe('changedOptions', () => {
  it('keeps only values that differ from the engine default, never buttons', () => {
    const values = { ...initialValues(options, { Hash: '1024' }), Ponder: 'true', 'Clear Hash': 'x' };
    expect(changedOptions(options, values)).toEqual({ Hash: '1024', Ponder: 'true' });
  });

  it('round-trips: saved config → form → the same config', () => {
    const saved = { Hash: '1024', Style: 'Risky', SyzygyPath: '/tb' };
    expect(changedOptions(options, initialValues(options, saved))).toEqual(saved);
  });
});
