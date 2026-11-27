import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { EngineConfig } from '../shared/types.js';
import { createApp, type AppDeps } from './app.js';
import type { FollowerOpts, LichessClient } from './follower.js';
import { fetchEvent, fetchOpening, fetchRound } from './lichess/api.js';
import { Site } from './site.js';
import { SiteState } from './site-state.js';
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
  state: SiteState;
  scheduler: Scheduler;
  site: Site;
  shutdown(): Promise<void>;
}

/** store → state → scheduler → site → app; listens, then resumes the persisted Current Rounds and follows every Event. A corrupt
 *  state file throws. */
export async function startServer(opts: ServerOpts): Promise<Running> {
  const { store, defaultEngine, adminPassword } = opts;
  const state = await SiteState.load(store);
  const lichess = opts.lichess ?? { fetchEvent, fetchRound, fetchOpening };
  const scheduler = new Scheduler(state, { fetchOpening: lichess.fetchOpening, ...opts.scheduler, defaultEngine });
  const site = new Site(state, scheduler, { ...opts.follow, lichess, store });
  const app = createApp({ ...opts.app, store, state, scheduler, site, defaultEngine, adminPassword });
  const server = app.listen(opts.port);
  await once(server, 'listening');
  await scheduler.resume().catch((err) => console.error('resume failed:', err));
  await site.resume();
  return {
    server,
    port: (server.address() as AddressInfo).port,
    state,
    scheduler,
    site,
    /** SIGTERM: drop SSE clients, quit the engine (state kept, so the next boot resumes), flush the last save. */
    async shutdown() {
      server.closeAllConnections();
      server.close();
      await site.stop(); // every Follower, before the Scheduler: an in-flight tick could start a Round
      await scheduler.stop();
      await state.saved();
    },
  };
}
