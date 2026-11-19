import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { it } from 'node:test'

interface Probe { queries: number; closedPools: number; createdPools: number }
function runProbe(body: string): Probe {
  const script = `
    import assert from 'node:assert/strict';
    import {createServer} from 'node:http';
    import {connect as openSocket} from 'node:net';
    import {setTimeout as sleep} from 'node:timers/promises';
    import {createRequire} from 'node:module';
    import {fileURLToPath} from 'node:url';
    const pg = createRequire(import.meta.url)(fileURLToPath(${JSON.stringify(import.meta.resolve('pg'))}));
    let queries = 0, closedPools = 0, createdPools = 0;
    const ended = new Set();
    pg.Pool.prototype.query = async () => { queries++; return {rows: []}; };
    pg.Pool.prototype.connect = async () => ({query: pg.Pool.prototype.query, release() {}});
    pg.Pool.prototype.end = async function() { assert.equal(ended.has(this), false, 'pool ended twice'); ended.add(this); closedPools++; };
    const {startServer, createHttpServer, createApp} = await import(${JSON.stringify(new URL('./server.js', import.meta.url).href)});
    const {loadConfig} = await import(${JSON.stringify(new URL('./config.js', import.meta.url).href)});
    const {createDatabasePool} = await import(${JSON.stringify(new URL('./db/connection.js', import.meta.url).href)});
    const options = {preflight: async () => {}, poolFactory() { createdPools++; return createDatabasePool(); }};
    assert.equal(createdPools, 0, 'importing modules must not allocate pools');
    ${body}
    console.log(JSON.stringify({queries, closedPools, createdPools}));
  `
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 20000,
    env: { ...process.env, NODE_ENV: 'development', DATABASE_URL: '', PGPASSWORD: '',
      QUESTION_SHEET_POLL: 'on', QUESTION_SHEET_POLL_MS: '60000', TENANT_SCHEMA_ROUTING: 'off',
      INTERVIEW_QUESTION_PREPARATION_POLL: 'off', INTERVIEW_AUDIO_POLL: 'off',
      INTERVIEW_TRANSCRIPT_POSTPROCESS_POLL: 'off', INTERVIEW_SUMMARY_POLL: 'off' },
  })) as Probe
}

it('端口占用时不领取后台任务，并回收全部自建连接池', () => {
  const result = runProbe(`
    const blocker = createServer();
    await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
    try {
      await assert.rejects(startServer(loadConfig({PORT: String(blocker.address().port), HOST: '127.0.0.1'}), options), error => error.code === 'EADDRINUSE');
    } finally { await new Promise(resolve => blocker.close(resolve)); }
  `)
  assert.equal(result.queries, 0)
  assert.equal(result.createdPools, 1)
  assert.equal(result.closedPools, result.createdPools)
})

it('只读门禁失败时不监听、不领取任务并回收连接池', () => {
  const result = runProbe(`
    options.preflight = async () => { throw new Error('synthetic release gate failure'); };
    await assert.rejects(startServer(loadConfig({PORT: '0', HOST: '127.0.0.1'}), options), /synthetic release gate failure/);
  `)
  assert.equal(result.queries, 0)
  assert.equal(result.closedPools, 1)
})

it('不可取消的连接池排空必须超时失败并保留原始关闭结果', () => {
  const result = runProbe(`
    let finish;
    pg.Pool.prototype.end = function() { closedPools++; return new Promise(resolve => { finish = resolve; }); };
    const server = createHttpServer(loadConfig({PORT: '0', HOST: '127.0.0.1', API_SHUTDOWN_TIMEOUT_MS: '100'}), options);
    const started = Date.now();
    const closing = server.closeAsync();
    assert.equal(server.closeAsync(), closing);
    await assert.rejects(closing, error => error.code === 'SHUTDOWN_TIMEOUT' && error.pending.length > 0);
    assert.ok(Date.now() - started < 1000);
    assert.equal(server.listening, false);
    finish(); await sleep(20);
    await assert.rejects(server.closeAsync(), error => error.code === 'SHUTDOWN_TIMEOUT');
  `)
  assert.equal(result.closedPools, 1)
})

it('HTTP原生连接关闭等待也在统一期限内，半个请求会被实际断开', () => {
  const result = runProbe(`
    const server = createHttpServer(loadConfig({PORT: '0', HOST: '127.0.0.1', API_SHUTDOWN_TIMEOUT_MS: '300'}), options);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const socket = openSocket({host:'127.0.0.1',port:server.address().port});
    socket.on('error', () => {});
    await new Promise(resolve => socket.once('connect', resolve));
    socket.write(['POST /api/v1/auth/login HTTP/1.1', 'Host: localhost', ''].join(String.fromCharCode(13, 10)));
    const disconnected = new Promise(resolve => socket.once('close', resolve));
    const started = Date.now();
    await server.closeAsync();
    await disconnected;
    assert.ok(Date.now() - started < 1000);
    assert.equal(socket.destroyed, true);
  `)
  assert.equal(result.closedPools, 1)
})

