import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import type {
  EngineConfig,
  EngineRole,
  Player,
  QueueView,
  RegisteredEvent,
  Result,
  StreamStatus,
} from '../../shared/types.js';
import type { DeadJob, EvictedJob, Job } from '../../shared/queue.js';
import type { JobTiming } from '../../shared/timing.js';
import { COPY_OPTIONS, MAX_MULTI_PV } from '../../shared/engine-config.js';
import { probeEngine } from '../engine/engine.js';
import type { UciOption } from '../engine/uci-parser.js';
import { IDLE, type FollowStatus } from '../follower.js';
import type { Site } from '../site.js';
import { LichessError } from '../lichess/api.js';
import { register } from '../metrics.js';
import type { SiteState } from '../site-state.js';
import type { EngineState, Scheduler } from '../scheduler.js';

export const COOKIE = 'kibitzer_admin';
const MAX_AGE_MS = 7 * 24 * 3600_000;
const MAX_JOB_MS = 3600_000; // keeps `go movetime` a plain integer

export interface AdminDeps {
  state: SiteState;
  scheduler: Pick<
    Scheduler,
    | 'engine'
    | 'running'
    | 'setJobTime'
    | 'setTracked'
    | 'setEngine'
    | 'requeueDead'
    | 'discardDead'
    | 'engines'
    | 'copyState'
    | 'copyRestarts'
    | 'timing'
    | 'evictions'
  >;
  site: Pick<Site, 'add' | 'remove' | 'status' | 'setPrimary'>;
  defaultEngine: EngineConfig; // shown (and used) while no config is saved
  adminPassword?: string; // unset or empty: every login is refused
  probe?: (path: string) => Promise<{ name: string; options: UciOption[] }>; // default probeEngine
}

/** One followed Event: its own settings, Current Round, stream, Dead-letter queue and follow status. */
export interface AdminEventStatus {
  event: RegisteredEvent;
  primary: boolean;
  topN: number;
  round: {
    tourId: string;
    roundId: string;
    name: string;
    boards: { id: string; board: number; white: Player; black: Player; result: Result; tracked: boolean }[];
  } | null;
  stream: StreamStatus | null;
  dead: readonly DeadJob[];
  follow: FollowStatus;
}

