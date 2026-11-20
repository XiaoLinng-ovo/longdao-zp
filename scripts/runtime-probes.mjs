import { createServer } from 'node:net'

export async function requireFreePorts(ports) {
  for (const [role, port] of Object.entries(ports)) {
    const listener = createServer()
    try {
      await new Promise((yes, no) => { listener.once('error', no); listener.listen({ port, host: '127.0.0.1', exclusive: true }, yes) })
    } catch { throw new Error('PORT_CONFLICT: ' + role + ' port ' + port + ' is occupied. Identify the existing process; no automatic kill, reuse or port switching.') }
    finally { if (listener.listening) await new Promise(yes => listener.close(yes)) }
  }
}

export async function probeRuntime(ports, version) {
  const json = async url => {
    const response = await fetch(url, { signal: AbortSignal.timeout(12000), redirect: 'error' })
    const body = await response.json()
    return { status: response.status, data: body.data || body }
  }
  const checks = {}
  const check = async (name, action) => {
    try { checks[name] = { ok: Boolean(await action()) } }
    catch { checks[name] = { ok: false, message: 'Service unreachable, invalid identity or invalid probe response' } }
  }
  const identity = (result, service) => result.status === 200 && result.data.service === service && (!version || result.data.version === version)
  await Promise.all([
    check('api', async () => identity(await json('http://127.0.0.1:' + ports.api + '/api/v1/health'), 'smartrecruit-pro-api')),
    check('worker', async () => { const result = await json('http://127.0.0.1:' + ports.worker + '/ready'); return identity(result, 'smartrecruit-pro-worker') && result.data.status === 'ready' && result.data.externalDependencies?.postgres === 'ok' }),
    check('web', async () => { const response = await fetch('http://127.0.0.1:' + ports.web + '/', { headers: { accept: 'text/html' }, signal: AbortSignal.timeout(3000), redirect: 'error' }); return response.ok && (await response.text()).includes('<div id="app">') }),
    check('sameOriginApi', async () => identity(await json('http://127.0.0.1:' + ports.web + '/api/v1/health'), 'smartrecruit-pro-api')),
    check('sameOriginReady', async () => { const result = await json('http://127.0.0.1:' + ports.web + '/api/v1/ready'); return result.status === 200 && result.data.status === 'ready' }),
  ])
  return { ready: Object.values(checks).every(item => item.ok), checks }
}
