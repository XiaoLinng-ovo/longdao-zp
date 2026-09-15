import { fileURLToPath } from 'node:url';
import './env.js';
import { loadConfig } from './config.js';
import { startServer } from './server.js';

export { loadConfig } from './config.js';
export { createApp, createHttpServer, startServer } from './server.js';
export type { AppConfig } from './config.js';

const entrypoint = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;

if (entrypoint) {
  const config = loadConfig();
  startServer(config)
    .then((server) => {
      const address = server.address();
      const displayAddress = typeof address === 'string' ? address : `${address?.address}:${address?.port}`;
      console.log(`${config.appName} listening on ${displayAddress}`);
    })
    .catch((error: unknown) => {
      console.error('Failed to start API server', error);
      process.exitCode = 1;
    });
}

