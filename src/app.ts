import express, { type ErrorRequestHandler } from 'express';
import { adminRouter, type AdminDeps } from './routes/admin.js';
import { eventsRouter, type SseOpts } from './routes/events.js';

export interface AppDeps extends AdminDeps {
  sse?: SseOpts;
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.set('trust proxy', 'loopback, uniquelocal'); // Caddy's X-Forwarded-Proto → req.secure → Secure cookie
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });
  app.use(express.json());
  app.use(eventsRouter(deps.state, deps.sse));
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