/** The site fields stay flat; `events` has one block per Event, in registration order. */
export interface AdminStatus {
  engine: EngineConfig; // saved, else the default
  engineRunning: boolean; // the main copy
  copies: Record<EngineRole, { state: EngineState; restarts: number }>;
  timing: JobTiming;
  jobTimeMs: number | null;
  running: Job | null; // carries its tourId
  queue: QueueView;
  evictions: EvictedJob[]; // newest first
  tracked: number; // Tracked boards of every Event's Current Round
  primary: string | null;
  events: AdminEventStatus[];
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;
const intIn = (x: unknown, min: number, max: number) =>
  Number.isInteger(x) && (x as number) >= min && (x as number) <= max;
const isCopy = (c: unknown) => isObj(c) && intIn(c.threads, 1, 1024) && intIn(c.hash, 1, 1 << 24);
const h = (s: string) => createHash('sha256').update(s).digest();
const same = (a: string, b: string) => timingSafeEqual(h(a), h(b));
/** Admin text that goes onto a UCI command line: a CR/LF would inject a second command. */
const oneLine = (s: unknown): s is string => typeof s === 'string' && !/[\r\n]/.test(s);
/** Lichess errors keep their HTTP status (429, 404); anything else is the Admin's input (bad link, not UCI). */
const fail = (res: Response) => (err: unknown) =>
  res
    .status(err instanceof LichessError ? err.status : 400)
    .json({ error: String((err as Error | undefined)?.message ?? err) });

/** `Authorization: Basic base64(admin:<ADMIN_PASSWORD>)`; an unset or empty password never matches. */
function basicOk(header: string | undefined, password: string | undefined): boolean {
  if (!password || !header?.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString();
  const i = decoded.indexOf(':'); // the first one: the password may contain ':'
  return i >= 0 && same(decoded.slice(0, i), 'admin') && same(decoded.slice(i + 1), password);
}

/** /api/admin/*: login sets an HMAC-signed `<expiry>.<sig>` cookie; every other route needs it. */
export function adminRouter(deps: AdminDeps): Router {
  const { state, scheduler, site, defaultEngine, adminPassword, probe = probeEngine } = deps;
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

  /** Prometheus scrape: basic auth, not the cookie, so it is mounted before the cookie check. */
  r.get('/metrics', (req, res) => {
    if (!basicOk(req.headers.authorization, adminPassword))
      return void res.set('WWW-Authenticate', 'Basic realm="kibitzer"').sendStatus(401);
    register.metrics().then(
      (body) => res.set({ 'Content-Type': register.contentType, 'Cache-Control': 'no-store' }).end(body),
      (err: unknown) => {
        console.error('metrics:', err);
        res.sendStatus(500);
      },
    );
  });

  r.use((req: Request, res: Response, next: NextFunction) => {
    const v = req.headers.cookie?.split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
    const [exp = '', sig = ''] = v?.slice(COOKIE.length + 1).split('.') ?? [];
    if (Number(exp) > Date.now() && same(sig, sign(exp))) return next();
    res.sendStatus(401);
  });

  r.post('/engine/probe', (req, res) => {
    probe(String(req.body?.path ?? '')).then((p) => res.json(p), fail(res));
  });
  /** A `button` option (e.g. Clear Hash) for every running copy; queued, so it is sent between searches. */
  r.post('/engine/button', (req, res) => {
    const name: unknown = req.body?.name;
    if (!oneLine(name) || !name) return void res.status(400).json({ error: 'expected { name }' });
    if (!scheduler.engines.length) return void res.status(409).json({ error: 'no engine running' });
    for (const e of scheduler.engines) e.setOption(name);
    res.sendStatus(204);
  });
  r.put('/config', (req, res) => {
    const { path, options, main, multi } = req.body ?? {};
    const ok =
      typeof path === 'string' &&
      path &&
      isObj(options) &&
      Object.entries(options).every(([k, v]) => k && oneLine(k) && oneLine(v) && !COPY_OPTIONS.includes(k)) &&
      isCopy(main) &&
      isCopy(multi) &&
      intIn(multi.multiPv, 2, MAX_MULTI_PV);
    if (!ok)
      return void res.status(400).json({
        error:
          'expected { path, options: { name: value } (no Threads/Hash/MultiPV), main: { threads, hash }, ' +
          `multi: { threads, hash, multiPv: 2-${MAX_MULTI_PV} } }`,
      });
    const copy = (c: { threads: number; hash: number }) => ({ threads: c.threads, hash: c.hash });
    scheduler
      .setEngine({
        path,
        options: options as Record<string, string>,
        main: copy(main),
        multi: { ...copy(multi), multiPv: multi.multiPv },
      })
      .then(() => res.sendStatus(204), fail(res));
  });
  /** Add an Event (several are followed at once): from then on its Follower picks its Current Round. */
  r.post('/event', (req, res) => {
    const { link, topN }: { link?: unknown; topN?: unknown } = req.body ?? {};
    if (typeof link !== 'string' || !link || (topN !== undefined && !intIn(topN, 1, 64)))
      return void res.status(400).json({ error: 'expected { link: string, topN?: integer 1-64 }' });
    site.add(link, topN as number | undefined).then(() => res.sendStatus(204), fail(res));
  });
  r.delete('/event/:tourId', (req, res) => {
    site.remove(req.params.tourId).then((ok) => (ok ? res.sendStatus(204) : res.sendStatus(404)), fail(res));
  });
  /** That Event's next Round default; the Scheduler has no topN. */
  r.put('/event/:tourId/topn', (req, res) => {
    const rs = state.event(req.params.tourId);
    if (!rs) return void res.status(404).json({ error: 'unknown Event' });
    const n: unknown = req.body?.n;
    if (!intIn(n, 1, 64)) return void res.status(400).json({ error: 'expected { n: integer 1-64 }' });
    rs.setTopN(n as number);
    res.sendStatus(204);
  });
  r.put('/primary', (req, res) => {
    const tourId: unknown = req.body?.tourId;
    if (typeof tourId !== 'string') return void res.status(400).json({ error: 'expected { tourId: string }' });
    res.sendStatus(site.setPrimary(tourId) ? 204 : 404);
  });
  r.put('/jobtime', (req, res) => {
    const ms: unknown = req.body?.ms;
    if (ms !== null && (!Number.isInteger(ms) || (ms as number) <= 0 || (ms as number) > MAX_JOB_MS))
      return void res.status(400).json({ error: `expected { ms: integer 1-${MAX_JOB_MS} | null }` });
    scheduler.setJobTime(ms as number | null).then(() => res.sendStatus(204), fail(res));
  });
  r.put('/event/:tourId/tracked', (req, res) => {
    const { tourId } = req.params;
    const rs = state.event(tourId);
    if (!rs) return void res.status(404).json({ error: 'unknown Event' });
    const ids: unknown = req.body?.boardIds;
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string'))
      return void res.status(400).json({ error: 'expected { boardIds: string[] }' });
    const round = rs.round;
    if (!round) return void res.status(409).json({ error: 'no Current Round' });
    const known = new Set(round.boards.map((b) => b.id));
    if (!ids.every((id) => known.has(id)))
      return void res.status(400).json({ error: 'not a Board of the Current Round' });
    scheduler.setTracked(tourId, ids as string[]).then(() => res.sendStatus(204), fail(res));
  });
  for (const [path, method] of [
    ['requeue', 'requeueDead'],
    ['discard', 'discardDead'],
  ] as const) {
    r.post(`/dead/${path}`, (req, res) => {
      const { boardId, ply }: { boardId?: unknown; ply?: unknown } = req.body ?? {};
      if (typeof boardId !== 'string' || !Number.isInteger(ply) || (ply as number) < 0)
        return void res.status(400).json({ error: 'expected { boardId: string, ply: integer >= 0 }' });
      scheduler[method](boardId, ply as number).then(
        (ok) => (ok ? res.sendStatus(204) : res.status(404).json({ error: 'not in the Dead-letter queue' })),
        fail(res),
      );
    });
  }
  r.get('/status', (_req, res) => {
    const primary = state.primary;
    const events = state.events.map((rs): AdminEventStatus => {
      const round = rs.round;
      return {
        event: rs.event,
        primary: rs.event.tourId === primary,
        topN: rs.topN,
        round: round && {
          tourId: round.tourId,
          roundId: round.roundId,
          name: round.name,
          boards: round.boards.map(({ id, board, white, black, result, tracked }) => ({
            id,
            board,
            white,
            black,
            result,
            tracked,
          })),
        },
        stream: rs.stream,
        dead: rs.dead,
        follow: site.status(rs.event.tourId) ?? IDLE,
      };
    });
    const body: AdminStatus = {
      engine: state.settings.engine ?? defaultEngine,
      engineRunning: scheduler.engine !== null,
      copies: {
        main: { state: scheduler.copyState('main'), restarts: scheduler.copyRestarts('main') },
        multi: { state: scheduler.copyState('multi'), restarts: scheduler.copyRestarts('multi') },
      },
      timing: scheduler.timing,
      jobTimeMs: state.settings.jobTimeMs,
      running: scheduler.running,
      queue: state.queue,
      evictions: scheduler.evictions,
      tracked: events.reduce((n, e) => n + (e.round?.boards.filter((b) => b.tracked).length ?? 0), 0),
      primary,
      events,
    };
    res.json(body);
  });
  return r;
}
