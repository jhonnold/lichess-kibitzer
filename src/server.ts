import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { EngineConfig } from '../shared/types.js';
import { createApp, type AppDeps } from './app.js';
import { Kibitzer, type KibitzerOpts } from './kibitzer.js';
import { State } from './state.js';
import type { Store } from './store.js';

export interface ServerOpts {
  port: number; // 0 = any (tests)
  store: Store;
  defaultEngine: EngineConfig;
  adminPassword?: string;
  kibitzer?: Omit<KibitzerOpts, 'defaultEngine'>; // tests: fake source and engine
  app?: Pick<AppDeps, 'sse' | 'probe' | 'lichess'>;
}

export interface Running {
  server: Server;
  port: number;
  state: State;
  kibitzer: Kibitzer;
  shutdown(): Promise<void>;
}

/** store → state → kibitzer → app; listens, then resumes a persisted Live game. A corrupt state file throws. */
export async function startServer(opts: ServerOpts): Promise<Running> {
  const { store, defaultEngine, adminPassword } = opts;
  const state = new State(store, await store.load());
  const kibitzer = new Kibitzer(state, { ...opts.kibitzer, defaultEngine });
  const app = createApp({ ...opts.app, state, kibitzer, defaultEngine, adminPassword });
  const server = app.listen(opts.port);
  await once(server, 'listening');
  await kibitzer.resume().catch((err) => console.error('resume failed:', err)); // site is Idle then
  return {
    server,
    port: (server.address() as AddressInfo).port,
    state,
    kibitzer,
    /** SIGTERM: drop SSE clients, quit the engine (state kept, so the next boot resumes), flush the last save. */
    async shutdown() {
      server.closeAllConnections();
      server.close();
      await kibitzer.engine?.quit();
      await state.saved();
    },
  };
}
