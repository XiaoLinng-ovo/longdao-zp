import assert from 'node:assert/strict'
import { loadDatabaseConfig } from '../../src/db/config.js'

export function assertDisposableTestDatabase(): void {
  const config = loadDatabaseConfig()
  const url = config.connectionString ? new URL(config.connectionString) : undefined
  const host = url?.hostname ?? config.host
  const database = url ? decodeURIComponent(url.pathname.slice(1)) : config.database
  assert.ok(['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(host)), '测试只能连接本机')
  assert.match(String(database), /^reliability_verify_[a-f0-9]{32}$/, '测试必须使用随机临时数据库')
  assert.equal(database, process.env.RELIABILITY_TEST_DATABASE, '必须由隔离测试脚本显式指定数据库')
}
