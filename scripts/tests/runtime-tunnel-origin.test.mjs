import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { planTunnelOrigin, selectTunnelRuntime, synchronizeTunnelOrigin, tunnelWritePaths,
  validateTunnelOrigin, verifyTunnelIdentity, verifyTunnelWrites } from '../runtime-tunnel-origin.mjs'

const origin = 'https://new-recruitment-address.trycloudflare.com'
test('the tunnel preserves public Host', async () => {
  const script = await readFile(new URL('../start-recruitment-tunnel.ps1', import.meta.url), 'utf8')
  const argumentsBlock = script.split('-ArgumentList @(')[1].split(') -WorkingDirectory')[0]
  assert.doesNotMatch(argumentsBlock, /--http-host-header/)
  assert.match(script, /CommandLine -notmatch/)
})

const fixture = async run => {
  const root = await mkdtemp(join(tmpdir(), 'recruit-tunnel-'))
  try {
    const profile = join(root, 'selected.env')
    const content = '# keep configuration\r\nALLOWED_ORIGINS=http://127.0.0.1:5175\r\nRESUME_UPLOAD_RELAX_ORIGIN=true\r\nDATABASE_URL=do-not-change\r\n'
    await writeFile(profile, content)
    const runtime = { env: { ENV_FILE_PATH: profile, ALLOWED_ORIGINS: 'https://existing.example.test',
      RESUME_UPLOAD_RELAX_ORIGIN: 'true', AUTH_MFA_ENCRYPTION_KEY: 'preserved-key', WEB_PORT: '5175' },
      ports: { web: 5175 }, active: { id: 'sealed-v1', directory: join(root, 'sealed') }, state: root }
    await run({ root, profile, content, runtime })
  } finally { await rm(root, { recursive: true, force: true }) }
}

test('new releases verify rotated domains without editing the profile or restarting', () => fixture(async ({ root, profile, content, runtime }) => {
  const strictContent = content.replace('RESUME_UPLOAD_RELAX_ORIGIN=true', 'RESUME_UPLOAD_RELAX_ORIGIN=false')
  await writeFile(profile, strictContent)
  runtime.env.RESUME_UPLOAD_RELAX_ORIGIN = 'false'
  const checked = []
  const options = { identity: async () => ({ originPolicy: 'same-origin' }),
    manage: async () => assert.fail('same-origin domain rotation must not reload services'),
    verify: async value => checked.push(value) }
  for (const value of [origin, 'https://another-new-address.trycloudflare.com']) {
    const result = await synchronizeTunnelOrigin(root, runtime, value, options)
    assert.equal(result.ready, true)
    assert.equal(result.reloaded, false)
    assert.equal(result.checkedWritePaths, 7)
    assert.equal(await readFile(profile, 'utf8'), strictContent)
    assert.equal(runtime.env.ALLOWED_ORIGINS, 'https://existing.example.test')
  }
  assert.deepEqual(checked, [origin, 'https://another-new-address.trycloudflare.com'])
  assert.deepEqual(await readdir(root), ['selected.env'])
  await assert.rejects(synchronizeTunnelOrigin(root, runtime, origin, { ...options,
    verify: async () => { throw new Error('source check failed') } }), /source check failed/)
  assert.equal(await readFile(profile, 'utf8'), strictContent)
  assert.deepEqual(await readdir(root), ['selected.env'])
}))

test('new releases still disable a legacy upload bypass before reporting readiness', () => fixture(async ({ root, profile, runtime }) => {
  const calls = []
  await synchronizeTunnelOrigin(root, runtime, origin, {
    identity: async () => ({ originPolicy: 'same-origin' }),
    manage: async action => { calls.push(action); return { ready: true } }, verify: async () => {},
  })
  assert.deepEqual(calls, ['doctor', 'stop', 'start'])
  assert.match(await readFile(profile, 'utf8'), /RESUME_UPLOAD_RELAX_ORIGIN=false/)
}))

