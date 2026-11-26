import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import type { Pool } from 'pg'
import { discoverWorkerTenants } from '../src/db/tenant-discovery.js'
import { HealthStateStore, createHealthServer } from '../src/health.js'
import { loadConfig } from '../src/config.js'

const id = randomUUID(), schema = 'company_' + id.replaceAll('-', '')
const ready = { organization_id: id, schema_name: schema, status: 'ready', structure_ready: true, service_available: true }
function database(rows: object[]): Pick<Pool, 'query'> {
  return { query: async (sql: string) => {
    assert.match(sql, /LEFT JOIN public.organization_schemas/)
    assert.match(sql, /WHERE o.status='active'/)
    return { rows }
  } } as unknown as Pick<Pool, 'query'>
}

test('公司发现返回结构有效且业务可用的公司，暂停业务的公司不领取', async () => {
  assert.deepEqual(await discoverWorkerTenants(database([ready])), [{ organization_id: id, schema_name: schema }])
  assert.deepEqual(await discoverWorkerTenants(database([{ ...ready, service_available: false }])), [])
  assert.deepEqual(await discoverWorkerTenants(database([])), [])
})

for (const change of [{ schema_name: null }, { status: 'provisioning' }, { structure_ready: false }, { schema_name: 'public' }]) {
  test('公司发现拒绝损坏结构而不静默跳过：' + Object.keys(change)[0] + '=' + Object.values(change)[0], async () => {
    await assert.rejects(discoverWorkerTenants(database([{ ...ready, ...change }])), /公司 Schema 未就绪/)
  })
}

test('运行期降级保留存活探针，但就绪探针返回503，恢复后再返回200', async () => {
  const state = new HealthStateStore(loadConfig({ WORKER_HEALTH_PORT: '0' }, 'test-host'))
  const server = createHealthServer(state)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = 'http://127.0.0.1:' + address.port
  try {
    state.setState('degraded'); state.setDependency('postgres', 'error')
    const probe = await fetch(base + '/ready')
    assert.equal(probe.status, 503)
    assert.equal((await probe.json()).externalDependencies.postgres, 'error')
    assert.equal((await fetch(base + '/health')).status, 200)
    state.setState('ready'); state.setDependency('postgres', 'ok')
    assert.equal((await fetch(base + '/ready')).status, 200)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
