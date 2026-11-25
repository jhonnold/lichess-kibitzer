import express from 'express';

export const app = express();

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

// Built SPA (vite → build/public). The client router is hash-based, so `/` → index.html is the only page route.
app.use(express.static('build/public'));
