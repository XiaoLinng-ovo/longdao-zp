import { setDefaultResultOrder } from 'node:dns';
import { fileURLToPath } from 'node:url';
import './env.js';
import { loadConfig } from './config.js';
import { startServer } from './server.js';

// 部分 OpenAI 兼容端点会发布不可达的 AAAA 记录，纯 IPv6 优先会让每次调用白等数秒甚至随机失败。
setDefaultResultOrder('ipv4first');

export { loadConfig } from './config.js';
export { createApp, createHttpServer, startServer } from './server.js';
export type { AppConfig } from './config.js';

const entrypoint = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;

if (entrypoint) {
  const config = loadConfig();
  // Keep process.env-based middleware aligned with loadConfig's local default.
  // Without this, a direct `node dist/src/index.js` start reports development
  // through config but CSRF/origin checks still see an undefined NODE_ENV.
  if (!process.env.NODE_ENV?.trim()) process.env.NODE_ENV = config.nodeEnv;
  startServer(config)
    .then((server) => {
      let stopping = false;
      const shutdown = () => {
        if (stopping) return;
        stopping = true;
        void server.closeAsync().catch(() => {
          console.error('服务器资源关闭失败，请检查未完成任务与数据库状态');
          process.exitCode = 1;
        }).finally(() => {
          process.off('SIGINT', shutdown);
          process.off('SIGTERM', shutdown);
        });
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      const address = server.address();
      const displayAddress = typeof address === 'string' ? address : `${address?.address}:${address?.port}`;
      console.log(`${config.appName} listening on ${displayAddress}`);
    })
    .catch((error: unknown) => {
      console.error('Failed to start API server', error);
      process.exitCode = 1;
    });
}

