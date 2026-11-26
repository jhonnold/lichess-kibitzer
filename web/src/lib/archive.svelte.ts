import { archiveSnapshot, type ArchiveEvent } from '$shared/archive';
import type { Round, Snapshot } from '$shared/types';
import type { SnapSource } from './live.svelte';

/** One archived Round, fetched once per Round change. */
export class ArchiveStore implements SnapSource {
  snap = $state.raw<Snapshot | null>(null);
  readonly skew = 0;
  readonly connected = true; // "Loading…" while snap is null, never a reconnect banner
  error = $state<string | null>(null);
  #key = '';
  #failed = false; // plain field: reading it inside the route effect must not make the effect re-run

  /** No-op for the loaded or loading ids (a failed load is retried: the Round may have been archived since); else snap = null, fetch, then the Snapshot or `error`. A reply for older ids is dropped. */
  load(tourId: string, roundId: string): void {
    const key = `${tourId}/${roundId}`;
    if (key === this.#key && !this.#failed) return;
    this.#key = key;
    this.#failed = false;
    this.snap = null;
    this.error = null;
    fetch(`/api/archive/${key}`)
      .then(async (res) => {
        if (res.status === 404) return 'This Round is not in the Archive';
        if (!res.ok) throw new Error(String(res.status));
        return archiveSnapshot((await res.json()) as Round);
      })
      .catch(() => 'Could not load the Round')
      .then((r) => {
        if (this.#key !== key) return;
        if (typeof r === 'string') {
          this.#failed = true;
          this.error = r;
        } else this.snap = r;
      });
  }
}

export async function fetchArchive(): Promise<ArchiveEvent[]> {
  const res = await fetch('/api/archive');
  if (!res.ok) throw new Error(`Archive request failed (${res.status})`);
  return (await res.json()) as ArchiveEvent[];
}
