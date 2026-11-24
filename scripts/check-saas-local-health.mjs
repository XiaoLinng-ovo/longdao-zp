// Read-only local operations check. Never outputs credentials or customer records.
import '../apps/api/dist/src/env.js'
import {createDatabasePool} from '../apps/api/dist/src/db/connection.js'
import {loadDatabaseConfig} from '../apps/api/dist/src/db/config.js'
const checks=[]
async function endpoint(name,url,expected) {
 try {const response=await fetch(url,{signal:AbortSignal.timeout(5000),redirect:'error'});checks.push({name,ok:response.status===expected,status:response.status,expected})}
 catch {checks.push({name,ok:false,error:'unreachable_or_timeout'})}
}
await Promise.all([endpoint('api_auth','http://127.0.0.1:3100/api/v1/me',401),endpoint('worker_ready','http://127.0.0.1:4001/ready',200),endpoint('web','http://127.0.0.1:5174',200)])
let pool
try {
 const cfg=loadDatabaseConfig()
 if(cfg.target!=='127.0.0.1:5432/smartrecruit')throw Error('Unexpected local target')
 pool=createDatabasePool(cfg)
 const db=await pool.connect()
 try {
  await db.query('BEGIN READ ONLY');await db.query("SET LOCAL statement_timeout='5s'")
  const migrations=(await db.query("SELECT version FROM schema_migrations WHERE version IN ('0033','0034','0035','0036','0037','0038') ORDER BY version")).rows.map(r=>r.version)
  checks.push({name:'database_schema',ok:migrations.length===6,migrations})
  const row=(await db.query(
   "SELECT (SELECT count(*)::int FROM ai_usage_tasks WHERE state='uncertain' OR (state='reserved' AND created_at < now()-interval '10 minutes')) AS ai_review, (SELECT count(*)::int FROM billing_sandbox_orders WHERE status='review') AS sandbox_review, (SELECT count(*)::int FROM billing_sandbox_orders WHERE status IN ('pending','failed') AND expires_at<=now()) AS sandbox_expired_pending")).rows[0]
  checks.push({name:'reconciliation_counts',ok:true,...row})
  await db.query('ROLLBACK')
 } finally {db.release()}
} catch {checks.push({name:'database',ok:false,error:'database_unavailable_or_schema_not_ready'})}
finally {if(pool)await pool.end()}
const ok=checks.every(c=>c.ok)
const reconcile=checks.find(c=>c.name==='reconciliation_counts')
const attentionRequired=!!reconcile && (reconcile.ai_review>0 || reconcile.sandbox_review>0 || reconcile.sandbox_expired_pending>0)
console.log(JSON.stringify({checkedAt:new Date().toISOString(),scope:'local_read_only',ok,attentionRequired,checks},null,2))
process.exitCode=ok?0:1
