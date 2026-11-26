import type { UciOption } from '$shared/engine-form';

export type { AdminStatus } from '../../../src/routes/admin';
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
