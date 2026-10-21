import {resolve} from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
// Only the integration harness supplies this explicit isolated database target.
assert.ok(process.env.ENTITLEMENT_TEST_DATABASE, 'Dedicated test database configuration required');
const cfg=JSON.parse(process.env.ENTITLEMENT_TEST_DATABASE);
assert.equal(cfg.host,'127.0.0.1');assert.match(cfg.database,/test/i);
for(const key of Object.keys(process.env)) if(/^(PG|DATABASE_URL|S3_|OPENAI_|AI_|DINGTALK_|AUTH_|RECRUITING_|ENV_FILE_PATH|POSTGRES_INTEGRATION_SKIP)/.test(key)) delete process.env[key];
Object.assign(process.env,{NODE_ENV:'development',PGHOST:cfg.host,PGPORT:String(cfg.port),PGUSER:cfg.user,PGPASSWORD:cfg.password,PGDATABASE:cfg.database,DATABASE_URL:`postgresql://${encodeURIComponent(cfg.user)}:${encodeURIComponent(cfg.password)}@127.0.0.1:${cfg.port}/${encodeURIComponent(cfg.database)}`,ALLOWED_ORIGINS:'http://127.0.0.1:5174',REQUIRE_CSRF:'true',AUTH_DEV_BOOTSTRAP:'false',QUESTION_SHEET_POLL:'off',DINGTALK_APPROVAL_RECONCILE:'off',RECRUITING_QUARANTINE_ROOT:process.env.ENTITLEMENT_TEST_STORAGE});
const {createDatabasePool}=await import('../apps/api/dist/src/db/connection.js');
const {loadDatabaseConfig}=await import('../apps/api/dist/src/db/config.js');
assert.equal(loadDatabaseConfig().target,`127.0.0.1:${cfg.port}/${cfg.database}`);
const {createHttpServer}=await import('../apps/api/dist/src/server.js');
const {PostgresSessionRepository}=await import('../apps/api/dist/src/auth/session-repository.js');
const {EntitlementService}=await import('../apps/api/dist/src/platform/entitlements.js');
const {WorkspaceInvitationsService}=await import('../apps/api/dist/src/auth/workspace-invitations.js');
const pool=createDatabasePool(),sessions=new PostgresSessionRepository(pool),rights=new EntitlementService(pool),invites=new WorkspaceInvitationsService(pool);
const users=Array.from({length:5},()=>randomUUID()),[admin,viewer,owner,joiner,outsider]=users,org=randomUUID(),csrf=randomBytes(24).toString('hex');
const server=createHttpServer({appName:'step5-http-verification',appVersion:'1',host:'127.0.0.1',port:0,nodeEnv:'development',requestIdHeader:'x-request-id'});
const timer=setTimeout(()=>{console.error('HTTP verification timeout');process.exit(1)},90000);timer.unref();
let count=0;
try {
 for(const id of users) await pool.query("INSERT INTO users(id,email,display_name,is_active) VALUES($1,$2,'HTTP fixture',true)",[id,`${id}@example.invalid`]);
 await pool.query("INSERT INTO platform_operators(user_id,role) VALUES($1,'admin'),($2,'viewer')",[admin,viewer]);
 await pool.query("INSERT INTO organizations(id,name,kind,status) VALUES($1,'step5 isolated HTTP fixture','test','active')",[org]);
 await pool.query("INSERT INTO organization_members(organization_id,user_id,role,business_role) VALUES($1,$2,'owner','recruiter')",[org,owner]);
 const plan=await rights.publish(admin,{code:`http_${randomBytes(6).toString('hex')}`,version:1,name:'HTTP独立容量验收',seatLimit:1,jobLimit:1,reason:'独立测试库 HTTP 验证'});
 await rights.assign(admin,org,{planVersionId:plan.id,expectedVersion:1,reason:'独立测试分配'});
 const tokens=new Map();
 for(const id of users) {const result=await sessions.createSession({id,name:'Fixture',email:`${id}@example.invalid`,role:'admin',departmentId:'',...(id===owner?{workspaceId:org}: {})});tokens.set(id,result.token)}
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 const request=async(path,actor,method='GET',body,omit)=>{const headers={'content-type':'application/json',origin:'http://127.0.0.1:5174','x-csrf-token':csrf,'x-workspace-id':org};if(actor)headers.cookie=`smartrecruit_session=${tokens.get(actor)}; smartrecruit_csrf=${csrf}`;if(omit)delete headers[omit];const response=await fetch(base+path,{method,headers,...(body?{body:JSON.stringify(body)}:{})});return{status:response.status,body:await response.json()}};
 const check=(label,result,status,code)=>{assert.equal(result.status,status,label);if(code)assert.equal(result.body.error?.code,code,label);count++;console.log(`PASS ${label}: HTTP ${result.status}${code?' '+code:''}`)};
 check('anonymous cannot read plans',await request('/api/v1/platform/plans'),401,'AUTHENTICATION_REQUIRED');
 check('enterprise owner is not platform admin',await request('/api/v1/platform/plans',owner),403,'PLATFORM_PERMISSION_REQUIRED');
 check('platform viewer can read plans',await request('/api/v1/platform/plans',viewer),200);
 check('nonmember cannot read enterprise rights',await request(`/api/v1/workspaces/${org}/entitlements`,outsider),403,'WORKSPACE_MEMBER_REQUIRED');
 check('member reads assigned rights',await request(`/api/v1/workspaces/${org}/entitlements`,owner),200);
 const patch={planVersionId:plan.id,expectedVersion:2,reason:'HTTP 验证'};
 check('viewer cannot assign',await request(`/api/v1/platform/customers/${org}/entitlements`,viewer,'PATCH',patch),403,'PLATFORM_PERMISSION_REQUIRED');
 check('missing Origin rejected',await request(`/api/v1/platform/customers/${org}/entitlements`,admin,'PATCH',patch,'origin'),403,'CSRF_ORIGIN_MISMATCH');
 check('missing CSRF rejected',await request(`/api/v1/platform/customers/${org}/entitlements`,admin,'PATCH',patch,'x-csrf-token'),403,'CSRF_TOKEN_INVALID');
 check('stale entitlement version rejected',await request(`/api/v1/platform/customers/${org}/entitlements`,admin,'PATCH',{...patch,expectedVersion:1}),409,'VERSION_CONFLICT');
 const department=(await pool.query('SELECT id FROM departments LIMIT 1')).rows[0];assert.ok(department,'test seed department required');
 const jobs=await Promise.all([1,2].map(n=>request('/api/v1/jobs',owner,'POST',{title:`Isolated job ${n}`,headcount:1,departmentId:department.id})));
 assert.deepEqual(jobs.map(r=>r.status).sort(),[201,409]);
 check('concurrent HTTP job loser rejected',jobs.find(r=>r.status===409),409,'JOB_LIMIT_EXCEEDED');
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM jobs WHERE organization_id=$1',[org])).rows[0].n,1);
 const current=await rights.readPlatform(admin,org);assert.equal(current.jobs.used,1);count++;console.log('PASS HTTP creation persisted exactly one job and usage=1 in PostgreSQL');
 const invitation=await invites.create(org,owner,{membershipRole:'member',businessRole:'recruiter',expiresInDays:7});
 check('HTTP invitation exceeds seat capacity',await request('/api/v1/workspace-invitations/accept',joiner,'POST',{code:invitation.code}),409,'SEAT_LIMIT_EXCEEDED');
 assert.equal((await invites.preview(invitation.code,joiner)).acceptedAt,null);assert.equal((await rights.readPlatform(admin,org)).seats.used,1);count++;console.log('PASS rejected HTTP invitation remains unused and seat usage=1');
 console.log(`HTTP verification: ${count} passed / 0 failed / 0 skipped; NODE_ENV=development, real isolated PostgreSQL only`);
} finally {
 await new Promise(r=>server.close(r));
 await pool.query('DELETE FROM organization_invitations WHERE organization_id=$1',[org]);
 await pool.query('DELETE FROM jobs WHERE organization_id=$1',[org]);
 await pool.query('DELETE FROM platform_audit_logs WHERE actor_user_id=ANY($1::uuid[])',[users]);
 await pool.query('DELETE FROM audit_logs WHERE organization_id=$1',[org]);
 await pool.query('DELETE FROM sessions WHERE user_id=ANY($1::uuid[])',[users]);
 await pool.query('DELETE FROM organization_members WHERE organization_id=$1',[org]);
 await pool.query('DELETE FROM organizations WHERE id=$1',[org]);
 await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[users]);
 await pool.end();clearTimeout(timer);
}
process.exit(0);



