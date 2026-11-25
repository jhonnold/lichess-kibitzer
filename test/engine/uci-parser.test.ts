import { describe, expect, it } from 'vitest';
import { parseLine } from '../../src/engine/uci-parser.js';

describe('parseLine', () => {
  it.each<[string, unknown]>([
    ['id name Berserk 13', { type: 'id', name: 'Berserk 13' }],
    ['id author X', null],
    ['uciok', { type: 'uciok' }],
    ['uciok\r', { type: 'uciok' }],
    ['readyok', { type: 'readyok' }],
    ['', null],
    ['garbage', null],
    [
      'option name Threads type spin default 1 min 1 max 1024',
      { type: 'option', option: { name: 'Threads', type: 'spin', default: '1', min: 1, max: 1024 } },
    ],
    [
      'option name Ponder type check default false',
      { type: 'option', option: { name: 'Ponder', type: 'check', default: 'false' } },
    ],
    ['option name Clear Hash type button', { type: 'option', option: { name: 'Clear Hash', type: 'button' } }],
    [
      'option name Debug Log File type string default <empty>',
      { type: 'option', option: { name: 'Debug Log File', type: 'string', default: '' } },
    ],
    [
      'option name Style type combo default Normal var Solid var Normal var Risky',
      {
        type: 'option',
        option: { name: 'Style', type: 'combo', default: 'Normal', vars: ['Solid', 'Normal', 'Risky'] },
      },
    ],
    ['option name Foo type weird', null],
    [
      'info depth 20 seldepth 31 multipv 2 score cp -35 nodes 123456 nps 987654 hashfull 12 tbhits 0 time 125 pv e2e4 e7e5 g1f3',
      {
        type: 'info',
        info: {
          depth: 20,
          seldepth: 31,
          multipv: 2,
          score: { unit: 'cp', value: -35 },
          nodes: 123456,
          nps: 987654,
          time: 125,
          pv: ['e2e4', 'e7e5', 'g1f3'],
        },
      },
    ],
    [
      'info depth 30 score mate -4 nodes 1 pv a1a2',
      { type: 'info', info: { depth: 30, multipv: 1, score: { unit: 'mate', value: -4 }, nodes: 1, pv: ['a1a2'] } },
    ],
    [
      'info depth 12 score cp 50 upperbound pv e2e4',
      { type: 'info', info: { depth: 12, multipv: 1, score: { unit: 'cp', value: 50, bound: 'upper' }, pv: ['e2e4'] } },
    ],
    [
      'info depth 12 score cp 50 lowerbound pv e2e4',
      { type: 'info', info: { depth: 12, multipv: 1, score: { unit: 'cp', value: 50, bound: 'lower' }, pv: ['e2e4'] } },
    ],
    ['info depth 5 currmove e2e4 currmovenumber 1', { type: 'info', info: { depth: 5, multipv: 1, pv: [] } }],
    ['info string anything depth 5', null],
    ['bestmove e2e4 ponder e7e5', { type: 'bestmove', move: 'e2e4', ponder: 'e7e5' }],
    ['bestmove g1f3', { type: 'bestmove', move: 'g1f3' }],
  ])('parses %j', (line, expected) => {
    expect(parseLine(line)).toStrictEqual(expected);
  });
});
