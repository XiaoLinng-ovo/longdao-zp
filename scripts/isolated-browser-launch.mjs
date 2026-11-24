import assert from 'node:assert/strict'

const disableSwitch = '--disable-features='
const workaround = 'TcpPortRandomizationWin'

async function disabledFeatures(browser) {
  const session = await browser.newBrowserCDPSession()
  try {
    const { arguments: args } = await session.send('Browser.getBrowserCommandLine')
    const features = args.filter(arg => arg.startsWith(disableSwitch))
    assert.equal(features.length, 1, 'Expected one Chromium disable-features switch')
    return features[0]
  } finally { await session.detach() }
}

export async function launchIsolatedBrowser(chromium, options, platform = process.platform) {
  if (platform === 'win32') options = { ...options, args: [...(options.args ?? []), '--enable-automation'] }
  let browser = await chromium.launch(options)
  if (platform !== 'win32') return { browser, windowsTcpWorkaround: false }
  try {
    const original = await disabledFeatures(browser)
    const features = original.slice(disableSwitch.length).split(',').filter(Boolean)
    if (!features.includes(workaround)) {
      // Match Playwright's upstream workaround for crbug.com/572515601 without replacing its other defaults.
      const merged = disableSwitch + [...features, workaround].join(',')
      await browser.close()
      browser = await chromium.launch({ ...options, ignoreDefaultArgs: [original], args: [...options.args, merged] })
      assert.equal(await disabledFeatures(browser), merged)
    }
    return { browser, windowsTcpWorkaround: true }
  } catch (error) {
    await browser.close().catch(() => {})
    throw error
  }
}
