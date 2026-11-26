import { engineConfig } from '../shared/engine-config.js';
import { startServer } from './server.js';
import { dataStore } from './store.js';

const running = await startServer({
  port: Number(process.env.PORT ?? 8080),
  store: dataStore(),
  defaultEngine: engineConfig(process.env.DEFAULT_ENGINE || 'berserk'),
  adminPassword: process.env.ADMIN_PASSWORD,
});
console.log(`Listening on port ${running.port}`);
for (const sig of ['SIGTERM', 'SIGINT'] as const)
  process.once(sig, () => void running.shutdown().finally(() => process.exit(0)));
