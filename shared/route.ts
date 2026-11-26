import { isLichessId } from './archive.js';

/** Parsed location.hash. `ply` is a deep link to a move (`#/board/3/12`). */
export type Route =
  | { page: 'viewer'; board: number | null; ply: number | null }
  | { page: 'admin' }
  | { page: 'round' }
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
  if (path === '/round') return { route: { page: 'round' }, params };
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
  return { route: { page: 'viewer', board: m ? Number(m[1]) : null, ply: m?.[2] ? Number(m[2]) : null }, params };
}

const plyPart = (ply?: number) => (ply === undefined ? '' : `/${ply}`);
export const boardHash = (n: number, ply?: number): string => `#/board/${n}${plyPart(ply)}`;
export const ROUND_HASH = '#/round';
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
export function navLinks(route: Route, board: string, query: string): NavLink[] {
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
    link('round', 'Round', ROUND_HASH + query, 'o'),
    link('archive', 'Archive', ARCHIVE_HASH),
    link('admin', 'Admin', ADMIN_HASH),
  ];
}
