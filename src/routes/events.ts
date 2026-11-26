import { Router } from 'express';
import type { SseEvent } from '../../shared/types-v2.js';
import type { RoundState } from '../round-state.js';

export interface SseOpts {
  throttleMs?: number; // min gap between `search` events per client; default 250 (~4/s)
  heartbeatMs?: number; // comment line that keeps proxies from closing an idle stream; default 25 s
}

/**
 * GET /api/events: one unnamed `data: <SseEvent JSON>` frame per event (clients use `onmessage`).
 * A `snapshot` first, then every RoundState event. `search` is coalesced per client (latest wins); a pending
 * `search` is flushed before any other event, so order is kept and the last `search` (even `null`) is never dropped.
 */
export function eventsRouter(state: RoundState, opts: SseOpts = {}): Router {
  const { throttleMs = 250, heartbeatMs = 25_000 } = opts;
  return Router().get('/api/events', (_req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // no proxy buffering
    });
    res.flushHeaders();
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
    const onEvent = (e: SseEvent) => {
      if (e.type !== 'search') return (flush(), send(e));
      pending = e;
      timer ??= setTimeout(flush, Math.max(0, last + throttleMs - Date.now()));
    };
    const heartbeat = setInterval(() => res.write(': hb\n\n'), heartbeatMs);
    state.on('event', onEvent);
    send({ type: 'snapshot', snapshot: state.snapshot() });
    res.on('close', () => {
      state.off('event', onEvent);
      clearInterval(heartbeat);
      clearTimeout(timer);
    });
  });
}
