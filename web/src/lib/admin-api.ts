import type { UciOption } from '$shared/engine-form';
import { defaultTopN } from '$shared/events';
import { DEFAULT_TOP_N } from '$shared/types';
import type { DeadJob } from '$shared/queue';
import type { AdminEventStatus, AdminStatus as ServerStatus } from '../../../src/routes/admin';

/** The Primary Event's block flattened onto the site fields: the shape Admin.svelte/StatusPanel read until the
 *  Admin page lists every Event. */
export type AdminStatus = Omit<ServerStatus, 'events'> & {
  event: AdminEventStatus['event'] | null;
  topN: number;
  round: AdminEventStatus['round'];
  stream: AdminEventStatus['stream'];
  follow: AdminEventStatus['follow'];
  dead: DeadJob[]; // every Event's, by `at`
  nextTopN: number; // the server's default for an Event added now
};
export type Probe = { name: string; options: UciOption[] };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** JSON call to /api/admin; a non-2xx throws ApiError with the server's `{ error }` text when it sends one. */
export async function adminApi<T = void>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/admin${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(res.status, err?.error ?? (res.status === 401 ? 'Not logged in' : `HTTP ${res.status}`));
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

/** GET /status, with the Primary's block flattened (an Idle follow status and DEFAULT_TOP_N when there is none). */
export async function getStatus(): Promise<AdminStatus> {
  const { events, ...site } = await adminApi<ServerStatus>('GET', '/status');
  const p = events.find((e) => e.primary);
  return {
    ...site,
    event: p?.event ?? null,
    topN: p?.topN ?? DEFAULT_TOP_N,
    round: p?.round ?? null,
    stream: p?.stream ?? null,
    follow: p?.follow ?? { next: null, swapAt: null, polledAt: null, error: null },
    dead: events.flatMap((e) => e.dead).sort((a, b) => a.at - b.at),
    nextTopN: defaultTopN(events.length + 1),
  };
}
