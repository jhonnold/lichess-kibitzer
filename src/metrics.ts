import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { EngineConfig } from '../shared/types.js';
import type { Follower } from './follower.js';
import type { RoundState } from './round-state.js';
import type { Scheduler } from './scheduler.js';

/** Own registry (not prom-client's global one), served by GET /api/admin/metrics. */
export const register = new Registry();
collectDefaultMetrics({ register, prefix: 'kibitzer_' });

/** What the scrape-time metrics read. Set by createApp; before that they report nothing. */
export interface MetricSources {
  state: Pick<RoundState, 'queue' | 'dead' | 'settings'>;
  scheduler: Pick<Scheduler, 'engineState' | 'restarts'>;
  follower: Pick<Follower, 'status'>;
  defaultEngine: EngineConfig;
}
let src: MetricSources | null = null;
export function bindMetrics(sources: MetricSources): void {
  src = sources;
}

/** The git sha written to build/rev by `npm run build` (scripts/rev.mjs); else $GIT_REV; else "unknown". */
function buildRev(): string {
  try {
    const rev = readFileSync(new URL('../rev', import.meta.url), 'utf8').trim(); // build/src/metrics.js → build/rev
    if (rev) return rev;
  } catch {
    /* not built (dev, tests) */
  }
  return process.env.GIT_REV || 'unknown';
}
const rev = buildRev();

export const buildInfo = new Gauge({
  name: 'kibitzer_build_info',
  help: 'Always 1. rev = git sha of the build, engine = file name of the configured engine path',
  labelNames: ['rev', 'engine'],
  registers: [register],
  collect() {
    this.reset();
    if (!src) return;
    this.set({ rev, engine: basename((src.state.settings.engine ?? src.defaultEngine).path) }, 1);
  },
});

/** Jobs waiting per tier, read at scrape time (the running Job is not counted). */
export const queueDepth = new Gauge({
  name: 'kibitzer_queue_depth',
  help: 'Jobs waiting in the Queue, by tier',
  labelNames: ['tier'],
  registers: [register],
  collect() {
    this.reset();
    if (!src) return;
    this.set({ tier: 'current' }, src.state.queue.current.length);
    this.set({ tier: 'backfill' }, src.state.queue.backfill);
  },
});
export const deadLetterSize = new Gauge({
  name: 'kibitzer_dead_letter_queue_size',
  help: 'Jobs in the Dead-letter queue',
  registers: [register],
  collect() {
    this.reset();
    if (src) this.set(src.state.dead.length);
  },
});
export const engineUp = new Gauge({
  name: 'kibitzer_engine_up',
  help: '1 while the engine is up, 0 while restarting or without a Round',
  registers: [register],
  collect() {
    this.reset();
    if (src) this.set(src.scheduler.engineState === 'up' ? 1 : 0);
  },
});
export const evictions = new Counter({
  name: 'kibitzer_evictions_total',
  help: 'Running Jobs stopped early, by reason (stale, live, backfill)',
  labelNames: ['reason'],
  registers: [register],
});
/** The Scheduler's restart count is already monotonic for the process, so the counter mirrors it at scrape time. */
export const engineRestarts = new Counter({
  name: 'kibitzer_engine_restarts_total',
  help: 'Engine restarts since the process started',
  registers: [register],
  collect() {
    this.reset();
    if (src) this.inc(src.scheduler.restarts);
  },
});

/** `tier` is the Job's tier, `kind` the recorded Eval's kind (`complete` | `provisional`). */
export const jobDuration = new Histogram({
  name: 'kibitzer_job_duration_seconds',
  help: 'Wall time of Jobs that recorded an Eval',
  labelNames: ['tier', 'kind'],
  // Low buckets: pre-empted Backfill Jobs (Provisional) are short. 14-16: Complete Jobs at the default 15 s job time.
  buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 14, 15, 16, 20, 30, 60],
  registers: [register],
});
export const jobDepth = new Histogram({
  name: 'kibitzer_job_depth',
  help: 'Search depth reached by Jobs that recorded an Eval',
  labelNames: ['tier', 'kind'],
  buckets: [5, 10, 15, 20, 25, 30, 35, 40, 50],
  registers: [register],
});
export const streamReconnects = new Counter({
  name: 'kibitzer_lichess_stream_reconnects_total',
  help: 'Times the Lichess Round stream dropped and was reconnected',
  registers: [register],
});
export const rateLimited = new Counter({
  name: 'kibitzer_lichess_rate_limited_total',
  help: 'HTTP 429 responses from Lichess',
  labelNames: ['source'],
  registers: [register],
});
/** `route` is the matched Express pattern (bounded cardinality: never the raw path). See routeLabel in app.ts. */
export const httpRequests = new Counter({
  name: 'kibitzer_http_requests_total',
  help: 'HTTP requests by route pattern, method and status (GET /api/events counted when its stream closes)',
  labelNames: ['route', 'method', 'status'],
  registers: [register],
});
export const httpDuration = new Histogram({
  name: 'kibitzer_http_request_duration_seconds',
  help: 'HTTP request duration by route pattern, method and status; not observed for GET /api/events (SSE)',
  labelNames: ['route', 'method', 'status'],
  registers: [register],
});
export const viewers = new Gauge({
  name: 'kibitzer_viewers',
  help: 'Open GET /api/events streams (the Admin page counts as a Viewer)',
  registers: [register],
});
export const openingLookups = new Counter({
  name: 'kibitzer_opening_lookups_total',
  help: 'Masters-explorer opening lookups (a lookup paused locally by a rate limit is counted too)',
  registers: [register],
});
