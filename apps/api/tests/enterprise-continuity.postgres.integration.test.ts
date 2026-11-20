import { assertDisposableTestDatabase } from './helpers/disposable-database.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createPostgresHealthPool } from '../src/recruiting/db-health.js'
import { PaymentService } from '../src/payments/service.js'
import { organizationSchemaName } from '../src/db/tenant-context.js'
import { continuityCsv } from '../src/payments/continuity.js'

test('expired enterprise continuity enforces membership, projection limits, tenant routing and system-admin support', async t => {
  assertDisposableTestDatabase()
  const pool = createPostgresHealthPool(), org = randomUUID(), other = randomUUID()
  const admin = randomUUID(), member = randomUUID(), outsider = randomUUID()
  const schema = organizationSchemaName(org)
  const env: NodeJS.ProcessEnv = { TENANT_SCHEMA_ROUTING: 'off' }
  const service = new PaymentService(pool, undefined, env)
  try {
    for (const id of [admin, member, outsider]) await pool.query("INSERT INTO users(id,email,display_name,is_active) VALUES($1,$2,'Continuity fixture',true)", [id, id + '@example.invalid'])
    env.SYSTEM_ADMIN_USER_NO = (await pool.query('SELECT user_no FROM users WHERE id=$1', [admin])).rows[0].user_no
    await pool.query("INSERT INTO organizations(id,name,kind,service_status) VALUES($1,'Continuity fixture','test','enabled'),($2,'Other continuity','test','enabled')", [org, other])
    await pool.query("INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'member'),($3,$4,'member')", [org, member, other, outsider])
    await pool.query("INSERT INTO jobs(organization_id,job_no,title,headcount) VALUES($1,$2,'Legacy public job',1)", [org, 'legacy-' + org])
    await pool.query("UPDATE organizations SET paid_subscription_expires_at=now()-interval '1 day' WHERE id=$1", [org])
    await t.test('expiry retains an explicit read projection and audited export, without granting other enterprises access', async () => {
      const report = await service.continuity(member, org)
      assert.equal(report.data?.stats.jobs, 1)
      assert.equal(report.data?.jobs[0]?.title, 'Legacy public job')
      assert.deepEqual(Object.keys(report.data!.jobs[0]!).sort(), ['id','jobNo','title','status','headcount','createdAt','updatedAt'].sort())
      await assert.rejects(service.continuity(outsider, org), { code: 'WORKSPACE_MEMBER_REQUIRED' })
      await assert.rejects(service.exportContinuity(outsider, org), { code: 'WORKSPACE_MEMBER_REQUIRED' })
      const exported = await service.exportContinuity(member, org)
      assert.equal(exported.rows, 1)
      assert.match(exported.csv, /Legacy public job/)
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM platform_audit_logs WHERE organization_id=$1 AND action='enterprise.data.export'", [org])).rows[0].count, 1)
    })
    await t.test('tenant routing reads the registered company schema, caps output, and never falls back to public', async () => {
      await pool.query(`CREATE SCHEMA "${schema}"`)
      for (const table of ['jobs','applications','interviews']) await pool.query(`CREATE TABLE "${schema}".${table} (LIKE public.${table} INCLUDING DEFAULTS)`)
      await pool.query(`INSERT INTO "${schema}".jobs(id,organization_id,job_no,title,headcount)
        SELECT gen_random_uuid(),$1,'tenant-'||n,'=HYPERLINK("unsafe")',1 FROM generate_series(1,1001) n`, [org])
      await pool.query("INSERT INTO public.organization_schemas(organization_id,schema_name,status) VALUES($1,$2,'ready') ON CONFLICT(organization_id) DO UPDATE SET schema_name=$2,status='ready'", [org, schema])
      env.TENANT_SCHEMA_ROUTING = 'on'
      const report = await service.continuity(member, org)
      assert.equal(report.data?.stats.jobs, 1001)
      assert.equal(report.data?.jobs.length, 100)
      assert.equal(report.data?.truncated, true)
      const exported = await service.exportContinuity(member, org)
      assert.equal(exported.rows, 1000)
      assert.equal(exported.truncated, true)
      assert.match(exported.csv, /'=HYPERLINK/)
      assert.doesNotMatch(exported.csv, /Legacy public job/)
      await pool.query("UPDATE organization_schemas SET status='disabled' WHERE organization_id=$1", [org])
      assert.equal((await service.continuity(member, org)).dataUnavailable, true)
      await assert.rejects(service.exportContinuity(member, org), { code: 'WORKSPACE_SCHEMA_UNAVAILABLE' })
    })
    await t.test('contact remains available without a ready data schema; concurrent members share one open ticket', async () => {
      const requests = await Promise.all([service.contactAdministrator(member, org, { message: '套餐到期需要帮助' }), service.contactAdministrator(member, org, { message: '请协助续费' })])
      assert.equal(requests[0].request.id, requests[1].request.id)
      assert.equal(requests.filter(r => r.existing).length, 1)
      const id = requests[0].request.id
      await assert.rejects(service.contactAdministrator(outsider, org, { message: '越权' }), { code: 'WORKSPACE_MEMBER_REQUIRED' })
      await assert.rejects(service.resolveServiceRequest(member, id, { response: '假回复' }), { code: 'SYSTEM_ADMIN_REQUIRED' })
      await assert.rejects(service.adminOverview(member), { code: 'SYSTEM_ADMIN_REQUIRED' })
      assert.equal((await service.adminOverview(admin)).serviceRequests.some(r => r.id === id), true)
      await service.resolveServiceRequest(admin, id, { response: '请使用企业付款页续费，付款后权益自动恢复。' })
      const report = await service.continuity(member, org)
      assert.equal(report.requests[0]?.status, 'resolved')
      assert.match(report.requests[0]?.response ?? '', /自动恢复/)
      await assert.rejects(service.resolveServiceRequest(admin, id, { response: '再次回复' }), { code: 'SERVICE_REQUEST_CLOSED' })
      assert.equal((await service.contactAdministrator(member, org, { message: '还有其他问题' })).existing, false)
    })
    await t.test('shared conversations retain member and administrator messages, attachment permissions and reopening rules', async () => {
      const id = (await service.continuity(member,org)).requests.find(r=>r.status==='open')!.id
      const upload = {filename:'续费说明.txt',base64:Buffer.from('附件原文').toString('base64')}
      const first = await service.replyServiceRequest(member,id,{message:'补充付款问题',attachments:[upload]},org)
      const attachment = first.messages.at(-1)!.attachments[0]!
      assert.equal(first.request.status,'open')
      assert.equal(first.messages.at(-1)!.authorKind,'member')
      assert.equal((await service.serviceAttachment(member,id,attachment.id,org)).base64,upload.base64)
      assert.equal((await service.serviceAttachment(admin,id,attachment.id)).filename,upload.filename)
      await assert.rejects(service.serviceThread(outsider,id,other),{code:'SERVICE_REQUEST_NOT_FOUND'})
      await assert.rejects(service.serviceAttachment(outsider,id,attachment.id,org),{code:'WORKSPACE_MEMBER_REQUIRED'})
      await assert.rejects(service.serviceThread(member,id),{code:'SYSTEM_ADMIN_REQUIRED'})
      await assert.rejects(service.replyServiceRequest(member,id,{message:'伪装管理员',resolve:true},org),{code:'SYSTEM_ADMIN_REQUIRED'})
      const reply = await service.replyServiceRequest(admin,id,{message:'请补充相关截图',resolve:false,attachments:[upload]})
      assert.equal(reply.request.status,'open'); assert.equal(reply.messages.at(-1)!.authorKind,'administrator')
      assert.equal((await service.replyServiceRequest(admin,id,{message:'已经协助处理',resolve:true})).request.status,'resolved')
      await Promise.all([service.replyServiceRequest(member,id,{message:'仍有疑问一'},org),service.replyServiceRequest(member,id,{message:'仍有疑问二'},org)])
      const reopened = await service.serviceThread(member,id,org)
      assert.equal(reopened.request.status,'open'); assert.equal(reopened.messages.filter(m=>m.message.startsWith('仍有疑问')).length,2)
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM enterprise_service_requests WHERE organization_id=$1 AND status='open'",[org])).rows[0].n,1)
      await service.replyServiceRequest(admin,id,{message:'本次处理完毕',resolve:true})
      const another = await service.contactAdministrator(member,org,{message:'新的其他问题'})
      await assert.rejects(service.replyServiceRequest(member,id,{message:'旧单追问'},org),{code:'SERVICE_REQUEST_ALREADY_OPEN'})
      await assert.rejects(service.serviceAttachment(member,another.request.id,attachment.id,org),{code:'ATTACHMENT_NOT_FOUND'})
      await pool.query('UPDATE users SET is_active=false WHERE id=$1',[member])
      await assert.rejects(service.serviceAttachment(member,id,attachment.id,org),{code:'WORKSPACE_MEMBER_REQUIRED'})
      await pool.query('UPDATE users SET is_active=true WHERE id=$1',[member])
    })
    await t.test('thread pagination preserves every message and rejects a cursor belonging to another ticket', async () => {
      const id = (await service.continuity(member,org)).requests.find(r=>r.status==='open')!.id
      await pool.query("INSERT INTO enterprise_service_messages(request_id,author_id,author_kind,message) SELECT $1,$2,'member','历史消息 '||n FROM generate_series(1,60) n",[id,member])
      const page = await service.serviceThread(member,id,org)
      assert.equal(page.messages.length,50);assert.equal(page.hasMore,true)
      const older = await service.serviceThread(member,id,org,page.nextBefore!)
      assert.equal(older.messages.length,11);assert.equal(older.hasMore,false)
      assert.equal(new Set([...page.messages,...older.messages].map(m=>m.id)).size,61)
      const otherId = (await pool.query('SELECT m.id FROM enterprise_service_messages m WHERE m.request_id<>$1 LIMIT 1',[id])).rows[0].id
      await assert.rejects(service.serviceThread(member,id,org,otherId),{code:'VALIDATION_ERROR'})
    })
    await t.test('per-ticket attachment quota is atomic and rejected uploads leave no message or file behind', async () => {
      const id = (await service.continuity(member,org)).requests.find(r=>r.status==='open')!.id
      const messageId = (await pool.query('SELECT id FROM enterprise_service_messages WHERE request_id=$1 LIMIT 1',[id])).rows[0].id
      await pool.query("INSERT INTO enterprise_service_attachments(message_id,filename,mime_type,content,size_bytes) SELECT $1,'容量测试.txt','text/plain',convert_to(repeat('A',2097152),'UTF8'),2097152 FROM generate_series(1,15)",[messageId])
      const counts=async()=> (await pool.query('SELECT count(DISTINCT m.id)::int AS messages,count(a.id)::int AS files FROM enterprise_service_messages m LEFT JOIN enterprise_service_attachments a ON a.message_id=m.id WHERE m.request_id=$1',[id])).rows[0]
      const before=await counts()
      await assert.rejects(service.replyServiceRequest(member,id,{message:'应当原子拒绝',attachments:[{filename:'extra.txt',base64:'b2s='}]},org),{code:'TICKET_ATTACHMENT_LIMIT'})
      assert.deepEqual(await counts(),before)
      await service.replyServiceRequest(member,id,{message:'达到附件上限后仍可发送纯文字'},org)
    })
    await t.test('conversation migration preserves legacy messages and orders same-time administrator replies after the initial request', async () => {
      const db=await pool.connect(), migrationSchema='support_migration_'+randomUUID().replaceAll('-','')
      const prefix='"'+migrationSchema+'".'
      try {
        await db.query('BEGIN')
        await db.query('CREATE SCHEMA "'+migrationSchema+'"')
        await db.query('CREATE TABLE '+prefix+'users(id uuid PRIMARY KEY)')
        await db.query('CREATE TABLE '+prefix+'organizations(id uuid PRIMARY KEY)')
        const migrations = new URL('../../../../db/migrations/',import.meta.url)
        await db.query((await readFile(new URL('0079_enterprise_service_requests.sql',migrations),'utf8')).replaceAll('public.',prefix))
        const legacyOrg=randomUUID(), legacyId=randomUUID()
        await db.query('INSERT INTO '+prefix+'organizations(id) VALUES($1)',[legacyOrg])
        await db.query('INSERT INTO '+prefix+"enterprise_service_requests(id,organization_id,message,status,response,created_at,resolved_at) VALUES($1,$2,'历史问题','resolved','历史管理员回复','2026-11-01T00:00:00Z','2026-11-01T00:00:00Z')",[legacyId,legacyOrg])
        await db.query((await readFile(new URL('0081_enterprise_service_conversations.sql',migrations),'utf8')).replaceAll('public.',prefix))
        const rows=(await db.query('SELECT author_kind,message,author_id FROM '+prefix+'enterprise_service_messages ORDER BY created_at,id')).rows
        assert.deepEqual(rows,[{author_kind:'member',message:'历史问题',author_id:null},{author_kind:'administrator',message:'历史管理员回复',author_id:null}])
        assert.equal((await db.query('SELECT updated_at=resolved_at AS preserved FROM '+prefix+'enterprise_service_requests')).rows[0].preserved,true)
      } finally { await db.query('ROLLBACK'); db.release() }
    })
    await t.test('suspension preserves contact but blocks data; disabling or removing membership revokes access', async () => {
      await pool.query("UPDATE organizations SET service_status='suspended' WHERE id=$1", [org])
      assert.equal((await service.continuity(member, org)).dataRestricted, true)
      await assert.rejects(service.exportContinuity(member, org), { code: 'WORKSPACE_SERVICE_SUSPENDED' })
      await pool.query('UPDATE users SET is_active=false WHERE id=$1', [member])
      await assert.rejects(service.continuity(member, org), { code: 'WORKSPACE_MEMBER_REQUIRED' })
      await pool.query('UPDATE users SET is_active=true WHERE id=$1', [member])
      await pool.query('DELETE FROM organization_members WHERE organization_id=$1 AND user_id=$2', [org, member])
      await assert.rejects(service.continuity(member, org), { code: 'WORKSPACE_MEMBER_REQUIRED' })
      await assert.rejects(service.contactAdministrator(member, org, { message: '退出后无权联系' }), { code: 'WORKSPACE_MEMBER_REQUIRED' })
    })
    assert.match(continuityCsv([{ id:'x', jobNo:'\t=cmd', title:' @SUM(1)', status:'draft', headcount:1, createdAt:null, updatedAt:null }]), /'\t=cmd/)
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await pool.query('DELETE FROM enterprise_service_requests WHERE organization_id=$1', [org])
    await pool.query('DELETE FROM platform_audit_logs WHERE organization_id=ANY($1::uuid[])', [[org, other]])
    await pool.query('DELETE FROM jobs WHERE organization_id=$1', [org])
    await pool.query('DELETE FROM organization_schemas WHERE organization_id=ANY($1::uuid[])', [[org, other]])
    await pool.query('DELETE FROM organization_members WHERE organization_id=ANY($1::uuid[])', [[org, other]])
    await pool.query('DELETE FROM organizations WHERE id=ANY($1::uuid[])', [[org, other]])
    await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[admin, member, outsider]])
    await pool.end()
  }
})
