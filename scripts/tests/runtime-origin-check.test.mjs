import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { verifyReleaseOriginPolicy } from '../runtime-origin-check.mjs'

function processFixture(result, exitCode = 0) {
  return (_node, args, options) => {
    assert.equal(args[1], '--probe')
    assert.equal(args[2], resolve('candidate'))
    assert.deepEqual(options.env, { PATH: 'fixture-path', TEMP: 'fixture-temp' })
    assert.equal(options.windowsHide, true)
    assert.equal(options.timeout, 45000)
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    queueMicrotask(() => {
      child.stdout.emit('data', JSON.stringify(result))
      child.stderr.emit('data', 'private fixture diagnostics')
      child.emit('exit', exitCode, null)
    })
    return child
  }
}

const env = { PATH: 'fixture-path', TEMP: 'fixture-temp', PGPASSWORD: 'must-not-leak', DATABASE_URL: 'must-not-connect',
  ENV_FILE_PATH: 'must-not-read', NODE_OPTIONS: '--require=must-not-load', S3_ENDPOINT: 'must-not-upload' }

test('release origin probes run without database, profile, storage or injected Node configuration', async () => {
  const result = { ready: true, originPolicy: 'same-origin', checkedRequests: 42 }
  assert.deepEqual(await verifyReleaseOriginPolicy('candidate', { env, spawnProcess: processFixture(result) }), result)
})

test('legacy or failing releases cannot pass the domain-rotation deployment gate', async () => {
  await assert.rejects(verifyReleaseOriginPolicy('candidate', { env, spawnProcess: processFixture({}, 1) }), /RELEASE_ORIGIN_POLICY/)
  for (const result of [{ ready: true }, { ready: true, originPolicy: 'same-origin', checkedRequests: 1 }]) {
    await assert.rejects(verifyReleaseOriginPolicy('candidate', { env, spawnProcess: processFixture(result) }), /Invalid isolated check/)
  }
})

test('isolated process startup failures reject deployment', async () => {
  await assert.rejects(verifyReleaseOriginPolicy('candidate', { env, spawnProcess: () => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    queueMicrotask(() => child.emit('error', new Error('fixture startup error')))
    return child
  } }), /Isolated check could not run/)
})
