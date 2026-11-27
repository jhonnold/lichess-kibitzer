import { isLichessId } from './archive.js';

/**
 * Parsed location.hash. `ply` is a deep link to a move (`#/board/3/12`). `tourId` null (no `/e/T`) = the Primary,
 * whichever it is: OBS sources sit on `#/board/n`, `#/round` and `#/`.
 */
export type Route =
  | { page: 'viewer'; tourId: string | null; board: number | null; ply: number | null }
  | { page: 'round'; tourId: string | null }
  | { page: 'admin' }
  | { page: 'archive' }
  | { page: 'archive-round'; tourId: string; roundId: string; board: number | null; ply: number | null };

/** params: the query inside the hash (`#/board/2?chrome=0` → { chrome: '0' }). */
export interface ParsedHash {
  route: Route;
  params: Record<string, string>;
}

/** Anything unrecognised is the Viewer's default Board (under /archive: the Archive list). */
export function parseHash(hash: string): ParsedHash {
  const [path, ...rest] = hash.replace(/^#/, '').split('?');
  const params = Object.fromEntries(new URLSearchParams(rest.join('?')));
  if (path === '/admin') return { route: { page: 'admin' }, params };
  if (path === '/round') return { route: { page: 'round', tourId: null }, params };
  if (path.startsWith('/e/')) {
    const e = /^\/e\/([^/]+)(?:\/(round)|\/board\/([1-9]\d*)(?:\/(0|[1-9]\d*))?)?$/.exec(path);
    if (e && isLichessId(e[1])) {
      const tourId = e[1];
      if (e[2]) return { route: { page: 'round', tourId }, params };
      return {
        route: { page: 'viewer', tourId, board: e[3] ? Number(e[3]) : null, ply: e[4] ? Number(e[4]) : null },
        params,
      };
    }
    return { route: { page: 'viewer', tourId: null, board: null, ply: null }, params };
  }
  if (path === '/archive' || path.startsWith('/archive/')) {
    const m = /^\/archive\/([^/]+)\/([^/]+)(?:\/board\/([1-9]\d*)(?:\/(0|[1-9]\d*))?)?$/.exec(path);
    if (m && isLichessId(m[1]) && isLichessId(m[2])) {
      return {
        route: {
          page: 'archive-round',
          tourId: m[1],
          roundId: m[2],
          board: m[3] ? Number(m[3]) : null,
          ply: m[4] ? Number(m[4]) : null,
        },
        params,
      };
    }
    return { route: { page: 'archive' }, params };
  }
  const m = /^\/board\/([1-9]\d*)(?:\/(0|[1-9]\d*))?$/.exec(path);
  return {
    route: { page: 'viewer', tourId: null, board: m ? Number(m[1]) : null, ply: m?.[2] ? Number(m[2]) : null },
    params,
  };
}

const plyPart = (ply?: number) => (ply === undefined ? '' : `/${ply}`);
const evPart = (t: string | null) => (t === null ? '' : `/e/${t}`);
/** '#/e/T/board/n[/p]'; tourId null = the old form (the Primary). */
export const boardHash = (n: number, ply?: number, tourId: string | null = null): string =>
  `#${evPart(tourId)}/board/${n}${plyPart(ply)}`;
export const roundHash = (tourId: string | null = null): string => `#${evPart(tourId)}/round`;
/** An Event's default Board: '#/e/T' | '#/'. */
export const homeHash = (tourId: string | null): string => (tourId === null ? '#/' : `#/e/${tourId}`);
export const ROUND_HASH = roundHash(null);
/** The stream's Event for an Event-scoped route; undefined = a page not tied to an Event (keep the current stream). */
export const routeTour = (r: Route): string | null | undefined =>
  r.page === 'viewer' || r.page === 'round' ? r.tourId : undefined;
/** Last live Board seen, with the stream tour it was seen under. */
export interface LastBoard {
  tour: string | null;
  board: number | null;
}
/** `back` target (Board tab, `o` from the overview): the last Board if seen under this tour, else the Event's home. */
export const backHash = (last: LastBoard | null, tour: string | null): string =>
  last && last.tour === tour && last.board !== null ? boardHash(last.board, undefined, tour) : homeHash(tour);
/** `o` on a live page: viewer -> the overview; round -> back (it already has the query); else null. */
export function overviewToggle(route: Route, back: string, query: string): string | null {
  if (route.page === 'viewer') return roundHash(route.tourId) + query;
  if (route.page === 'round') return back;
  return null;
}
export const ARCHIVE_HASH = '#/archive';
/** '#/archive/T/R' (overview of that Round) or '#/archive/T/R/board/n[/ply]' (Viewer). */
export const archiveHash = (tourId: string, roundId: string, board?: number, ply?: number): string =>
  `${ARCHIVE_HASH}/${tourId}/${roundId}${board === undefined ? '' : `/board/${board}${plyPart(ply)}`}`;

/** Streaming layout, from the hash query (`#/board/1?chrome=0&bg=transparent`). */
export interface Layout {
  chrome: boolean; // ?chrome=0 hides everything but the board, bars and panel
  panel: boolean; // ?panel=0 hides the side panel
  arrows: boolean | null; // ?arrows=0|1 overrides the stored preference (not written)
  flip: boolean | null; // ?flip=1|0 overrides the stored flip (not written)
  transparent: boolean; // ?bg=transparent
}

export function layoutOf(params: Record<string, string>): Layout {
  const on = (v: string | undefined) => (v === '1' ? true : v === '0' ? false : null);
  return {
    chrome: params.chrome !== '0',
    panel: params.panel !== '0',
    arrows: on(params.arrows),
    flip: on(params.flip),
    transparent: params.bg === 'transparent',
  };
}

/** The four top-level sections: the app bar's tabs (≥700px) and the phone tab bar. */
export type Tab = 'board' | 'round' | 'archive' | 'admin';
export interface NavLink {
  tab: Tab;
  label: string;
  href: string;
  key?: string; // keyboard shortcut shown next to the label
  current: boolean;
}
export const ADMIN_HASH = '#/admin';

/** Which section a route belongs to: an archived Round is in the Archive. */
export function tabOf(route: Route): Tab {
  if (route.page === 'viewer') return 'board';
  if (route.page === 'archive-round') return 'archive';
  return route.page;
}

/**
 * Links to each section. board: the live Viewer hash to go back to (the last Board seen). Board and Round keep the
 * streaming params (query); Archive and Admin drop them.
 */
export function navLinks(route: Route, board: string, query: string, tourId: string | null = null): NavLink[] {
  const at = tabOf(route);
  const link = (tab: Tab, label: string, href: string, key?: string): NavLink => ({
    tab,
    label,
    href,
    ...(key ? { key } : {}),
    current: tab === at,
  });
  return [
    link('board', 'Board', board),
    link('round', 'Round', roundHash(tourId) + query, 'o'),
    link('archive', 'Archive', ARCHIVE_HASH),
    link('admin', 'Admin', ADMIN_HASH),
  ];
}
