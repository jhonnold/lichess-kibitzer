import { describe, expect, it } from 'vitest';
import {
  archiveHash,
  backHash,
  boardHash,
  homeHash,
  layoutOf,
  navLinks,
  overviewToggle,
  parseHash,
  ROUND_HASH,
  roundHash,
  routeTour,
  tabOf,
} from '../shared/route.js';

const T = 'abcdefgh';

const viewer = (board: number | null, ply: number | null = null) => ({
  route: { page: 'viewer', tourId: null, board, ply },
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
    expect(parseHash('#/board/3/12?chrome=0').route).toEqual({ page: 'viewer', tourId: null, board: 3, ply: 12 });
  });

  it('#/admin is the Admin page, with or without a query', () => {
    expect(parseHash('#/admin')).toEqual({ route: { page: 'admin' }, params: {} });
    expect(parseHash('#/admin?x=1')).toEqual({ route: { page: 'admin' }, params: { x: '1' } });
  });

  it('puts the query in params', () => {
    expect(parseHash('#/board/2?chrome=0&x=1')).toEqual({
      route: { page: 'viewer', tourId: null, board: 2, ply: null },
      params: { chrome: '0', x: '1' },
    });
  });

  it('#/round is the overview, with or without a query; #/roundx is the default Board', () => {
    expect(parseHash(ROUND_HASH)).toEqual({ route: { page: 'round', tourId: null }, params: {} });
    expect(parseHash('#/round?chrome=0')).toEqual({ route: { page: 'round', tourId: null }, params: { chrome: '0' } });
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

  it('#/e/T is that Event, its default Board; /board/n[/ply] and /round too', () => {
    const v = (board: number | null, ply: number | null = null) => ({ page: 'viewer', tourId: T, board, ply });
    expect(parseHash(`#/e/${T}`).route).toEqual(v(null));
    expect(parseHash(`#/e/${T}/board/3`).route).toEqual(v(3));
    expect(parseHash(`#/e/${T}/board/3/0`).route).toEqual(v(3, 0));
    expect(parseHash(`#/e/${T}/board/3/12?chrome=0`)).toEqual({ route: v(3, 12), params: { chrome: '0' } });
    expect(parseHash(`#/e/${T}/round?flip=1`)).toEqual({
      route: { page: 'round', tourId: T },
      params: { flip: '1' },
    });
  });

  it.each([
    '#/e/',
    '#/e/abc',
    '#/e/abcdefghi/round',
    '#/e/../round',
    `#/e/${T}/board/0`,
    `#/e/${T}/roundx`,
    `#/e/${T}/round/1`,
    `#/e/${T}/board/3/012`,
    `#/e/${T}/x`,
  ])('%j falls back to the default Board of the Primary', (h) => expect(parseHash(h)).toEqual(viewer(null)));

  it('boardHash, roundHash and homeHash with an Event; null keeps the old form', () => {
    expect(boardHash(3, undefined, T)).toBe(`#/e/${T}/board/3`);
    expect(boardHash(3, 12, T)).toBe(`#/e/${T}/board/3/12`);
    expect(boardHash(3, 0, T)).toBe(`#/e/${T}/board/3/0`);
    expect(roundHash(null)).toBe(ROUND_HASH);
    expect(roundHash(T)).toBe(`#/e/${T}/round`);
    expect(homeHash(null)).toBe('#/');
    expect(homeHash(T)).toBe(`#/e/${T}`);
  });

  it.each([null, T])('parse(build) round-trips tourId %j (null stays the old form)', (t) => {
    expect(parseHash(boardHash(3, 12, t)).route).toEqual({ page: 'viewer', tourId: t, board: 3, ply: 12 });
    expect(parseHash(boardHash(3, undefined, t)).route).toEqual({ page: 'viewer', tourId: t, board: 3, ply: null });
    expect(parseHash(roundHash(t)).route).toEqual({ page: 'round', tourId: t });
    expect(parseHash(homeHash(t)).route).toEqual({ page: 'viewer', tourId: t, board: null, ply: null });
    expect(boardHash(3, 12, t).includes('/e/')).toBe(t !== null);
  });
});

describe('stream tour and back links', () => {
  const at = (hash: string) => parseHash(hash).route;

  it('routeTour: live routes carry their tourId (null kept), other pages keep the stream', () => {
    expect(routeTour(at('#/board/1'))).toBeNull();
    expect(routeTour(at('#/round'))).toBeNull();
    expect(routeTour(at(`#/e/${T}/board/1`))).toBe(T);
    expect(routeTour(at(`#/e/${T}/round`))).toBe(T);
    expect(routeTour(at('#/admin'))).toBeUndefined();
    expect(routeTour(at('#/archive'))).toBeUndefined();
    expect(routeTour(at('#/archive/abcdefgh/ABCDEFG1/board/2'))).toBeUndefined();
  });

  it('backHash: the last Board of this stream tour, else the Event home', () => {
    expect(backHash({ tour: T, board: 3 }, T)).toBe(`#/e/${T}/board/3`);
    expect(backHash({ tour: null, board: 3 }, null)).toBe('#/board/3');
    expect(backHash({ tour: 'zzzzzzzz', board: 3 }, T)).toBe(`#/e/${T}`);
    expect(backHash({ tour: T, board: 3 }, null)).toBe('#/');
    expect(backHash({ tour: T, board: null }, T)).toBe(`#/e/${T}`);
    expect(backHash(null, null)).toBe('#/');
  });

  it('overviewToggle: viewer -> its Event overview, round -> back, others nothing', () => {
    const back = `#/e/${T}/board/2?q=1`;
    expect(overviewToggle(at(`#/e/${T}/board/2`), back, '?q=1')).toBe(`#/e/${T}/round?q=1`);
    expect(overviewToggle(at('#/board/2'), '#/board/2?q=1', '?q=1')).toBe('#/round?q=1');
    expect(overviewToggle(at(`#/e/${T}/round?q=1`), back, '?q=1')).toBe(back);
    expect(overviewToggle(at('#/admin'), back, '')).toBeNull();
    expect(overviewToggle(at('#/archive'), back, '')).toBeNull();
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

  it('Round link follows the Event; tabs of e-routes', () => {
    const links = navLinks(at(`#/e/${T}/round?flip=1`), `#/e/${T}/board/2?flip=1`, '?flip=1', T);
    expect(links[0].href).toBe(`#/e/${T}/board/2?flip=1`);
    expect(links[1]).toEqual({ tab: 'round', label: 'Round', href: `#/e/${T}/round?flip=1`, key: 'o', current: true });
    expect(tabOf(at(`#/e/${T}/board/2`))).toBe('board');
    expect(tabOf(at(`#/e/${T}/round`))).toBe('round');
  });
});
