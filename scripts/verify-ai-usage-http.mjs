import { randomUUID, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import assert from 'node:assert/strict'
assert.ok(process.env.AI_USAGE_TEST_DATABASE,'Explicit isolated database is required')
const cfg=JSON.parse(process.env.AI_USAGE_TEST_DATABASE)
assert.equal(cfg.host,'127.0.0.1');assert.equal(cfg.port,15433);assert.equal(cfg.database,'smartrecruit_test')
for(const key of Object.keys(process.env)) if(/^(PG|DATABASE_URL|S3_|OPENAI_|AI_|DINGTALK_|AUTH_|RECRUITING_|ENV_FILE_PATH|POSTGRES_INTEGRATION_SKIP)/.test(key)) delete process.env[key]
Object.assign(process.env,{NODE_ENV:'development',PGHOST:cfg.host,PGPORT:String(cfg.port),PGUSER:cfg.user,PGPASSWORD:cfg.password,PGDATABASE:cfg.database,ALLOWED_ORIGINS:'http://127.0.0.1:5174',REQUIRE_CSRF:'true',AUTH_DEV_BOOTSTRAP:'false',ALLOW_DEV_BOOTSTRAP_AUTH:'false',QUESTION_SHEET_POLL:'off',DINGTALK_APPROVAL_RECONCILE:'off',AI_CONFIG_ENCRYPTION_KEY:randomBytes(32).toString('base64')})
const {createDatabasePool}=await import('../apps/api/dist/src/db/connection.js')
const {loadDatabaseConfig}=await import('../apps/api/dist/src/db/config.js')
assert.equal(loadDatabaseConfig().target,'127.0.0.1:15433/smartrecruit_test')
const {createHttpServer}=await import('../apps/api/dist/src/server.js')
const {PostgresSessionRepository}=await import('../apps/api/dist/src/auth/session-repository.js')
const {EnterpriseAiStore}=await import('../packages/enterprise-ai/index.js')
const pool=createDatabasePool(),sessions=new PostgresSessionRepository(pool),ai=new EnterpriseAiStore(pool)
const [owner,member,outsider]=Array.from({length:3},()=>randomUUID()),users=[owner,member,outsider],org=randomUUID(),other=randomUUID(),job=randomUUID(),otherJob=randomUUID(),csrf=randomBytes(24).toString('hex')
let calls=0,mode='ok',count=0
const provider=createServer(async(req,res)=>{
 const chunks=[];for await(const c of req)chunks.push(c)
 const body=JSON.parse(Buffer.concat(chunks).toString());calls++
 assert.equal(req.headers.authorization,'Bearer isolated-fixture-key')
 if(mode==='reject'){res.writeHead(429,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'fixture rejection'}}));return}
 res.writeHead(200,{'content-type':'application/json'})
 const value=mode==='invalid'?'not-json':JSON.stringify({summary:'测试摘要',responsibilities:['测试职责'],requirements:[{label:'测试要求',description:'测试',required:true}],skills:['测试技能'],content:'测试 JD 内容'})
 res.end(JSON.stringify({choices:[{message:{content:value}}]}))
})
const server=createHttpServer({appName:'ai-usage-http-fixture',appVersion:'1',host:'127.0.0.1',port:0,nodeEnv:'development',requestIdHeader:'x-request-id'})
const timer=setTimeout(()=>{console.error('AI usage HTTP verification timeout');process.exit(1)},90000);timer.unref()
const tokens=new Map();let base
const request=async(path,actor=owner,method='GET',body,key,workspace=org,extraHeaders={})=>{
 const headers={'content-type':'application/json',origin:'http://127.0.0.1:5174','x-csrf-token':csrf,'x-workspace-id':workspace}
 if(actor)headers.cookie='smartrecruit_session='+tokens.get(actor)+'; smartrecruit_csrf='+csrf
 if(key)headers['idempotency-key']=key
 Object.assign(headers,extraHeaders)
 const response=await fetch(base+path,{method,headers,...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,body:await response.json()}
}
const check=(label,result,status,code)=>{assert.equal(result.status,status,label);if(code)assert.equal(result.body.error?.code,code,label);count++;console.log('PASS '+label+': HTTP '+status+(code?' '+code:''))}
const task=async(key)=>(await pool.query('SELECT id,state,settled_units,result,request_id,duration_ms,failure_category FROM ai_usage_tasks WHERE organization_id=$1 AND idempotency_key=$2',[org,key])).rows[0]
try{
 await new Promise(r=>provider.listen(0,'127.0.0.1',r));await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port
 for(const id of users)await pool.query("INSERT INTO users(id,email,display_name,is_active) VALUES($1,$2,'usage HTTP fixture',true)",[id,id+'@example.invalid'])
 await pool.query("INSERT INTO organizations(id,name,kind) VALUES($1,'usage HTTP fixture','test'),($2,'other usage HTTP fixture','test')",[org,other])
 await pool.query("INSERT INTO organization_members(organization_id,user_id,role,business_role) VALUES($1,$2,'owner','recruiter'),($1,$3,'member','recruiter'),($4,$5,'owner','recruiter')",[org,owner,member,other,outsider])
 await pool.query("INSERT INTO platform_operators(user_id,role) VALUES($1,'admin')",[outsider])
 for(const [id,o] of [[job,org],[otherJob,other]])await pool.query("INSERT INTO jobs(id,organization_id,job_no,title,headcount) VALUES($1,$2,$3,'独立用量测试岗位',1)",[id,o,'USAGE-'+id])
 for(const id of users){const session=await sessions.createSession({id,name:'fixture',email:id+'@example.invalid',role:'recruiter',departmentId:'',workspaceId:id===outsider?other:org});tokens.set(id,session.token)}
 check('anonymous usage denied',await request('/api/v1/admin/ai-usage',null),401,'AUTHENTICATION_REQUIRED')
 check('member usage denied',await request('/api/v1/admin/ai-usage',member),403,'WORKSPACE_ADMIN_REQUIRED')
 check('stale enterprise header denied',await request('/api/v1/admin/ai-usage',owner,'GET',undefined,undefined,other),409,'WORKSPACE_CONTEXT_CHANGED')
 check('owner usage allowed without platform grant',await request('/api/v1/admin/ai-usage'),200)
 const fallback=await request('/api/v1/jobs/'+job+'/spec/generate',owner,'POST',{})
 check('local fallback remains available',fallback,200);assert.equal(fallback.body.data.spec.generatedBy,'local_fallback');assert.equal((await pool.query('SELECT count(*)::int AS n FROM ai_usage_tasks WHERE organization_id=$1',[org])).rows[0].n,0)
 await ai.save(org,{OPENAI_BASE_URL:'http://127.0.0.1:'+provider.address().port+'/v1',OPENAI_API_KEY:'isolated-fixture-key',OPENAI_MODEL:'isolated-model'},owner)
 const specKey=randomUUID(),jdKey=randomUUID()
 check('spec generation succeeds',await request('/api/v1/jobs/'+job+'/spec/generate',owner,'POST',{prompt:'测试'},specKey),200);assert.equal((await task(specKey)).state,'settled')
 const versions=(await pool.query('SELECT count(*)::int AS n FROM job_spec_versions WHERE job_id=$1',[job])).rows[0].n
 check('durable spec replay succeeds',await request('/api/v1/jobs/'+job+'/spec/generate',owner,'POST',{prompt:'测试'},specKey),200);assert.equal(calls,1);assert.equal((await pool.query('SELECT count(*)::int AS n FROM job_spec_versions WHERE job_id=$1',[job])).rows[0].n,versions)
 check('same key different input rejected',await request('/api/v1/jobs/'+job+'/spec/generate',owner,'POST',{prompt:'不同'},specKey),409,'USAGE_KEY_CONFLICT')
 check('JD generation succeeds',await request('/api/v1/jobs/'+job+'/jd/generate',owner,'POST',{},jdKey),200);assert.equal((await task(jdKey)).state,'settled');assert.equal(calls,2)
 mode='reject';const rejectedKey=randomUUID()
 check('provider rejection returned',await request('/api/v1/jobs/'+job+'/jd/generate',owner,'POST',{},rejectedKey),502,'MODEL_HTTP_ERROR');assert.equal((await task(rejectedKey)).state,'released')
 check('rejected key cannot automatically retry',await request('/api/v1/jobs/'+job+'/jd/generate',owner,'POST',{},rejectedKey),409,'AI_USAGE_TASK_EXISTS');assert.equal(calls,3)
 mode='invalid';const uncertainKey=randomUUID()
 check('invalid provider output returned',await request('/api/v1/jobs/'+job+'/jd/generate',owner,'POST',{},uncertainKey),502,'MODEL_RESPONSE_INVALID');assert.equal((await task(uncertainKey)).state,'uncertain');assert.equal(calls,4)
 const report=await request('/api/v1/admin/ai-usage');check('metadata report reads counted lifecycle',report,200)
 assert.deepEqual(report.body.data.summary,{total:4,settled:2,released:1,reserved:0,reconciliation:1});assert.equal(report.body.data.chargeAmount,null);assert.ok(!JSON.stringify(report).includes('isolated-fixture-key'));assert.ok(report.body.data.items.every(i=>!('result' in i)&&!('fingerprint' in i)))
 const successTask=await task(specKey), failedTask=await task(uncertainKey)
 assert.ok(successTask.request_id);assert.ok(successTask.duration_ms>=0);assert.equal((await task(rejectedKey)).failure_category,'upstream_rejected');assert.equal(failedTask.failure_category,'invalid_response')
 check('diagnostics expose request and duration metadata',report,200)
 const filtered=await request('/api/v1/admin/ai-usage?operation=jd&state=uncertain&reviewOnly=true');check('filter returns only uncertain JD with whole enterprise summary',filtered,200);assert.equal(filtered.body.data.filteredTotal,1);assert.equal(filtered.body.data.items[0].id,failedTask.id);assert.equal(filtered.body.data.summary.total,4)
 check('invalid timestamp rejected',await request('/api/v1/admin/ai-usage?from=2026-02-30T00:00:00.000Z'),400,'VALIDATION_ERROR')
 check('duplicate query rejected',await request('/api/v1/admin/ai-usage?state=settled&state=uncertain'),400,'VALIDATION_ERROR')
 const reviewPath='/api/v1/admin/ai-usage/'+failedTask.id+'/reviews',reviewBody={key:randomUUID(),outcome:'awaiting_provider',note:'隔离测试：等待服务商证据'}
 check('enterprise owner accesses review history without platform role',await request(reviewPath),200)
 check('member denied note write',await request(reviewPath,member,'POST',reviewBody),403,'WORKSPACE_ADMIN_REQUIRED')
 check('review write requires trusted Origin',await request(reviewPath,owner,'POST',reviewBody,undefined,org,{origin:'https://untrusted.invalid'}),403,'CSRF_ORIGIN_MISMATCH')
 check('review write requires CSRF',await request(reviewPath,owner,'POST',reviewBody,undefined,org,{'x-csrf-token':'wrong-token'}),403,'CSRF_TOKEN_INVALID')
 check('cross enterprise note denied',await request(reviewPath,outsider,'POST',reviewBody,undefined,other),404,'NOT_FOUND')
 check('malformed note UUID is a validation error',await request('/api/v1/admin/ai-usage/------------------------------------/reviews'),400,'VALIDATION_ERROR')
 const saved=await request(reviewPath,owner,'POST',reviewBody,reviewBody.key);check('note saved with no model dispatch',saved,200);assert.equal(saved.body.data.replayed,false)
 const replay=await request(reviewPath,owner,'POST',reviewBody,reviewBody.key);check('durable note replay',replay,200);assert.equal(replay.body.data.replayed,true);assert.equal(replay.body.data.item.id,saved.body.data.item.id)
 check('same key changed note rejected',await request(reviewPath,owner,'POST',{...reviewBody,note:'其他证据'},reviewBody.key),409,'REVIEW_KEY_CONFLICT')
 check('settled call cannot acquire anomaly note',await request('/api/v1/admin/ai-usage/'+successTask.id+'/reviews',owner,'POST',{...reviewBody,key:randomUUID()}),409,'AI_REVIEW_NOT_REQUIRED')
 const history=await request(reviewPath);check('history reads one persisted note',history,200);assert.equal(history.body.data.items.length,1)
 const afterNote=await task(uncertainKey);assert.equal(afterNote.state,'uncertain');assert.equal(afterNote.settled_units,0);assert.equal(afterNote.result,null);assert.equal(calls,4)
 check('foreign job denied before provider dispatch',await request('/api/v1/jobs/'+otherJob+'/jd/generate',owner,'POST',{},randomUUID()),404);assert.equal(calls,4)
 const foreignReport=await request('/api/v1/admin/ai-usage',outsider,'GET',undefined,undefined,other);check('other enterprise sees only its empty usage',foreignReport,200);assert.equal(foreignReport.body.data.summary.total,0)
 await pool.query("UPDATE organization_members SET role='member',business_role='interviewer' WHERE organization_id=$1 AND user_id=$2",[org,owner])
 check('role downgrade blocks previously saved note replay',await request(reviewPath,owner,'POST',reviewBody,reviewBody.key),403,'WORKSPACE_ADMIN_REQUIRED')
 check('role downgrade blocks even previously settled task replay',await request('/api/v1/jobs/'+job+'/spec/generate',owner,'POST',{prompt:'测试'},specKey),403);assert.equal(calls,4)
 console.log('AI usage HTTP verification: '+count+' passed / 0 failed / 0 skipped; isolated PG + local model stub, no customer model invoked')
}finally{
 await new Promise(r=>server.close(r));await new Promise(r=>provider.close(r))
 await pool.query('DELETE FROM ai_usage_tasks WHERE organization_id=$1',[org])
 await pool.query('DELETE FROM jobs WHERE organization_id=ANY($1::uuid[])',[[org,other]])
 await pool.query('DELETE FROM workflow_events WHERE organization_id=ANY($1::uuid[])',[[org,other]])
 await pool.query('DELETE FROM audit_logs WHERE organization_id=ANY($1::uuid[])',[[org,other]])
 await pool.query('DELETE FROM enterprise_ai_settings WHERE organization_id=$1',[org])
 await pool.query('DELETE FROM sessions WHERE user_id=ANY($1::uuid[])',[users])
 await pool.query('DELETE FROM organization_members WHERE organization_id=ANY($1::uuid[])',[[org,other]])
 await pool.query('DELETE FROM organizations WHERE id=ANY($1::uuid[])',[[org,other]])
 await pool.query('DELETE FROM platform_operators WHERE user_id=ANY($1::uuid[])',[users])
 await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[users]);await pool.end();clearTimeout(timer)
}
process.exit(0)
