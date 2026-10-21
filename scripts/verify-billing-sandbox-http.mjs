import { randomUUID, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import assert from 'node:assert/strict'
assert.ok(process.env.BILLING_SANDBOX_TEST_DATABASE,'Explicit isolated database is required')
const cfg=JSON.parse(process.env.BILLING_SANDBOX_TEST_DATABASE)
assert.equal(cfg.host,'127.0.0.1');assert.equal(cfg.port,15433);assert.equal(cfg.database,'smartrecruit_test')
for(const key of Object.keys(process.env)) if(/^(PG|DATABASE_URL|S3_|OPENAI_|AI_|DINGTALK_|AUTH_|RECRUITING_|ENV_FILE_PATH|POSTGRES_INTEGRATION_SKIP)/.test(key)) delete process.env[key]
Object.assign(process.env,{NODE_ENV:'development',PGHOST:cfg.host,PGPORT:String(cfg.port),PGUSER:cfg.user,PGPASSWORD:cfg.password,PGDATABASE:cfg.database,ALLOWED_ORIGINS:'http://127.0.0.1:5174',REQUIRE_CSRF:'true',AUTH_DEV_BOOTSTRAP:'false',ALLOW_DEV_BOOTSTRAP_AUTH:'false',QUESTION_SHEET_POLL:'off',DINGTALK_APPROVAL_RECONCILE:'off',AI_CONFIG_ENCRYPTION_KEY:randomBytes(32).toString('base64')})
const {createDatabasePool}=await import('../apps/api/dist/src/db/connection.js')
const {loadDatabaseConfig}=await import('../apps/api/dist/src/db/config.js')
assert.equal(loadDatabaseConfig().target,'127.0.0.1:15433/smartrecruit_test')
const {createHttpServer}=await import('../apps/api/dist/src/server.js')
const {PostgresSessionRepository}=await import('../apps/api/dist/src/auth/session-repository.js')

const pool=createDatabasePool(),sessions=new PostgresSessionRepository(pool)
const owner=randomUUID(),member=randomUUID(),outsider=randomUUID(),org=randomUUID(),other=randomUUID(),users=[owner,member,outsider],csrf=randomBytes(24).toString('hex')
const server=createHttpServer({appName:'billing-sandbox-http',appVersion:'1',host:'127.0.0.1',port:0,nodeEnv:'development',requestIdHeader:'x-request-id'})
const timer=setTimeout(()=>{console.error('Billing HTTP verification timeout');process.exit(1)},90000);timer.unref()
const tokens=new Map();let base,count=0
const prefix='/api/v1/admin/billing-sandbox'
const request=async(path=prefix,actor=owner,method='GET',body,key,workspace=org,extra={})=>{
 const headers={'content-type':'application/json',origin:'http://127.0.0.1:5174','x-csrf-token':csrf,'x-workspace-id':workspace,...extra}
 if(actor)headers.cookie='smartrecruit_session='+tokens.get(actor)+'; smartrecruit_csrf='+csrf
 if(key)headers['idempotency-key']=key
 const response=await fetch(base+path,{method,headers,...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,body:await response.json()}
}
const check=(label,result,status,code)=>{assert.equal(result.status,status,label+' '+JSON.stringify(result.body));if(code)assert.equal(result.body.error?.code,code,label);count++;console.log('PASS '+label+': HTTP '+status)}
try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port
 for(const id of users)await pool.query("INSERT INTO users(id,email,display_name,is_active) VALUES($1,$2,'sandbox HTTP fixture',true)",[id,id+'@example.invalid'])
 await pool.query("INSERT INTO organizations(id,name,kind) VALUES($1,'sandbox HTTP fixture','test'),($2,'other sandbox HTTP fixture','test')",[org,other])
 await pool.query("INSERT INTO organization_members(organization_id,user_id,role,business_role) VALUES($1,$2,'owner','recruiter'),($1,$3,'member','recruiter'),($4,$5,'owner','recruiter')",[org,owner,member,other,outsider])
 for(const id of users){const session=await sessions.createSession({id,name:'fixture',email:id+'@example.invalid',role:'recruiter',departmentId:'',workspaceId:id===outsider?other:org});tokens.set(id,session.token)}
 const realBefore=(await pool.query('SELECT plan_version_id,entitlement_version,seat_usage,job_usage,service_status FROM organizations WHERE id=$1',[org])).rows[0]
 check('anonymous access denied',await request(prefix,null),401)
 check('ordinary member denied',await request(prefix,member),403,'WORKSPACE_ADMIN_REQUIRED')
 check('stale workspace denied',await request(prefix,owner,'GET',undefined,undefined,other),409,'WORKSPACE_CONTEXT_CHANGED')
 check('enterprise admin has catalog without platform grants',await request(),200)
 const key=randomUUID(),input={productCode:'team_test_v1',channel:'mock_wechat',expectedVersion:1}
 check('bad origin blocked',await request(prefix+'/orders',owner,'POST',input,key,org,{origin:'http://untrusted.invalid'}),403,'CSRF_ORIGIN_MISMATCH')
 check('bad CSRF blocked',await request(prefix+'/orders',owner,'POST',input,key,org,{'x-csrf-token':'wrong'}),403,'CSRF_TOKEN_INVALID')
 check('client price rejected',await request(prefix+'/orders',owner,'POST',{...input,amountFen:1},key),400,'INVALID_ORDER')
 check('real payment channel blocked',await request(prefix+'/orders',owner,'POST',{...input,channel:'wechat'},key),400,'LIVE_PAYMENT_DISABLED')
 const created=await request(prefix+'/orders',owner,'POST',input,key);check('create immutable simulation order',created,200);const id=created.body.data.id
 const replay=await request(prefix+'/orders',owner,'POST',input,key);check('durable order replay',replay,200);assert.equal(replay.body.data.id,id)
 check('key input conflict',await request(prefix+'/orders',owner,'POST',{...input,productCode:'growth_test_v1'},key),409,'ORDER_KEY_CONFLICT')
 const action=prefix+'/orders/'+id+'/simulate'
 check('foreign enterprise cannot act on order',await request(action,outsider,'POST',{kind:'success'},undefined,other),404,'ORDER_NOT_FOUND')
 check('invalid simulation action rejected',await request(action,owner,'POST',{kind:'fake'}),400,'INVALID_ACTION')
 check('array body rejected',await request(action,owner,'POST',[]),400,'VALIDATION_ERROR')
 const paid=await request(action,owner,'POST',{kind:'success'});check('simulated payment succeeds',paid,200);assert.equal(paid.body.data.order.status,'fulfilled')
 const duplicate=await request(action,owner,'POST',{kind:'success'});check('duplicate notification grants once',duplicate,200);assert.equal(duplicate.body.data.replayed,true)
 check('refund requires reason',await request(action,owner,'POST',{kind:'refund'}),400,'REFUND_REASON_REQUIRED')
 const refund=await request(action,owner,'POST',{kind:'refund',reason:'HTTP 测试退款'});check('full simulated refund',refund,200);assert.equal(refund.body.data.order.status,'refunded')
 const refundAgain=await request(action,owner,'POST',{kind:'refund',reason:'HTTP 测试退款'});check('refund replay is durable',refundAgain,200);assert.equal(refundAgain.body.data.replayed,true)
 const report=await request();check('simulation ledger after refund',report,200);assert.equal(report.body.data.total,1);assert.equal(report.body.data.entitlement.version,3);assert.equal(report.body.data.entitlement.activeOrderId,null)
 assert.deepEqual((await pool.query('SELECT plan_version_id,entitlement_version,seat_usage,job_usage,service_status FROM organizations WHERE id=$1',[org])).rows[0],realBefore)
 check('other enterprise has empty sandbox',await request(prefix,outsider,'GET',undefined,undefined,other),200)
 await pool.query("UPDATE organization_members SET role='member' WHERE organization_id=$1 AND user_id=$2",[org,owner])
 check('downgraded role cannot replay cached creation',await request(prefix+'/orders',owner,'POST',input,key),403,'WORKSPACE_ADMIN_REQUIRED')
 console.log('Billing sandbox HTTP verification: '+count+' passed / 0 failed / 0 skipped; no live payment and real entitlements unchanged')
}finally{
 await new Promise(r=>server.close(r))
 for(const table of ['billing_sandbox_events','billing_sandbox_entitlements','billing_sandbox_orders'])await pool.query('DELETE FROM '+table+' WHERE organization_id=ANY($1::uuid[])',[[org,other]])
 await pool.query('DELETE FROM sessions WHERE user_id=ANY($1::uuid[])',[users])
 await pool.query('DELETE FROM organization_members WHERE organization_id=ANY($1::uuid[])',[[org,other]])
 await pool.query('DELETE FROM organizations WHERE id=ANY($1::uuid[])',[[org,other]])
 await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[users]);await pool.end();clearTimeout(timer)
}
process.exit(0)
