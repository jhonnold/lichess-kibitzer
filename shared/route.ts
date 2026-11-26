import { isLichessId } from './archive.js';

/** Parsed location.hash. A later layer adds a viewer `ply`. */
export type Route =
  | { page: 'viewer'; board: number | null }
  | { page: 'admin' }
  | { page: 'round' }
  | { page: 'archive' }
  | { page: 'archive-round'; tourId: string; roundId: string; board: number | null };

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
    const m = /^\/archive\/([^/]+)\/([^/]+)(?:\/board\/([1-9]\d*))?$/.exec(path);
    if (m && isLichessId(m[1]) && isLichessId(m[2])) {
      return {
        route: { page: 'archive-round', tourId: m[1], roundId: m[2], board: m[3] ? Number(m[3]) : null },
        params,
      };
    }
    return { route: { page: 'archive' }, params };
  }
  const n = /^\/board\/([1-9]\d*)$/.exec(path)?.[1];
  return { route: { page: 'viewer', board: n ? Number(n) : null }, params };
}

export const boardHash = (n: number): string => `#/board/${n}`;
export const ROUND_HASH = '#/round';
export const ARCHIVE_HASH = '#/archive';
/** '#/archive/T/R' (overview of that Round) or '#/archive/T/R/board/n' (Viewer). */
export const archiveHash = (tourId: string, roundId: string, board?: number): string =>
  `${ARCHIVE_HASH}/${tourId}/${roundId}${board === undefined ? '' : `/board/${board}`}`;