test('only exact HTTPS quick-tunnel origins can be registered', () => {
  assert.equal(validateTunnelOrigin(origin), origin)
  for (const value of [undefined, '', '*', 'http://new.trycloudflare.com', 'https://trycloudflare.com',
    'https://a.b.trycloudflare.com', 'https://new.trycloudflare.com.evil.test', 'https://user@new.trycloudflare.com',
    'https://new.trycloudflare.com/', 'https://new.trycloudflare.com:443', 'https://new.trycloudflare.com?x=1']) {
    assert.throws(() => validateTunnelOrigin(value), /TUNNEL_ORIGIN/)
  }
})

test('domain rotation unions exact origins and disables the old partial upload relaxation', () => {
  const content = '\uFEFFALLOWED_ORIGINS="https://old.trycloudflare.com"\r\nOTHER=keep\r\nRESUME_UPLOAD_RELAX_ORIGIN=true\r\n'
  const env = { ALLOWED_ORIGINS: 'http://127.0.0.1:5175', DATABASE_URL: 'preserve', REQUIRE_CSRF: 'true' }
  const plan = planTunnelOrigin(content, env, origin)
  assert.equal(plan.env.ALLOWED_ORIGINS, 'http://127.0.0.1:5175,https://old.trycloudflare.com,' + origin)
  assert.equal(plan.env.RESUME_UPLOAD_RELAX_ORIGIN, 'false')
  assert.equal(plan.env.DATABASE_URL, 'preserve')
  assert.equal(plan.env.REQUIRE_CSRF, 'true')
  assert.match(plan.content, /^\uFEFFALLOWED_ORIGINS=http/)
  assert.ok(plan.content.includes('\r\nOTHER=keep\r\n'))
  const next = planTunnelOrigin(plan.content, plan.env, 'https://another-address.trycloudflare.com')
  assert.ok(next.env.ALLOWED_ORIGINS.endsWith(origin + ',https://another-address.trycloudflare.com'))
  const unchanged = planTunnelOrigin(plan.content, plan.env, origin)
  assert.equal(unchanged.reload, false)
  assert.equal(unchanged.content, plan.content)
  assert.throws(() => planTunnelOrigin(content, { REQUIRE_CSRF: 'false' }, origin), /TUNNEL_CSRF/)
  assert.throws(() => planTunnelOrigin(content, { ALLOWED_ORIGINS: '*' }, origin), /Wildcard/)
})

test('only the exact active managed process set supplies the web port', () => fixture(async ({ root, runtime }) => {
  const id = 'recruit-' + createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 12)
  const env = { ...runtime.env, RESUME_UPLOAD_RELAX_ORIGIN: 'false' }
  const processes = ['api', 'worker', 'web'].map(role => ({ name: id + '-' + role, pid: 123,
    pm2_env: { env, status: 'online', RUNTIME_ROLE: role, RUNTIME_INSTANCE_ID: id,
      pm_exec_path: join(runtime.active.directory, 'scripts/runtime-role.mjs') } }))
  const unrelated = { name: 'other-project-web', pid: 999, pm2_env: { env: { WEB_PORT: '5174' } } }
  const base = { RUNTIME_HOME: root }
  assert.equal(selectTunnelRuntime(root, base, runtime.active, [...processes, unrelated]).ports.web, 5175)
  assert.throws(() => selectTunnelRuntime(root, base, runtime.active, processes.slice(1)), /TUNNEL_RUNTIME/)
  delete processes[2].pid
  assert.throws(() => selectTunnelRuntime(root, base, runtime.active, processes), /TUNNEL_IDENTITY/)
  processes[2].pid = 123
  processes[2].pm2_env.pm_exec_path = join(root, 'other-project.mjs')
  assert.throws(() => selectTunnelRuntime(root, base, runtime.active, processes), /TUNNEL_IDENTITY/)
  processes[2].pm2_env.pm_exec_path = join(runtime.active.directory, 'scripts/runtime-role.mjs')
  processes[2].pm2_env.env = { ...env, ALLOWED_ORIGINS: 'https://different.example.test' }
  assert.throws(() => selectTunnelRuntime(root, base, runtime.active, processes), /TUNNEL_RUNTIME_CONFIG/)
}))

