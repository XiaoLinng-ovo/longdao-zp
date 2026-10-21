import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { EnterpriseAiStore, decryptApiKey } from '@smartrecruit-pro/enterprise-ai'
import { createPostgresHealthPool, shouldSkipPostgresIntegration } from '../src/recruiting/db-health.js'
import { AdminService, AdminNotFoundError, AdminValidationError } from '../src/admin/service.js'
import type { RepositoryClient, RepositoryPool } from '../src/recruiting/repositories/types.js'

test('enterprise AI settings and Skills isolate two tenants; mutations roll back without leaving fixtures', async t => {
  if (shouldSkipPostgresIntegration()) { t.skip('PostgreSQL integration is not configured'); return }
  const pool = createPostgresHealthPool(), client = await pool.connect()
  let queue: Promise<void> = Promise.resolve()
  const query: RepositoryClient['query'] = async (sql, values = []) => {
    const statement = sql === 'BEGIN' ? 'SAVEPOINT enterprise_ai_test' : sql === 'COMMIT' ? 'RELEASE SAVEPOINT enterprise_ai_test' : sql === 'ROLLBACK' ? 'ROLLBACK TO SAVEPOINT enterprise_ai_test' : sql
    const pending = queue.then(() => client.query(statement, [...values]))
    queue = pending.then(() => undefined, () => undefined)
    return await pending as never
  }
  const adapter: RepositoryPool = {query, async connect() {return {query,release(){}}},async end(){}}
  const orgA=randomUUID(), orgB=randomUUID(), ownerA=randomUUID(), ownerB=randomUUID(), member=randomUUID(), jobA=randomUUID(), jobB=randomUUID()
  const key=randomBytes(32).toString('base64'), store=new EnterpriseAiStore(adapter,key)
  const skills=new AdminService(adapter as unknown as Pool), sa=skills.forOrganization(orgA), sb=skills.forOrganization(orgB)
  await client.query('BEGIN')
  try {
    for (const user of [ownerA,ownerB,member]) await client.query("INSERT INTO users (id,email,display_name,is_active) VALUES ($1,$2,'AI isolation fixture',true)",[user,`${user}@example.invalid`])
    for (const [org,owner,job] of [[orgA,ownerA,jobA],[orgB,ownerB,jobB]]) {
      await client.query("INSERT INTO organizations (id,name,kind) VALUES ($1,'AI isolation fixture','test')",[org])
      await client.query("INSERT INTO organization_members (organization_id,user_id,role,business_role) VALUES ($1,$2,'owner','recruiter')",[org,owner])
      await client.query("INSERT INTO jobs (id,organization_id,job_no,title,headcount) VALUES ($1,$2,$3,'AI test job',1)",[job,org,`JOB-${job}`])
    }
    await client.query("INSERT INTO organization_members (organization_id,user_id,role,business_role) VALUES ($1,$2,'member','recruiter')",[orgA,member])
    await client.query("INSERT INTO user_roles (user_id,role_id) SELECT $1,id FROM roles WHERE code='admin'",[member])
    await assert.rejects(store.assertAdmin(orgA,member),{code:'WORKSPACE_ADMIN_REQUIRED'})
    await assert.rejects(store.assertAdmin(orgB,ownerA),{code:'WORKSPACE_ADMIN_REQUIRED'})
    await store.save(orgA,{OPENAI_BASE_URL:'http://127.0.0.1:1234/v1',OPENAI_MODEL:'model-a',OPENAI_API_KEY:'secret-a'},ownerA)
    await store.save(orgB,{OPENAI_BASE_URL:'http://127.0.0.1:1235/v1',OPENAI_MODEL:'model-b',OPENAI_API_KEY:'secret-b'},ownerB)
    assert.equal((await store.runtimeEnv(orgA)).OPENAI_API_KEY,'secret-a')
    assert.equal((await store.runtimeEnv(orgB)).OPENAI_API_KEY,'secret-b')
    assert.equal((await new EnterpriseAiStore(adapter,key).runtimeEnv(orgA)).OPENAI_MODEL,'model-a')
    assert.equal((await store.get(orgA)).env.OPENAI_API_KEY.value,'••••••••')
    const encrypted=(await client.query('SELECT api_key_ciphertext FROM enterprise_ai_settings WHERE organization_id=$1',[orgA])).rows[0].api_key_ciphertext
    assert.throws(()=>decryptApiKey(encrypted,orgB,key),{code:'AI_SECRET_DECRYPTION_FAILED'})
    await store.save(orgA,{OPENAI_MODEL:'model-a2'},ownerA)
    assert.equal((await store.runtimeEnv(orgA)).OPENAI_API_KEY,'secret-a')
    await assert.rejects(store.save(orgA,{OPENAI_API_KEY:'forbidden'},member),{code:'WORKSPACE_ADMIN_REQUIRED'})
    assert.equal((await store.runtimeEnv(orgA)).OPENAI_API_KEY,'secret-a')
    await assert.rejects(sa.createAiPromptSkill({name:'member denied',content:'cannot write'},member),{code:'WORKSPACE_ADMIN_REQUIRED'})
    const specA=await sa.createAiPromptSkill({name:'A private',content:'A private instructions',targetType:'both'},ownerA)
    const scoreB=await sb.createAiPromptSkill({name:'B scoring',content:'B private scoring rules',targetType:'resume_score',jobIds:[jobB]},ownerB)
    const historical=(await client.query("INSERT INTO ai_prompt_skills (name,target_type,content,created_by) VALUES ('historical unassigned','both','retained but unassigned',$1) RETURNING id",[ownerA])).rows[0].id
    assert.deepEqual((await sa.listAiPromptSkills(true,'jd')).map(x=>x.id),[specA.id])
    assert.deepEqual((await sb.listAiPromptSkills()).map(x=>x.id),[scoreB.id])
    for (const id of [scoreB.id,historical]) {
      await assert.rejects(sa.getAiPromptSkill(id),AdminNotFoundError)
      await assert.rejects(sa.updateAiPromptSkill(id,{content:'foreign write'},ownerA),AdminNotFoundError)
      await assert.rejects(sa.deleteAiPromptSkill(id,ownerA),AdminNotFoundError)
    }
    await assert.rejects(sa.createAiPromptSkill({name:'cross job',content:'cannot bind foreign job',targetType:'resume_score',jobIds:[jobB]},ownerA),AdminValidationError)
    assert.equal((await sa.listAiPromptSkills()).length,1)
    // A damaged cross-tenant job binding must not disclose another enterprise's job ID.
    await client.query('INSERT INTO ai_resume_scoring_skill_jobs (skill_id,job_id) VALUES ($1,$2)',[scoreB.id,jobA])
    assert.deepEqual((await sb.getAiPromptSkill(scoreB.id)).jobIds,[jobB])
    const logs=(await client.query("SELECT organization_id,metadata FROM audit_logs WHERE organization_id=ANY($1::uuid[]) AND action='enterprise.ai_settings.update'",[[orgA,orgB]])).rows
    assert.equal(logs.length,3); assert.ok(!JSON.stringify(logs).includes('secret-a')); assert.ok(!JSON.stringify(logs).includes('secret-b'))
    await store.save(orgA,{OPENAI_API_KEY:''},ownerA)
    assert.equal((await store.get(orgA)).apiKeyConfigured,false)
    assert.equal((await store.runtimeEnv(orgB)).OPENAI_API_KEY,'secret-b')
    await client.query('DELETE FROM enterprise_ai_settings WHERE organization_id=$1',[orgA])
    assert.deepEqual(await store.runtimeEnv(orgA),{})
  } finally {await queue;await client.query('ROLLBACK');client.release();await pool.end()}
})
