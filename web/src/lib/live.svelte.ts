import { applyEvent } from '$shared/live';
import type { Snapshot, SseEvent } from '$shared/types';

const RETRY_MS = 5_000;

/**
 * The site state, fed by GET /api/events. EventSource retries dropped connections itself (the server's first frame
 * is a snapshot, so state heals), but an HTTP error (e.g. a proxy 502 while the server restarts) closes it for good:
 * that case reopens after RETRY_MS.
 */
export class LiveStore {
  snap = $state.raw<Snapshot | null>(null); // null until the first snapshot
  connected = $state(false);

  /** Opens the stream; returns the cleanup (for onMount). */
  connect(url = '/api/events'): () => void {
    let es: EventSource;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const open = () => {
      es = new EventSource(url);
      es.onopen = () => (this.connected = true);
      es.onmessage = (m) => (this.snap = applyEvent(this.snap, JSON.parse(m.data) as SseEvent));
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
