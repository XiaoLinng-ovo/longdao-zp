import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { isolatedEnvironment, projectRoot } from '../isolated-environment.mjs'

test('隔离环境不继承业务凭据、代理或 Node 注入选项', () => {
  const env = isolatedEnvironment({}, { Path: 'synthetic-path', SYSTEMROOT: 'synthetic-os', PGHOST: 'business', PGPASSWORD: 'secret',
    DATABASE_URL: 'business', SMTP_PASSWORD: 'secret', OPENAI_API_KEY: 'secret', NODE_OPTIONS: '--import unknown', HTTP_PROXY: 'business',
    ENV_FILE_PATH: 'business.env', RECRUITING_QUARANTINE_ROOT: 'business-storage', INTERVIEW_STORAGE_ROOT: 'business-audio' })
  assert.equal(env.Path, 'synthetic-path')
  assert.equal(env.SYSTEMROOT, 'synthetic-os')
  assert.equal(env.OPENAI_API_KEY, '')
  assert.equal(env.SMTP_HOST, '')
  for (const name of ['PGHOST', 'PGPASSWORD', 'DATABASE_URL', 'NODE_OPTIONS', 'HTTP_PROXY', 'SMTP_PASSWORD', 'ENV_FILE_PATH', 'RECRUITING_QUARANTINE_ROOT', 'INTERVIEW_STORAGE_ROOT']) assert.equal(env[name], undefined)
})

test('网络护栏允许指定本机端口，阻止其他端口、远端、域套接字和 UDP', async () => {
  const server = createServer(socket => socket.end())
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const env = isolatedEnvironment({ ISOLATED_TEST_CLUSTER: 'closure_' + 'a'.repeat(32), ISOLATED_ALLOWED_PORTS: String(port) })
  const program = [
    "const net=require('node:net'),assert=require('node:assert/strict')",
    "for(const args of [[{host:'example.invalid',port:443}],[{host:'127.0.0.1',port:1}],['pipe-test']]) assert.throws(()=>net.connect(...args),/阻止/)",
    "assert.throws(()=>require('node:dgram').createSocket('udp4'),/禁止 UDP/)",
    "const guard=require('./scripts/isolated-network-guard.cjs'); for(const port of [0,-1,65536,1.5,'443']) assert.throws(()=>guard.allowLoopbackPort(port))",
    "guard.allowLoopbackPort(65534); const extra=net.connect({host:'127.0.0.1',port:65534}); extra.on('error',()=>{}); extra.destroy(); assert.throws(()=>net.connect({host:'example.invalid',port:65534}),/阻止/)",
    "for(const args of [[{host:'127.0.0.1',port:Number(process.env.ISOLATED_ALLOWED_PORTS)}],[Number(process.env.ISOLATED_ALLOWED_PORTS),'127.0.0.1']]) { const socket=net.connect(...args); socket.on('error',()=>{process.exitCode=1}); socket.on('connect',()=>socket.destroy()) }",
  ].join(';')
  try {
    // The child can complete its TCP handshake without the parent event loop serving data.
    const result = spawnSync(process.execPath, ['--require', join(projectRoot, 'scripts/isolated-network-guard.cjs'), '-e', program],
      { env, windowsHide: true, encoding: 'utf8', timeout: 5000 })
    assert.equal(result.status, 0, result.stderr || result.error?.message)
  } finally { await new Promise(resolve => server.close(resolve)) }
})
