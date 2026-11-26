import { describe, expect, it } from 'vitest';
import { material } from '../shared/material.js';
import { START_FEN } from '../shared/viewer.js';

const none = { pieces: [], diff: 0 };

describe('material', () => {
  it('start position: nothing either side', () => {
    expect(material(START_FEN)).toEqual({ white: none, black: none });
  });

  it('White up a knight', () => {
    const fen = 'rnbqkb1r/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    expect(material(fen)).toEqual({ white: { pieces: ['n'], diff: 3 }, black: none });
  });

  it('bishop against knight: pieces shown, no points', () => {
    const fen = 'r1n1k3/8/8/8/8/8/8/R1B1K3 w - - 0 1';
    expect(material(fen)).toEqual({ white: { pieces: ['b'], diff: 0 }, black: { pieces: ['n'], diff: 0 } });
  });

  it('a promoted queen counts as a queen', () => {
    expect(material('4k3/p7/8/8/8/8/8/Q3K3 w - - 0 1')).toEqual({
      white: { pieces: ['q'], diff: 8 },
      black: { pieces: ['p'], diff: 0 },
    });
  });

  it('lists q r b n p in that order, one per extra piece; kings ignored', () => {
    const fen = '4k3/8/8/8/8/8/PP6/QK6 w - - 0 1';
    expect(material(fen).white).toEqual({ pieces: ['q', 'p', 'p'], diff: 11 });
    expect(material(fen).black).toEqual(none);
  });
});
