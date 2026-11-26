import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import type { EngineConfig, Player, QueueView, RegisteredEvent, Result, StreamStatus } from '../../shared/types.js';
import type { DeadJob, Job } from '../../shared/queue.js';
import { probeEngine } from '../engine/engine.js';
import type { UciOption } from '../engine/uci-parser.js';
import type { Follower, FollowStatus, LichessClient } from '../follower.js';
import { fetchEvent, LichessError } from '../lichess/api.js';
import type { RoundState } from '../round-state.js';
import type { EngineState, Scheduler } from '../scheduler.js';

export const COOKIE = 'kibitzer_admin';
const MAX_AGE_MS = 7 * 24 * 3600_000;
const MAX_JOB_MS = 3600_000; // keeps `go movetime` a plain integer

export interface AdminDeps {
  state: RoundState;
  scheduler: Pick<
    Scheduler,
    | 'engine'
    | 'running'
    | 'setJobTime'
    | 'setTracked'
    | 'setEngine'
    | 'requeueDead'
    | 'discardDead'
    | 'engineState'
    | 'restarts'
  >;
  follower: Pick<Follower, 'register' | 'clear' | 'status'>;
  defaultEngine: EngineConfig; // shown (and used) while no config is saved
  adminPassword?: string; // unset or empty: every login is refused
  probe?: (path: string) => Promise<{ name: string; options: UciOption[] }>; // default probeEngine
  lichess?: Pick<LichessClient, 'fetchEvent'>; // the GET /event preview; default the real one
}

export interface AdminStatus {
  event: RegisteredEvent | null;
  round: {
    tourId: string;
    roundId: string;
    name: string;
    boards: { id: string; board: number; white: Player; black: Player; result: Result; tracked: boolean }[];
  } | null;
  stream: StreamStatus | null;
  engine: EngineConfig; // saved, else the default
  engineRunning: boolean;
  engineState: EngineState;
  restarts: number;
  jobTimeMs: number | null;
  topN: number;
  running: Job | null;
  queue: QueueView;
  dead: readonly DeadJob[];
  follow: FollowStatus;
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
    scheduler,
    follower,
    defaultEngine,
    adminPassword,
    probe = probeEngine,
    lichess = { fetchEvent },
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
  r.post('/engine/probe', (req, res) => {
    probe(String(req.body?.path ?? '')).then((p) => res.json(p), fail(res));
  });
  /** A `button` option (e.g. Clear Hash) for the running engine; queued, so it is sent between searches. */
  r.post('/engine/button', (req, res) => {
    const name: unknown = req.body?.name;
    if (!oneLine(name) || !name) return void res.status(400).json({ error: 'expected { name }' });
    if (!scheduler.engine) return void res.status(409).json({ error: 'no engine running' });
    scheduler.engine.setOption(name);
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
    scheduler
      .setEngine({ path, options: options as Record<string, string> })
      .then(() => res.sendStatus(204), fail(res));
  });
  /** Register an Event: from then on the Follower picks the Current Round. */
  r.post('/event', (req, res) => {
    const link: unknown = req.body?.link;
    if (typeof link !== 'string' || !link) return void res.status(400).json({ error: 'expected { link }' });
    follower.register(link).then(() => res.sendStatus(204), fail(res));
  });
  r.post('/clear', (_req, res) => {
    follower.clear().then(() => res.sendStatus(204), fail(res));
  });
  /** The next Round's default; the Scheduler has no topN. */
  r.put('/topn', (req, res) => {
    const n: unknown = req.body?.n;
    if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > 64)
      return void res.status(400).json({ error: 'expected { n: integer 1-64 }' });
    state.setTopN(n as number);
    res.sendStatus(204);
  });
  r.put('/jobtime', (req, res) => {
    const ms: unknown = req.body?.ms;
    if (ms !== null && (!Number.isInteger(ms) || (ms as number) <= 0 || (ms as number) > MAX_JOB_MS))
      return void res.status(400).json({ error: `expected { ms: integer 1-${MAX_JOB_MS} | null }` });
    scheduler.setJobTime(ms as number | null).then(() => res.sendStatus(204), fail(res));
  });
  r.put('/tracked', (req, res) => {
    const ids: unknown = req.body?.boardIds;
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string'))
      return void res.status(400).json({ error: 'expected { boardIds: string[] }' });
    if (!state.round) return void res.status(409).json({ error: 'no Current Round' });
    const known = new Set(state.round.boards.map((b) => b.id));
    if (!ids.every((id) => known.has(id)))
      return void res.status(400).json({ error: 'not a Board of the Current Round' });
    scheduler.setTracked(ids as string[]).then(() => res.sendStatus(204), fail(res));
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
    const round = state.round;
    const body: AdminStatus = {
      event: state.settings.event,
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
      stream: state.snapshot().stream,
      engine: state.settings.engine ?? defaultEngine,
      engineRunning: scheduler.engine !== null,
      engineState: scheduler.engineState,
      restarts: scheduler.restarts,
      jobTimeMs: state.settings.jobTimeMs,
      topN: state.settings.topN,
      running: scheduler.running,
      queue: state.snapshot().queue,
      dead: state.dead,
      follow: follower.status,
    };
    res.json(body);
  });
  return r;
}
