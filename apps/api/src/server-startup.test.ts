import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { it } from 'node:test'

function runProbe(body: string): { queries: number } {
  const script = `
    import assert from 'node:assert/strict';
    import {createServer} from 'node:http';
    import {setTimeout as sleep} from 'node:timers/promises';
    import {Pool} from ${JSON.stringify(import.meta.resolve('pg'))};
    let queries = 0;
    Pool.prototype.query = async () => { queries++; return {rows: []}; };
    const {startServer} = await import(${JSON.stringify(new URL('./server.js', import.meta.url).href)});
    const {loadConfig} = await import(${JSON.stringify(new URL('./config.js', import.meta.url).href)});
    ${body}
    console.log(JSON.stringify({queries}));
  `
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 10000,
    env: { ...process.env, NODE_ENV: 'development', QUESTION_SHEET_POLL: 'on', QUESTION_SHEET_POLL_MS: '60000', DINGTALK_APPROVAL_RECONCILE: 'off' },
  })) as { queries: number }
}

it('API 端口占用启动失败时，不领取面试表或启动任何数据库后台任务', () => {
  const result = runProbe(`
    const blocker = createServer();
    await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
    try {
      await assert.rejects(startServer(loadConfig({PORT: String(blocker.address().port), HOST: '127.0.0.1'})), error => error.code === 'EADDRINUSE');
      await sleep(20);
    } finally { await new Promise(resolve => blocker.close(resolve)); }
  `)
  assert.equal(result.queries, 0)
})

it('API 成功监听后才启动面试表轮询，关闭后不遗留轮询进程', () => {
  const result = runProbe(`
    const server = await startServer(loadConfig({PORT: '0', HOST: '127.0.0.1'}));
    await sleep(20);
    await new Promise(resolve => server.close(resolve));
  `)
  assert.ok(result.queries > 0)
})
