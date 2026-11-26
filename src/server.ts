import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { EngineConfig } from '../shared/types.js';
import { createApp, type AppDeps } from './app.js';
import { Follower, type FollowerOpts, type LichessClient } from './follower.js';
import { fetchEvent, fetchRound } from './lichess/api.js';
import { RoundState } from './round-state.js';
import { Scheduler, type SchedulerOpts } from './scheduler.js';
import type { DataStore } from './store.js';

export interface ServerOpts {
  port: number; // 0 = any (tests)
  store: DataStore;
  defaultEngine: EngineConfig;
  adminPassword?: string;
  scheduler?: Omit<SchedulerOpts, 'defaultEngine'>; // tests: fake source and engine
  app?: Pick<AppDeps, 'sse' | 'probe'>;
  lichess?: LichessClient; // default the real Lichess API
  follow?: Pick<FollowerOpts, 'now' | 'pollMs' | 'every'>; // tests, demo
}

export interface Running {
  server: Server;
  port: number;
  state: RoundState;
  scheduler: Scheduler;
  follower: Follower;
  shutdown(): Promise<void>;
}

/** store → state → scheduler → follower → app; listens, then resumes a persisted Current Round and Event. A corrupt
 *  state file throws. */
export async function startServer(opts: ServerOpts): Promise<Running> {
  const { store, defaultEngine, adminPassword } = opts;
  const state = await RoundState.load(store);
  const scheduler = new Scheduler(state, { ...opts.scheduler, defaultEngine });
  const lichess = opts.lichess ?? { fetchEvent, fetchRound };
  const follower = new Follower(state, scheduler, { ...opts.follow, lichess, store });
  const app = createApp({ ...opts.app, store, state, scheduler, follower, defaultEngine, adminPassword });
  const server = app.listen(opts.port);
  await once(server, 'listening');
  await scheduler.resume().catch((err) => console.error('resume failed:', err));
  await follower.resume();
  return {
    server,
    port: (server.address() as AddressInfo).port,
    state,
    scheduler,
    follower,
    /** SIGTERM: drop SSE clients, quit the engine (state kept, so the next boot resumes), flush the last save. */
    async shutdown() {
      server.closeAllConnections();
      server.close();
      await follower.stop(); // before the Scheduler: an in-flight tick could start a Round
      await scheduler.stop();
      await state.saved();
    },
  };
}