test('sync preserves active release and runtime overrides and commits only after write checks', () => fixture(async ({ root, profile, content, runtime }) => {
  const calls = []
  const result = await synchronizeTunnelOrigin(root, runtime, origin, {
    identity: async () => calls.push('identity'),
    manage: async (action, options) => {
      calls.push(action)
      assert.equal(await readFile(profile, 'utf8'), content)
      assert.equal(options.env.AUTH_MFA_ENCRYPTION_KEY, 'preserved-key')
      if (action === 'doctor') assert.deepEqual(options.args, ['--release', runtime.active.directory])
      if (action === 'start') {
        assert.deepEqual(options.args, ['--release', runtime.active.directory])
        assert.ok(options.env.ALLOWED_ORIGINS.endsWith(origin))
        assert.equal(options.env.RESUME_UPLOAD_RELAX_ORIGIN, 'false')
      }
      return { ready: true }
    },
    verify: async () => { calls.push('writes'); assert.equal(await readFile(profile, 'utf8'), content) },
  })
  assert.deepEqual(calls, ['identity', 'doctor', 'stop', 'start', 'writes'])
  assert.equal(result.ready, true)
  assert.equal(result.checkedWritePaths, 7)
  const updated = await readFile(profile, 'utf8')
  assert.ok(updated.includes(origin))
  assert.ok(updated.includes('DATABASE_URL=do-not-change\r\n'))
  assert.deepEqual(await readdir(root), ['selected.env'])
  runtime.env = planTunnelOrigin(content, runtime.env, origin).env
  const reused = await synchronizeTunnelOrigin(root, runtime, origin, {
    identity: async () => {}, verify: async () => {}, manage: async () => assert.fail('unnecessary restart'),
  })
  assert.equal(reused.reloaded, false)
  assert.equal(await readFile(profile, 'utf8'), updated)
}))

test('identity and preflight failures never stop services or change the profile', () => fixture(async ({ root, runtime, profile, content }) => {
  let actions = []
  await assert.rejects(synchronizeTunnelOrigin(root, runtime, origin, {
    identity: async () => { throw new Error('wrong identity') }, manage: async action => actions.push(action),
  }), /wrong identity/)
  assert.deepEqual(actions, [])
  await assert.rejects(synchronizeTunnelOrigin(root, runtime, origin, {
    identity: async () => {}, manage: async action => { actions.push(action); return { ready: false } },
  }), /TUNNEL_PRECHECK/)
  assert.deepEqual(actions, ['doctor'])
  assert.equal(await readFile(profile, 'utf8'), content)
  assert.deepEqual(await readdir(root), ['selected.env'])
}))

for (const failure of ['start', 'writes']) {
  test('failed ' + failure + ' restores the original configuration and does not publish the profile', () => fixture(async ({ root, runtime, profile, content }) => {
    const calls = []
    await assert.rejects(synchronizeTunnelOrigin(root, runtime, origin, {
      identity: async () => {},
      manage: async (action, { env }) => {
        calls.push([action, env])
        if (action === 'start' && env !== runtime.env && failure === 'start') return { ready: false }
        return { ready: true }
      },
      verify: async () => { if (failure === 'writes') throw new Error('write check failed') },
    }), failure === 'start' ? /TUNNEL_RELOAD/ : /write check failed/)
    assert.deepEqual(calls.map(([action]) => action), ['doctor', 'stop', 'start', 'stop', 'start'])
    assert.equal(calls.at(-1)[1], runtime.env)
    assert.equal(await readFile(profile, 'utf8'), content)
    assert.deepEqual(await readdir(root), ['selected.env'])
  }))
}

test('concurrent profile edits are preserved and the runtime is rolled back', () => fixture(async ({ root, runtime, profile }) => {
  const edited = 'OTHER=concurrent-edit\n'
  const calls = []
  await assert.rejects(synchronizeTunnelOrigin(root, runtime, origin, {
    identity: async () => {}, manage: async action => { calls.push(action); return { ready: true } },
    verify: async () => writeFile(profile, edited),
  }), /TUNNEL_PROFILE_CHANGED/)
  assert.equal(await readFile(profile, 'utf8'), edited)
  assert.deepEqual(calls, ['doctor', 'stop', 'start', 'stop', 'start'])
}))

