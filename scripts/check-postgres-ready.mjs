import '../apps/api/dist/src/env.js'
import { createDatabasePool } from '../apps/api/dist/src/db/index.js'
import { checkReleaseReadiness } from '../apps/api/dist/src/db/release-readiness.js'

let pool
try {
  pool = createDatabasePool()
  await checkReleaseReadiness(pool)
  console.log('数据库只读发布检查通过；未执行迁移或写入')
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally { await pool?.end() }