it('普通启动默认启用门禁，关闭公司路由不能绕过检查', () => {
  const result = runProbe(`
    delete options.preflight;
    await assert.rejects(startServer(loadConfig({PORT: '0', HOST: '127.0.0.1'}), options), /必须启用公司 Schema/);
  `)
  assert.equal(result.queries, 0)
  assert.equal(result.closedPools, 1)
})

it('成功监听才开始轮询，关闭回调等待任务和资源排空', () => {
  const result = runProbe(`
    const server = await startServer(loadConfig({PORT: '0', HOST: '127.0.0.1'}), options);
    await sleep(20);
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await server.closeAsync();
  `)
  assert.ok(result.queries > 0)
  assert.equal(result.createdPools, 1)
  assert.equal(result.closedPools, result.createdPools)
})

it('连续创建和关闭应用50次，重复关闭不重复释放或跨实例关闭', () => {
  const result = runProbe(`
    const config = loadConfig({PORT: '0', HOST: '127.0.0.1'});
    const retained = createApp(config, options);
    for(let index = 0; index < 50; index++) {
      const app = createApp(config, options);
      assert.equal(createdPools - closedPools, 2);
      await Promise.all([app.close(), app.close(), app.close()]);
      assert.equal(createdPools - closedPools, 1);
    }
    await retained.close();
  `)
  assert.equal(result.queries, 0)
  assert.equal(result.createdPools, 51)
  assert.equal(result.closedPools, 51)
})

it('后台核对使用请求侧注入的支付服务，关闭等待正在执行的核对', () => {
  const result = runProbe(`
    process.env.QUESTION_SHEET_POLL = 'off';
    process.env.OBJECT_CLEANUP_POLL = 'off';
    const interval = globalThis.setInterval;
    const ticks = [];
    globalThis.setInterval = (callback, ms, ...args) => {
      if (ms === 60000) ticks.push(callback);
      return interval(callback, ms, ...args);
    };
    let finish, calls = 0;
    const waiting = new Promise(resolve => { finish = resolve; });
    options.paymentService = {async reconcile() { calls++; await waiting; assert.equal(closedPools, 0); }};
    const server = await startServer(loadConfig({PORT: '0', HOST: '127.0.0.1'}), options);
    assert.equal(calls, 0, 'payment poll must retain its non-immediate schedule');
    assert.equal(ticks.length, 1);
    ticks[0]();
    assert.equal(calls, 1);
    let complete = false;
    const closing = server.closeAsync().then(() => { complete = true; });
    await sleep(20);
    assert.equal(complete, false);
    assert.equal(closedPools, 0);
    finish(); await closing;
    ticks[0]();
    assert.equal(calls, 1, 'closed payment poll must not start another request');
  `)
  assert.equal(result.queries, 0)
  assert.equal(result.closedPools, result.createdPools)
})

it('独立HTTP服务器关闭及从未监听的服务器关闭均释放资源', () => {
  const result = runProbe(`
    const config = loadConfig({PORT: '0', HOST: '127.0.0.1'});
    const server = createHttpServer(config, options);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await Promise.all([server.closeAsync(), server.closeAsync()]);
    await createHttpServer(config, options).closeAsync();
  `)
  assert.equal(result.queries, 0)
  assert.equal(result.createdPools, 2)
  assert.equal(result.closedPools, 2)
})

it('关闭等待已开始的数据库后台任务，然后才结束连接池', () => {
  const result = runProbe(`
    let finish, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const waiting = new Promise(resolve => { finish = resolve; });
    pg.Pool.prototype.connect = async () => ({query: async () => {
      queries++; entered(); await waiting;
      assert.equal(closedPools, 0, 'pool closed during work');
      return {rows: []};
    }, release() {}});
    const server = await startServer(loadConfig({PORT: '0', HOST: '127.0.0.1'}), options);
    await started;
    let completed = false;
    const closing = server.closeAsync().then(() => { completed = true; });
    await sleep(20);
    assert.equal(completed, false);
    assert.equal(closedPools, 0);
    finish(); await closing;
  `)
  assert.ok(result.queries > 0)
  assert.equal(result.closedPools, result.createdPools)
})

it('启动服务构造中途失败也回收连接池，不留下轮询', () => {
  const result = runProbe(`
    process.env.S3_ENDPOINT = 'http://127.0.0.1:1';
    process.env.S3_ACCESS_KEY_ID = '';
    assert.throws(() => createHttpServer(loadConfig({PORT: '0'}), options));
    await sleep(20);
  `)
  assert.equal(result.queries, 0)
  assert.equal(result.closedPools, result.createdPools)
})

it('未监听时仍报告资源关闭失败，不被服务器未运行提示掩盖', () => {
  const result = runProbe(`
    pg.Pool.prototype.end = async function() { closedPools++; throw new Error('synthetic close failure'); };
    const server = createHttpServer(loadConfig({PORT: '0'}), options);
    await assert.rejects(server.closeAsync(), /synthetic close failure/);
  `)
  assert.equal(result.closedPools, 1)
})