test('a concurrent synchronization lock is never removed or overridden', () => fixture(async ({ root, runtime, profile, content }) => {
  const lock = join(root, 'tunnel-origin.lock')
  await writeFile(lock, 'other-owner')
  await assert.rejects(synchronizeTunnelOrigin(root, runtime, origin), { code: 'EEXIST' })
  assert.equal(await readFile(lock, 'utf8'), 'other-owner')
  assert.equal(await readFile(profile, 'utf8'), content)
}))

test('a missing selected profile leaves no synchronization lock', () => fixture(async ({ root, runtime }) => {
  runtime.env.ENV_FILE_PATH = join(root, 'missing.env')
  await assert.rejects(synchronizeTunnelOrigin(root, runtime, origin), { code: 'ENOENT' })
  assert.deepEqual(await readdir(root), ['selected.env'])
}))

test('a failed recovery cannot be reported as a ready tunnel', () => fixture(async ({ root, runtime, profile, content }) => {
  await assert.rejects(synchronizeTunnelOrigin(root, runtime, origin, {
    identity: async () => {}, verify: async () => assert.fail('startup should not reach probes'),
    manage: async action => ({ ready: action !== 'start' }),
  }), /TUNNEL_ROLLBACK_FAILED/)
  assert.equal(await readFile(profile, 'utf8'), content)
  assert.deepEqual(await readdir(root), ['selected.env'])
}))

test('public and local identity probes refuse another release without following redirects', async () => {
  const runtime = { ports: { web: 5175 }, active: { id: 'sealed-v1' } }
  const seen = []
  await verifyTunnelIdentity(origin, runtime, async (url, options) => {
    seen.push(url); assert.equal(options.redirect, 'error')
    return Response.json({ data: { service: 'smartrecruit-pro-api', version: 'sealed-v1' } })
  })
  assert.deepEqual(seen, ['http://127.0.0.1:5175/api/v1/health', origin + '/api/v1/health'])
  await assert.rejects(verifyTunnelIdentity(origin, runtime, async () => Response.json({ data: { service: 'other-app' } })), /TUNNEL_IDENTITY/)
})

test('same-origin capability requires both local and public endpoints to report it', async () => {
  const runtime = { ports: { web: 5175 }, active: { id: 'sealed-v1' } }
  for (const values of [[true, true], [true, false], [false, true], [false, false]]) {
    let index = 0
    const capability = await verifyTunnelIdentity(origin, runtime, async () => Response.json({ data: {
      service: 'smartrecruit-pro-api', version: 'sealed-v1', originPolicy: values[index++] ? 'same-origin' : undefined,
    } }))
    assert.equal(capability.originPolicy, values.every(Boolean) ? 'same-origin' : undefined)
  }
})

test('every resume lifecycle write is probed without credentials and security failures block readiness', async () => {
  const seen = []
  await verifyTunnelWrites(origin, async (url, options) => {
    seen.push(url)
    assert.equal(options.redirect, 'error')
    assert.equal(options.method, 'POST')
    assert.equal(options.body, '{}')
    assert.ok(!options.headers.cookie?.includes('session'))
    const trusted = options.headers.origin === origin, csrf = !!options.headers['x-csrf-token']
    const code = !trusted ? 'CSRF_ORIGIN_MISMATCH' : !csrf ? 'CSRF_TOKEN_INVALID' : 'AUTHENTICATION_REQUIRED'
    return Response.json({ error: { code } }, { status: trusted && csrf ? 401 : 403 })
  })
  assert.equal(seen.length, 21)
  for (const path of tunnelWritePaths) assert.equal(seen.filter(url => url === origin + path).length, 3)
  await assert.rejects(verifyTunnelWrites(origin, async () => Response.json({ ok: true })), /TUNNEL_WRITE_CHECK/)
})
