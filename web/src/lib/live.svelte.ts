import { applyEvent } from '$shared/live';
import type { Snapshot, SseEvent } from '$shared/types';

const RETRY_MS = 5_000;

/** What the Viewer and overview read: LiveStore (SSE) or ArchiveStore (one fetch). */
export interface SnapSource {
  readonly snap: Snapshot | null;
  readonly connected: boolean;
  /** Server clock minus local clock is -skew: server time = Date.now() - skew. */
  readonly skew: number;
}

/**
 * The site state, fed by GET /api/events. EventSource retries dropped connections itself (the server's first frame
 * is a snapshot, so state heals), but an HTTP error (e.g. a proxy 502 while the server restarts) closes it for good:
 * that case reopens after RETRY_MS.
 */
export class LiveStore implements SnapSource {
  snap = $state.raw<Snapshot | null>(null); // null until the first snapshot
  connected = $state(false);
  skew = $state(0);

  /** Opens the stream; returns the cleanup (for onMount). */
  connect(url = '/api/events'): () => void {
    let es: EventSource;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const open = () => {
      es = new EventSource(url);
      es.onopen = () => (this.connected = true);
      es.onmessage = (m) => {
        const e = JSON.parse(m.data) as SseEvent;
        if (e.type === 'snapshot' && e.now !== undefined) this.skew = Date.now() - e.now;
        this.snap = applyEvent(this.snap, e);
      };
      es.onerror = () => {
        this.connected = false;
        if (es.readyState === EventSource.CLOSED) retry = setTimeout(open, RETRY_MS);
      };
    };
    open();
    return () => {
      clearTimeout(retry);
      es.close();
    };
  }
}
