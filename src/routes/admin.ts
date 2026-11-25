import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import type { EngineConfig, GameRef } from '../../shared/types.js';
import { probeEngine } from '../engine/engine.js';
import type { UciOption } from '../engine/uci-parser.js';
import type { Kibitzer } from '../kibitzer.js';
import { fetchEvent, fetchRound, LichessError, type EventInfo, type RoundInfo } from '../lichess/api.js';
import type { State } from '../state.js';

export const COOKIE = 'kibitzer_admin';
const MAX_AGE_MS = 7 * 24 * 3600_000;

export interface AdminDeps {
  state: State;
  kibitzer: Pick<Kibitzer, 'pick' | 'clear' | 'engine'>;
  defaultEngine: EngineConfig; // shown (and used) while no config is saved
  adminPassword?: string; // unset or empty: every login is refused
  probe?: (path: string) => Promise<{ name: string; options: UciOption[] }>; // default probeEngine
  lichess?: { fetchEvent(link: string): Promise<EventInfo>; fetchRound(roundId: string): Promise<RoundInfo> };
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;
const h = (s: string) => createHash('sha256').update(s).digest();
const same = (a: string, b: string) => timingSafeEqual(h(a), h(b));
/** Admin text that goes onto a UCI command line: a CR/LF would inject a second command. */
const oneLine = (s: unknown): s is string => typeof s === 'string' && !/[\r\n]/.test(s);
/** Lichess errors keep their HTTP status (429, 404); anything else is the Admin's input (bad link, not UCI). */
const fail = (res: Response) => (err: unknown) =>
  res
    .status(err instanceof LichessError ? err.status : 400)
    .json({ error: String((err as Error | undefined)?.message ?? err) });

/** /api/admin/*: login sets an HMAC-signed `<expiry>.<sig>` cookie; every other route needs it. */
export function adminRouter(deps: AdminDeps): Router {
  const {
    state,
    kibitzer,
    defaultEngine,
    adminPassword,
    probe = probeEngine,
    lichess = { fetchEvent, fetchRound },
  } = deps;
  const secret = randomBytes(32); // per process: a restart logs Admins out
  const sign = (exp: string) => createHmac('sha256', secret).update(exp).digest('base64url');
  const r = Router();

  r.post('/login', (req, res) => {
    const pw: unknown = req.body?.password;
    if (!adminPassword || typeof pw !== 'string' || !same(pw, adminPassword)) return void res.sendStatus(401);
    const exp = String(Date.now() + MAX_AGE_MS);
    res.cookie(COOKIE, `${exp}.${sign(exp)}`, {
      httpOnly: true,
      sameSite: 'strict',
      secure: req.secure,
      maxAge: MAX_AGE_MS,
    });
    res.sendStatus(204);
  });

  r.use((req: Request, res: Response, next: NextFunction) => {
    const v = req.headers.cookie?.split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
    const [exp = '', sig = ''] = v?.slice(COOKIE.length + 1).split('.') ?? [];
    if (Number(exp) > Date.now() && same(sig, sign(exp))) return next();
    res.sendStatus(401);
  });

  r.get('/event', (req, res) => {
    lichess.fetchEvent(String(req.query.link ?? '')).then((e) => res.json(e), fail(res));
  });
  r.get('/rounds/:roundId', (req, res) => {
    lichess.fetchRound(req.params.roundId).then((round) => res.json(round), fail(res));
  });
  r.post('/engine/probe', (req, res) => {
    probe(String(req.body?.path ?? '')).then((p) => res.json(p), fail(res));
  });
  /** A `button` option (e.g. Clear Hash) for the running engine; queued, so it is sent between searches. */
  r.post('/engine/button', (req, res) => {
    const name: unknown = req.body?.name;
    if (!oneLine(name) || !name) return void res.status(400).json({ error: 'expected { name }' });
    if (!kibitzer.engine) return void res.status(409).json({ error: 'no engine running' });
    kibitzer.engine.setOption(name);
    res.sendStatus(204);
  });
  r.put('/config', (req, res) => {
    const { path, options } = req.body ?? {};
    const ok =
      typeof path === 'string' &&
      path &&
      isObj(options) &&
      Object.entries(options).every(([k, v]) => k && oneLine(k) && oneLine(v));
    if (!ok) return void res.status(400).json({ error: 'expected { path, options: { name: value } }' });
    state.setEngine({ path, options: options as Record<string, string> }); // applied on the next pick
    res.sendStatus(204);
  });
  r.post('/pick', (req, res) => {
    const ref = req.body as GameRef;
    if (typeof ref?.roundId !== 'string' || typeof ref.id !== 'string')
      return void res.status(400).json({ error: 'expected a GameRef' });
    kibitzer.pick(ref).then(() => res.sendStatus(204), fail(res));
  });
  r.post('/clear', (_req, res) => {
    kibitzer.clear().then(() => res.sendStatus(204), fail(res));
  });
  r.get('/status', (_req, res) => {
    const g = state.game;
    res.json({
      site: state.site,
      stream: state.snapshot().stream,
      engine: state.engine ?? defaultEngine,
      engineRunning: kibitzer.engine !== null,
      game: g && { tourId: g.tourId, roundId: g.roundId, id: g.id, white: g.white, black: g.black, result: g.result },
    });
  });
  return r;
}
