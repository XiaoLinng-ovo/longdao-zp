import assert from 'node:assert/strict'
import test from 'node:test'
import { launchIsolatedBrowser } from '../isolated-browser-launch.mjs'

function fixture(runs) {
  const calls = []
  const chromium = { async launch(options) {
    const run = runs[calls.length]
    if (!run) throw new Error('Unexpected launch')
    const call = { options, closed: false, detached: false, sessions: 0 }
    calls.push(call)
    return { async close() { call.closed = true }, async newBrowserCDPSession() {
      call.sessions++
      return { async send(method) {
        assert.equal(method, 'Browser.getBrowserCommandLine')
        return { arguments: run }
      }, async detach() { call.detached = true } }
    } }
  } }
  return { chromium, calls }
}

const defaults = '--disable-features=One,Two', merged = defaults + ',TcpPortRandomizationWin'
const options = { channel: 'chrome', args: ['--use-fake-device-for-media-stream'] }

test('preserves Chromium defaults and verifies the merged switch on Windows', async () => {
  const { chromium, calls } = fixture([[defaults], [merged]])
  const result = await launchIsolatedBrowser(chromium, options, 'win32')
  assert.deepEqual(calls[1].options, { ...options, ignoreDefaultArgs: [defaults], args: [...options.args, '--enable-automation', merged] })
  assert.deepEqual(calls.map(({ closed, detached }) => [closed, detached]), [[true, true], [false, true]])
  assert.equal(result.windowsTcpWorkaround, true)
  await result.browser.close()
})

test('does not relaunch when the upstream workaround is present or on non-Windows', async () => {
  for (const [platform, flag, sessions] of [['win32', true, 1], ['linux', false, 0]]) {
    const { chromium, calls } = fixture([[merged]])
    const result = await launchIsolatedBrowser(chromium, options, platform)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].sessions, sessions)
    assert.equal(result.windowsTcpWorkaround, flag)
    await result.browser.close()
  }
})

test('retains caller audio defaults across the Windows relaunch', async () => {
  const { chromium, calls } = fixture([[defaults], [merged]])
  const result = await launchIsolatedBrowser(chromium, { ...options, ignoreDefaultArgs: ['--mute-audio'] }, 'win32')
  assert.deepEqual(calls[1].options.ignoreDefaultArgs, ['--mute-audio', defaults])
  await result.browser.close()
})

test('closes the isolated browser if command-line verification fails', async () => {
  const { chromium, calls } = fixture([[defaults], [defaults, merged]])
  await assert.rejects(launchIsolatedBrowser(chromium, options, 'win32'), /one Chromium/)
  assert.ok(calls.every(call => call.closed && call.detached))
})
