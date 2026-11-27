import { Router } from 'express';
import type { SseEvent } from '../../shared/types.js';
import { viewers } from '../metrics.js';
import type { SiteState } from '../site-state.js';

export interface SseOpts {
  throttleMs?: number; // min gap between `search` events per client; default 250 (~4/s)
  heartbeatMs?: number; // comment line that keeps proxies from closing an idle stream; default 25 s
}

/**
 * GET /api/events: one unnamed `data: <SseEvent JSON>` frame per event (clients use `onmessage`).
 * `?tour=<tourId>` binds the client to that Event (an unknown one gets an empty snapshot, and a live stream once it is
 * added); without it the client follows the Primary and is rebound, with one fresh `snapshot`, whenever that changes.
 * A `snapshot` first, then the events of the bound Event and the site-wide ones (`queue`, `events`). A `search` of
 * another Event reaches the client as a single null. `search` is coalesced per client (latest wins); a pending
 * `search` is flushed before any other event, so order is kept and the last `search` (even `null`) is never dropped.
 */
export function eventsRouter(site: SiteState, opts: SseOpts = {}): Router {
  const { throttleMs = 250, heartbeatMs = 25_000 } = opts;
  return Router().get('/api/events', (req, res) => {
    const tour = typeof req.query.tour === 'string' && req.query.tour ? req.query.tour : null;
    const follow = tour === null;
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // no proxy buffering
    });
    res.flushHeaders();
    viewers.inc();
    const send = (e: SseEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    let pending: SseEvent | null = null;
    let timer: NodeJS.Timeout | undefined;
    let last = -Infinity;
    const flush = () => {
      clearTimeout(timer);
      timer = undefined;
      if (!pending) return;
      last = Date.now();
      send(pending);
      pending = null;
    };
    let bound = tour ?? site.primary;
    let searching = false; // the last search queued or sent to this client is not null
    const onEvent = (t: string | null, e: SseEvent) => {
      if (e.type === 'search') {
        if (t !== bound) {
          if (!searching) return;
          e = { type: 'search', search: null };
        }
        searching = e.search !== null;
        pending = e;
        timer ??= setTimeout(flush, Math.max(0, last + throttleMs - Date.now()));
        return;
      }
      if (t !== null && t !== bound) return;
      flush();
      send(e);
    };
    const onPrimary = (p: string | null) => {
      if (!follow || p === bound) return;
      bound = p;
      flush();
      searching = site.search !== null && site.snapshot(p).search !== null;
      send({ type: 'snapshot', snapshot: site.snapshot(p), now: Date.now() });
    };
    const heartbeat = setInterval(() => res.write(': hb\n\n'), heartbeatMs);
    site.on('event', onEvent);
    if (follow) site.on('primary', onPrimary);
    send({ type: 'snapshot', snapshot: site.snapshot(bound), now: Date.now() });
    searching = site.snapshot(bound).search !== null;
    res.on('close', () => {
      viewers.dec();
      site.off('event', onEvent);
      site.off('primary', onPrimary);
      clearInterval(heartbeat);
      clearTimeout(timer);
    });
  });
}
