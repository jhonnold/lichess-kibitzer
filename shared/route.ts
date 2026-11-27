import { isLichessId } from './archive.js';

/**
 * Parsed location.hash. `ply` is a deep link to a move (`#/board/3/12`). `tourId` null (no `/e/T`) = the Primary,
 * whichever it is: OBS sources sit on `#/board/n`, `#/round` and `#/`.
 */
export type Route =
  | { page: 'viewer'; tourId: string | null; board: number | null; ply: number | null }
  | { page: 'round'; tourId: string | null }
  | { page: 'events' } // the Events list: never parsed, only from resolveRoute
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

/**
 * The route to render: bare `#/` is the Events list when more than one Event is registered, unless the hash says
 * ?chrome=0 (OBS sources sit on `#/?chrome=0` and stay on the Primary). `list`: the decision latched for this
 * navigation (null = not decided yet: fall back to `events`), so an Event added later does not swap a Viewer for the list.
 */
export function resolveRoute(p: ParsedHash, events: number, list: boolean | null = null): Route {
  const r = p.route;
  const bare = r.page === 'viewer' && r.tourId === null && r.board === null && r.ply === null;
  return bare && (list ?? events > 1) && p.params.chrome !== '0' ? { page: 'events' } : r;
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
/**
 * `back` target (Board tab, `o` from the overview): the last Board if seen under this tour, else the Event's home. The
 * Primary's home is bare `#/`, which is the Events list when several Events are followed: `first` (a Board of the
 * Primary, given only then) makes it a Board link instead.
 */
export const backHash = (last: LastBoard | null, tour: string | null, first: number | null = null): string =>
  last && last.tour === tour && last.board !== null
    ? boardHash(last.board, undefined, tour)
    : tour === null && first !== null
      ? boardHash(first)
      : homeHash(tour);
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

/** The top-level sections: the app bar's tabs (≥700px) and the phone tab bar. */
export type Tab = 'events' | 'board' | 'round' | 'archive' | 'admin';
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

/** Switcher target for Event `tourId`: the round page stays on the round page, anything else goes to its home. */
export const switchHref = (route: Route, tourId: string, query: string): string =>
  (route.page === 'round' ? roundHash(tourId) : homeHash(tourId)) + query;

/**
 * Links to each section. board: the live Viewer hash to go back to (the last Board seen). Events (only when `multi`:
 * more than one Event), Board and Round keep the streaming params (query); Archive and Admin drop them.
 */
export function navLinks(
  route: Route,
  board: string,
  query: string,
  tourId: string | null = null,
  multi = false,
): NavLink[] {
  const at = tabOf(route);
  const link = (tab: Tab, label: string, href: string, key?: string): NavLink => ({
    tab,
    label,
    href,
    ...(key ? { key } : {}),
    current: tab === at,
  });
  return [
    ...(multi ? [link('events', 'Events', homeHash(null) + query)] : []),
    link('board', 'Board', board),
    link('round', 'Round', roundHash(tourId) + query, 'o'),
    link('archive', 'Archive', ARCHIVE_HASH),
    link('admin', 'Admin', ADMIN_HASH),
  ];
}
