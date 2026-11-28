import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { EngineConfig, EngineRole } from '../shared/types.js';
import type { Site } from './site.js';
import type { SiteState } from './site-state.js';
import type { Scheduler } from './scheduler.js';

/** Own registry (not prom-client's global one), served by GET /api/admin/metrics. */
export const register = new Registry();
collectDefaultMetrics({ register, prefix: 'kibitzer_' });

/** What the scrape-time metrics read. Set by createApp; before that they report nothing. */
export interface MetricSources {
  state: Pick<SiteState, 'settings' | 'queue' | 'events' | 'deep'>;
  scheduler: Pick<Scheduler, 'copyState' | 'copyRestarts' | 'passCounts'>;
  site: Pick<Site, 'status'>;
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

const ROLES: readonly EngineRole[] = ['main', 'multi'];

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
/** Jobs waiting per Pass (deepening Jobs included), read at scrape time. */
export const queuePassDepth = new Gauge({
  name: 'kibitzer_queue_pass_depth',
  help: 'Jobs waiting in the Queue, by pass (0, 1, 2)',
  labelNames: ['pass'],
  registers: [register],
  collect() {
    this.reset();
    if (!src) return;
    const n = src.scheduler.passCounts;
    for (let pass = 0; pass < 3; pass++) this.set({ pass: String(pass) }, n[pass] ?? 0);
  },
});
export const deadLetterSize = new Gauge({
  name: 'kibitzer_dead_letter_queue_size',
  help: 'Jobs in the Dead-letter queue',
  registers: [register],
  collect() {
    this.reset();
    if (src) this.set(src.state.events.reduce((n, rs) => n + rs.dead.length, 0));
  },
});
/** Plies still to search over every deep analysis request (each one's `left`), read at scrape time. */
export const deepPliesLeft = new Gauge({
  name: 'kibitzer_deep_plies_left',
  help: 'Plies still to search at the deep Pass, over every deep analysis request',
  registers: [register],
  collect() {
    this.reset();
    if (src) this.set(src.state.deep.reduce((n, d) => n + d.left.length, 0));
  },
});
/** `role`: the engine copy, main (MultiPV 1) or multi (MultiPV N). */
export const engineUp = new Gauge({
  name: 'kibitzer_engine_up',
  help: '1 while the engine copy is up, 0 while restarting or idle (no Round, no deep request), by role (main, multi)',
  labelNames: ['role'],
  registers: [register],
  collect() {
    this.reset();
    if (src) for (const role of ROLES) this.set({ role }, src.scheduler.copyState(role) === 'up' ? 1 : 0);
  },
});
/** `idle`: no engine wanted (no Round and no deep request, or stopped). Every state is exported, the current one as 1. */
export const engineState = new Gauge({
  name: 'kibitzer_engine_state',
  help: '1 for the engine copy state: up, restarting, or idle (no Round, no deep request), by role (main, multi)',
  labelNames: ['role', 'state'],
  registers: [register],
  collect() {
    this.reset();
    if (!src) return;
    for (const role of ROLES) {
      const now = src.scheduler.copyState(role) ?? 'idle';
      for (const state of ['up', 'restarting', 'idle']) this.set({ role, state }, state === now ? 1 : 0);
    }
  },
});
/** One outcome per Job run: recorded (an Eval, evicted Provisional ones included), empty (no scored line), discarded
 *  (an interrupted deepening Job no deeper than the eval it would replace; a deep Job evicted, or its eval refused as
 *  stale), dropped (a deep Job: also no longer wanted, or given up after its last crash), interrupted (engine restart;
 *  a deep Job: also halted and requeued), crashed (requeued) or dead_lettered (its last crash; never a deep Job).
 *  `pass`: the Job's Pass (0, 1, 2); deep Jobs are tier backfill, pass 2. */
export const jobs = new Counter({
  name: 'kibitzer_jobs_total',
  help: 'Jobs run, by tier, pass and outcome (recorded, empty, discarded, dropped, interrupted, crashed, dead_lettered)',
  labelNames: ['tier', 'pass', 'outcome'],
  registers: [register],
});
export const evictions = new Counter({
  name: 'kibitzer_evictions_total',
  help: 'Running Jobs stopped early, by reason (stale, live, backfill, upgrade)',
  labelNames: ['reason'],
  registers: [register],
});
/** The Scheduler's restart count is already monotonic for the process, so the counter mirrors it at scrape time. */
export const engineRestarts = new Counter({
  name: 'kibitzer_engine_restarts_total',
  help: 'Engine copy restarts since the process started, by role (main, multi)',
  labelNames: ['role'],
  registers: [register],
  collect() {
    this.reset();
    if (src) for (const role of ROLES) this.inc({ role }, src.scheduler.copyRestarts(role));
  },
});

/** `tier` and `pass` are the Job's, `kind` whether it ran its full time (`complete`) or was stopped (`provisional`). */
export const jobDuration = new Histogram({
  name: 'kibitzer_job_duration_seconds',
  help: 'Wall time of Jobs that recorded an Eval',
  labelNames: ['tier', 'pass', 'kind'],
  // Around the default Passes (1, 10, 100 s); low buckets: pre-empted Jobs are short.
  buckets: [0.1, 0.25, 0.5, 0.9, 1.1, 2, 5, 9, 11, 20, 30, 60, 90, 110, 300],
  registers: [register],
});
export const jobDepth = new Histogram({
  name: 'kibitzer_job_depth',
  help: 'Search depth reached by Jobs that recorded an Eval, by engine copy (role: main, multi)',
  labelNames: ['tier', 'pass', 'kind', 'role'],
  buckets: [5, 10, 15, 20, 25, 30, 35, 40, 50],
  registers: [register],
});
export const jobNps = new Histogram({
  name: 'kibitzer_job_nps',
  help: 'Engine nodes per second at the end of Jobs that recorded an Eval, by engine copy (role: main, multi)',
  labelNames: ['tier', 'pass', 'kind', 'role'],
  // Berserk benches ~1.95M nps on one thread (docs/jobtime.md).
  buckets: [1e5, 2.5e5, 5e5, 1e6, 1.5e6, 2e6, 2.5e6, 3e6, 4e6, 6e6],
  registers: [register],
});
export const streamReconnects = new Counter({
  name: 'kibitzer_lichess_stream_reconnects_total',
  help: 'Times the Lichess Round stream ended and was reopened, by reason (eof, http_error, rate_limited, network)',
  labelNames: ['reason'],
  registers: [register],
});
export const streamConnected = new Gauge({
  name: 'kibitzer_lichess_stream_connected',
  help: 'Open Lichess Round streams that are receiving (one per Event)',
  registers: [register],
});
/** Every Lichess API call (src/lichess/api.ts get); `paused` = refused locally during the 60 s pause after a 429. */
export const lichessRequests = new Counter({
  name: 'kibitzer_lichess_requests_total',
  help: 'Lichess API requests by endpoint (event, round, pgn, explorer) and outcome',
  labelNames: ['endpoint', 'outcome'],
  registers: [register],
});
export const lichessDuration = new Histogram({
  name: 'kibitzer_lichess_request_duration_seconds',
  help: 'Duration of Lichess API requests that got a response, by endpoint',
  labelNames: ['endpoint'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [register],
});
/** Deprecated: kibitzer_lichess_requests_total{outcome="rate_limited"} and reconnects{reason="rate_limited"}. */
export const rateLimited = new Counter({
  name: 'kibitzer_lichess_rate_limited_total',
  help: 'Deprecated (use kibitzer_lichess_requests_total): HTTP 429 responses from Lichess',
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
export const followerPolls = new Counter({
  name: 'kibitzer_follower_polls_total',
  help: 'Event polls by Event (tourId) and outcome (error: the Event fetch or the Round swap failed)',
  labelNames: ['event', 'outcome'],
  registers: [register],
});
export const followerLastSuccess = new Gauge({
  name: 'kibitzer_follower_last_success_timestamp_seconds',
  help: 'When each Event (tourId) was last fetched (even if the Round swap after it failed); no sample before the first fetch',
  labelNames: ['event'],
  registers: [register],
  collect() {
    this.reset();
    if (!src) return;
    for (const rs of src.state.events) {
      const at = src.site.status(rs.event.tourId)?.polledAt;
      if (at != null) this.set({ event: rs.event.tourId }, at / 1000);
    }
  },
});
export const following = new Gauge({
  name: 'kibitzer_following',
  help: 'Events registered',
  registers: [register],
  collect() {
    this.reset();
    if (src) this.set(src.state.events.length);
  },
});
/** One per file write, not per save request: writes are coalesced (src/store.ts jsonWriter). */
export const storeWrites = new Counter({
  name: 'kibitzer_store_writes_total',
  help: 'State and Round file writes, by store (state, round) and outcome (ok, error)',
  labelNames: ['store', 'outcome'],
  registers: [register],
});
export const storeLastSave = new Gauge({
  name: 'kibitzer_store_last_save_timestamp_seconds',
  help: 'When a file of the store (state, round) was last written',
  labelNames: ['store'],
  registers: [register],
});
export const archiveReads = new Counter({
  name: 'kibitzer_archive_reads_total',
  help: 'Archive list and Round reads, by outcome (ok, error; a missing Round file is ok)',
  labelNames: ['outcome'],
  registers: [register],
});
export const viewers = new Gauge({
  name: 'kibitzer_viewers',
  help: 'Open GET /api/events streams (the Admin page counts as a Viewer)',
  registers: [register],
});
/** Deprecated: kibitzer_lichess_requests_total{endpoint="explorer"}. */
export const openingLookups = new Counter({
  name: 'kibitzer_opening_lookups_total',
  help: 'Deprecated (use kibitzer_lichess_requests_total): Masters-explorer opening lookups, paused ones included',
  registers: [register],
});
