import { describe, expect, it } from 'vitest';
import { boardHash, parseHash, ROUND_HASH } from '../shared/route.js';

const viewer = (board: number | null) => ({ route: { page: 'viewer', board }, params: {} });

describe('parseHash', () => {
  it.each(['', '#', '#/'])('%j is the Viewer, default Board', (h) => expect(parseHash(h)).toEqual(viewer(null)));

  it('reads the Board number', () => expect(parseHash('#/board/3')).toEqual(viewer(3)));

  it.each(['#/board/0', '#/board/-1', '#/board/x', '#/board/03', '#/board/3/12', '#/foo'])(
    '%j falls back to the default Board',
    (h) => expect(parseHash(h)).toEqual(viewer(null)),
  );

  it('#/admin is the Admin page, with or without a query', () => {
    expect(parseHash('#/admin')).toEqual({ route: { page: 'admin' }, params: {} });
    expect(parseHash('#/admin?x=1')).toEqual({ route: { page: 'admin' }, params: { x: '1' } });
  });

  it('puts the query in params', () => {
    expect(parseHash('#/board/2?chrome=0&x=1')).toEqual({
      route: { page: 'viewer', board: 2 },
      params: { chrome: '0', x: '1' },
    });
  });

  it('#/round is the overview, with or without a query; #/roundx is the default Board', () => {
    expect(parseHash(ROUND_HASH)).toEqual({ route: { page: 'round' }, params: {} });
    expect(parseHash('#/round?chrome=0')).toEqual({ route: { page: 'round' }, params: { chrome: '0' } });
    expect(parseHash('#/roundx')).toEqual(viewer(null));
  });

  it('boardHash', () => expect(boardHash(3)).toBe('#/board/3'));
});
