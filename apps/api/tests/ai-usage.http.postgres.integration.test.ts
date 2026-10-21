import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadDatabaseConfig } from '../src/db/config.js'
test('AI usage HTTP lifecycle uses real isolated PG and local model stub without skips',{timeout:100000},t=>{
 assert.equal(process.env.PGPORT,'15433');assert.equal(process.env.PGDATABASE,'smartrecruit_test')
 const cfg=loadDatabaseConfig();assert.equal(cfg.target,'127.0.0.1:15433/smartrecruit_test')
 const script=fileURLToPath(new URL('../../../../scripts/verify-ai-usage-http.mjs',import.meta.url))
 const result=spawnSync(process.execPath,[script],{env:{...process.env,AI_USAGE_TEST_DATABASE:JSON.stringify(cfg)},encoding:'utf8',timeout:95000,windowsHide:true})
 assert.equal(result.status,0,'HTTP usage verification failed: '+result.stdout+'\n'+result.stderr)
 assert.match(result.stdout,/32 passed \/ 0 failed \/ 0 skipped/);t.diagnostic(result.stdout.trim())
})
