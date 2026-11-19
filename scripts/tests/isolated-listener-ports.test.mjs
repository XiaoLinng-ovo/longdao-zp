import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'
import { isolatedEnvironment, projectRoot } from '../isolated-environment.mjs'

function child(program) {
  return new Promise((resolve, reject) => {
    const processChild = spawn(process.execPath, ['--require', join(projectRoot, 'scripts/isolated-listener-ports.cjs'), '-e', program], {
      cwd: projectRoot, windowsHide: true, env: isolatedEnvironment({ ISOLATED_TEST_CLUSTER: 'closure_' + 'b'.repeat(32), ISOLATED_ALLOWED_PORTS: '65534' }), stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
    })
    let stderr = ''
    processChild.stderr.on('data', data => { stderr += data })
    processChild.on('error', reject)
    processChild.on('close', code => resolve({ code, stderr }))
  })
}

test('仅登记本子进程实际监听的回环端口，仍禁止其他本机端口和外联', async () => {
  const result = await child(`
    const http=require('node:http'),net=require('node:net'),assert=require('node:assert/strict');
    const server=http.createServer((req,res)=>res.end('ok'));
    server.listen(0,'127.0.0.1',async()=>{
      assert.throws(()=>net.connect({host:'127.0.0.1',port:1}),/阻止/);
      assert.throws(()=>net.connect({host:'example.invalid',port:443}),/阻止/);
      try { const result=await fetch('http://127.0.0.1:'+server.address().port);assert.equal(await result.text(),'ok') }
      finally {server.closeAllConnections();server.close()}
    });
  `)
  assert.equal(result.code, 0, result.stderr)
})

test('非回环监听不会被登记或作为可访问的业务边界', async () => {
  const result = await child("require('node:net').createServer().listen(0,'0.0.0.0')")
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /只允许监听回环地址/)
})
