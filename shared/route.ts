/** Parsed location.hash. Later layers add { page: 'archive'; … } and a viewer `ply`. */
export type Route = { page: 'viewer'; board: number | null } | { page: 'admin' } | { page: 'round' };

/** params: the query inside the hash (`#/board/2?chrome=0` → { chrome: '0' }). */
export interface ParsedHash {
  route: Route;
  params: Record<string, string>;
}

/** Anything unrecognised is the Viewer's default Board. */
export function parseHash(hash: string): ParsedHash {
  const [path, ...rest] = hash.replace(/^#/, '').split('?');
  const params = Object.fromEntries(new URLSearchParams(rest.join('?')));
  if (path === '/admin') return { route: { page: 'admin' }, params };
  if (path === '/round') return { route: { page: 'round' }, params };
  const n = /^\/board\/([1-9]\d*)$/.exec(path)?.[1];
  return { route: { page: 'viewer', board: n ? Number(n) : null }, params };
}

export const boardHash = (n: number): string => `#/board/${n}`;
export const ROUND_HASH = '#/round';
