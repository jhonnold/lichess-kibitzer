import express, { type ErrorRequestHandler, type Request, type RequestHandler } from 'express';
import { bindMetrics, httpDuration, httpRequests } from './metrics.js';
import { archiveRouter, type ArchiveDeps } from './routes/archive.js';
import { adminRouter, type AdminDeps } from './routes/admin.js';
import { eventsRouter, type SseOpts } from './routes/events.js';

export interface AppDeps extends AdminDeps {
  store: ArchiveDeps['store'];
  sse?: SseOpts;
}

/** The matched route pattern (`/api/archive/:tourId/:roundId`). Without one: `<static>` for a served SPA file, the
 *  router's mount + `/*` for a response from router middleware (the admin cookie check's 401), else `<unmatched>`. */
function routeLabel(req: Request, status: number): string {
  const path: unknown = req.route?.path;
  if (typeof path === 'string') return req.baseUrl + path;
  if (status < 400) return '<static>';
  return req.baseUrl ? `${req.baseUrl}/*` : '<unmatched>';
}

/** Counts every request once, when its response closes (an aborted SSE stream never emits `finish`). */
const httpMetrics: RequestHandler = (req, res, next) => {
  const end = httpDuration.startTimer();
  res.once('close', () => {
    const labels = { route: routeLabel(req, res.statusCode), method: req.method, status: String(res.statusCode) };
    httpRequests.inc(labels);
    if (labels.route !== '/api/events') end(labels); // an SSE stream lasts as long as the Viewer stays
  });
  next();
};

export function createApp(deps: AppDeps): express.Express {
  bindMetrics({
    state: deps.state,
    scheduler: deps.scheduler,
    follower: deps.follower,
    defaultEngine: deps.defaultEngine,
  });
  const app = express();
  app.set('trust proxy', 'loopback, uniquelocal'); // Caddy's X-Forwarded-Proto → req.secure → Secure cookie
  app.use(httpMetrics);
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });
  app.use(express.json());
  app.use(eventsRouter(deps.state, deps.sse));
  app.use(archiveRouter({ store: deps.store, state: deps.state }));
  app.use('/api/admin', adminRouter(deps));
  // Built SPA (vite → build/public). The client router is hash-based, so `/` → index.html is the only page route.
  app.use(express.static('build/public'));
  // Body-parser and other framework errors: JSON without a stack trace.
  // Express needs all four arguments to treat this as an error handler; _next is intentionally unused.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const onError: ErrorRequestHandler = (err: { status?: number }, _req, res, _next) => {
    res.status(err.status ?? 500).json({ error: 'bad request' });
  };
  app.use(onError);
  return app;
}
