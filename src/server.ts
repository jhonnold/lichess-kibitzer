import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { EngineConfig } from '../shared/types.js';
import { createApp, type AppDeps } from './app.js';
import { RoundState } from './round-state.js';
import { Scheduler, type SchedulerOpts } from './scheduler.js';
import type { DataStore } from './store.js';

export interface ServerOpts {
  port: number; // 0 = any (tests)
  store: DataStore;
  defaultEngine: EngineConfig;
  adminPassword?: string;
  scheduler?: Omit<SchedulerOpts, 'defaultEngine'>; // tests: fake source and engine
  app?: Pick<AppDeps, 'sse' | 'probe' | 'lichess'>;
}

export interface Running {
  server: Server;
  port: number;
  state: RoundState;
  scheduler: Scheduler;
  shutdown(): Promise<void>;
}

/** store → state → scheduler → app; listens, then resumes a persisted Current Round. A corrupt state file throws. */
export async function startServer(opts: ServerOpts): Promise<Running> {
  const { store, defaultEngine, adminPassword } = opts;
  const state = await RoundState.load(store);
  const scheduler = new Scheduler(state, { ...opts.scheduler, defaultEngine });
  const app = createApp({ ...opts.app, state, scheduler, defaultEngine, adminPassword });
  const server = app.listen(opts.port);
  await once(server, 'listening');
  await scheduler.resume().catch((err) => console.error('resume failed:', err));
  return {
    server,
    port: (server.address() as AddressInfo).port,
    state,
    scheduler,
    /** SIGTERM: drop SSE clients, quit the engine (state kept, so the next boot resumes), flush the last save. */
    async shutdown() {
      server.closeAllConnections();
      server.close();
      await scheduler.stop();
      await state.saved();
    },
  };
}
