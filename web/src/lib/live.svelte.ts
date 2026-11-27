import { applyEvent, eventsUrl } from '$shared/live';
import type { EventSummary, Snapshot, SseEvent } from '$shared/types';

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
  /** The Event `snap` belongs to (null = the Primary); undefined before the first connect. */
  tour = $state<string | null | undefined>(undefined);
  /** Every registered Event: site-wide, so it survives an Event switch (connect() keeps it). */
  events = $state.raw<EventSummary[]>([]);

  /**
   * Opens the stream of an Event (null = the Primary) and drops the previous Event's state; returns the cleanup.
   * A frame from a closed stream is ignored, so a late one from the old Event never lands.
   */
  connect(tour: string | null = null): () => void {
    this.tour = tour;
    this.snap = null;
    this.connected = false;
    this.skew = 0;
    const url = eventsUrl(tour);
    let es: EventSource;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const open = () => {
      const current = (es = new EventSource(url));
      es.onopen = () => {
        if (!closed && es === current) this.connected = true;
      };
      es.onmessage = (m) => {
        if (closed || es !== current) return;
        const e = JSON.parse(m.data) as SseEvent;
        if (e.type === 'snapshot' && e.now !== undefined) this.skew = Date.now() - e.now;
        this.snap = applyEvent(this.snap, e);
        if (e.type === 'snapshot') this.events = e.snapshot.events;
        else if (e.type === 'events') this.events = e.events;
      };
      es.onerror = () => {
        if (closed || es !== current) return;
        this.connected = false;
        if (es.readyState === EventSource.CLOSED) retry = setTimeout(open, RETRY_MS);
      };
    };
    open();
    return () => {
      closed = true;
      clearTimeout(retry);
      es.close();
    };
  }
}
