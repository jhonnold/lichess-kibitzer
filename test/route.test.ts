import { describe, expect, it } from 'vitest';
import { archiveHash, boardHash, layoutOf, navLinks, parseHash, ROUND_HASH, tabOf } from '../shared/route.js';

const viewer = (board: number | null, ply: number | null = null) => ({
  route: { page: 'viewer', board, ply },
  params: {},
});

describe('parseHash', () => {
  it.each(['', '#', '#/'])('%j is the Viewer, default Board', (h) => expect(parseHash(h)).toEqual(viewer(null)));

  it('reads the Board number', () => expect(parseHash('#/board/3')).toEqual(viewer(3)));

  it.each([
    '#/board/0',
    '#/board/-1',
    '#/board/x',
    '#/board/03',
    '#/foo',
    '#/3/12',
    '#/board/3/012',
    '#/board/3/-1',
    '#/board/3/1/2',
  ])('%j falls back to the default Board', (h) => expect(parseHash(h)).toEqual(viewer(null)));

  it('reads a ply after the Board, 0 included', () => {
    expect(parseHash('#/board/3/12')).toEqual(viewer(3, 12));
    expect(parseHash('#/board/3/0')).toEqual(viewer(3, 0));
    expect(parseHash('#/board/3/12?chrome=0').route).toEqual({ page: 'viewer', board: 3, ply: 12 });
  });

  it('#/admin is the Admin page, with or without a query', () => {
    expect(parseHash('#/admin')).toEqual({ route: { page: 'admin' }, params: {} });
    expect(parseHash('#/admin?x=1')).toEqual({ route: { page: 'admin' }, params: { x: '1' } });
  });

  it('puts the query in params', () => {
    expect(parseHash('#/board/2?chrome=0&x=1')).toEqual({
      route: { page: 'viewer', board: 2, ply: null },
      params: { chrome: '0', x: '1' },
    });
  });

  it('#/round is the overview, with or without a query; #/roundx is the default Board', () => {
    expect(parseHash(ROUND_HASH)).toEqual({ route: { page: 'round' }, params: {} });
    expect(parseHash('#/round?chrome=0')).toEqual({ route: { page: 'round' }, params: { chrome: '0' } });
    expect(parseHash('#/roundx')).toEqual(viewer(null));
  });

  it('#/archive is the list, with a query; bad ids and shapes fall back to it', () => {
    expect(parseHash('#/archive')).toEqual({ route: { page: 'archive' }, params: {} });
    expect(parseHash('#/archive?x=1')).toEqual({ route: { page: 'archive' }, params: { x: '1' } });
    for (const bad of [
      'abc/ABCDEFG1',
      '../abcdefgh',
      'abcdefghi/ABCDEFG1',
      'abcdefgh/ABCDEFG1/board/0',
      'abcdefgh/ABCDEFG1/x',
      'abcdefgh/ABCDEFG1/board/1/2/3',
      'abcdefgh/ABCDEFG1/board/1/012',
      'abcdefgh/ABCDEFG1/ply/3',
      '',
    ])
      expect(parseHash(`#/archive/${bad}`).route).toEqual({ page: 'archive' });
  });

  it('#/archive/T/R is that Round overview, /board/n its Viewer', () => {
    expect(parseHash('#/archive/abcdefgh/ABCDEFG1').route).toEqual({
      page: 'archive-round',
      tourId: 'abcdefgh',
      roundId: 'ABCDEFG1',
      board: null,
      ply: null,
    });
    expect(parseHash('#/archive/abcdefgh/ABCDEFG1/board/3?x=1')).toEqual({
      route: { page: 'archive-round', tourId: 'abcdefgh', roundId: 'ABCDEFG1', board: 3, ply: null },
      params: { x: '1' },
    });
  });

  it('archive Viewer with a ply', () => {
    expect(parseHash('#/archive/abcdefgh/ABCDEFG1/board/2/3').route).toEqual({
      page: 'archive-round',
      tourId: 'abcdefgh',
      roundId: 'ABCDEFG1',
      board: 2,
      ply: 3,
    });
  });

  it('archiveHash, with and without a Board', () => {
    expect(archiveHash('abcdefgh', 'ABCDEFG1')).toBe('#/archive/abcdefgh/ABCDEFG1');
    expect(archiveHash('abcdefgh', 'ABCDEFG1', 2)).toBe('#/archive/abcdefgh/ABCDEFG1/board/2');
    expect(archiveHash('abcdefgh', 'ABCDEFG1', 3, 12)).toBe('#/archive/abcdefgh/ABCDEFG1/board/3/12');
  });

  it('boardHash, with and without a ply', () => {
    expect(boardHash(3)).toBe('#/board/3');
    expect(boardHash(3, 12)).toBe('#/board/3/12');
    expect(boardHash(3, 0)).toBe('#/board/3/0');
  });
});

describe('layoutOf', () => {
  const defaults = { chrome: true, panel: true, arrows: null, flip: null, transparent: false };

  it('defaults', () => expect(layoutOf({})).toEqual(defaults));

  it.each([
    [{ chrome: '0' }, { chrome: false }],
    [{ panel: '0' }, { panel: false }],
    [{ arrows: '0' }, { arrows: false }],
    [{ arrows: '1' }, { arrows: true }],
    [{ flip: '1' }, { flip: true }],
    [{ flip: '0' }, { flip: false }],
    [{ bg: 'transparent' }, { transparent: true }],
  ])('%j', (params, change) => expect(layoutOf(params)).toEqual({ ...defaults, ...change }));

  it('other values are the defaults', () =>
    expect(layoutOf({ chrome: '1', panel: 'x', arrows: 'x', flip: '2', bg: 'red' })).toEqual(defaults));
});

describe('navLinks', () => {
  const at = (hash: string) => parseHash(hash).route;

  it('puts each route in its section; an archived Round is in the Archive', () => {
    expect(
      ['#/', '#/board/3/12', '#/round', '#/archive', '#/archive/abcdefgh/ABCDEFGH/board/2', '#/admin'].map((h) =>
        tabOf(at(h)),
      ),
    ).toEqual(['board', 'board', 'round', 'archive', 'archive', 'admin']);
  });

  it('marks the current section and keeps the streaming params on Board and Round only', () => {
    const links = navLinks(at('#/round?flip=1'), '#/board/2?flip=1', '?flip=1');
    expect(links).toEqual([
      { tab: 'board', label: 'Board', href: '#/board/2?flip=1', current: false },
      { tab: 'round', label: 'Round', href: '#/round?flip=1', key: 'o', current: true },
      { tab: 'archive', label: 'Archive', href: '#/archive', current: false },
      { tab: 'admin', label: 'Admin', href: '#/admin', current: false },
    ]);
  });
});
