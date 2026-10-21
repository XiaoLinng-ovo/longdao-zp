import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { createPostgresHealthPool, shouldSkipPostgresIntegration } from '../src/recruiting/db-health.js'
import { NormalizedRecruitingRepository, RepositoryNotFoundError } from '../src/recruiting/repositories/postgres-repository.js'
import type { RepositoryClient, RepositoryPool } from '../src/recruiting/repositories/types.js'
import { AdminService } from '../src/admin/service.js'
import { PostgresSessionRepository } from '../src/auth/session-repository.js'
import { RecruitingService } from '../src/recruiting/service.js'

test('two enterprises isolate Offer, salary versions, onboarding, interviewer directory and membership revocation', async (t) => {
  if (shouldSkipPostgresIntegration()) { t.skip('PostgreSQL integration is not configured'); return }
  const pool = createPostgresHealthPool(), client = await pool.connect()
  let queue: Promise<void> = Promise.resolve()
  const query: RepositoryClient['query'] = async (sql, values = []) => {
    const statement = sql === 'BEGIN' ? 'SAVEPOINT saas_scope_test' : sql === 'COMMIT' ? 'RELEASE SAVEPOINT saas_scope_test' : sql === 'ROLLBACK' ? 'ROLLBACK TO SAVEPOINT saas_scope_test' : sql
    const pending = queue.then(() => client.query(statement, [...values]))
    queue = pending.then(() => undefined, () => undefined)
    return await pending as never
  }
  const adapter: RepositoryPool = { query, async connect() { return { query, release() {} } }, async end() {} }
  const orgA = randomUUID(), orgB = randomUUID(), userA = randomUUID(), userB = randomUUID()
  const appA = randomUUID(), appB = randomUUID(), departmentId = randomUUID()
  const repoA = new NormalizedRecruitingRepository(adapter, { organizationId: orgA })
  const repoB = repoA.withOrganization(orgB)
  const notFound = (e: unknown) => e instanceof RepositoryNotFoundError
  await client.query('BEGIN')
  try {
    await client.query("INSERT INTO departments (id,code,name) VALUES ($1,$2,'SaaS scope fixture')", [departmentId, `DEPT-${departmentId}`])
    for (const [org, user, app] of [[orgA, userA, appA], [orgB, userB, appB]]) {
      await client.query("INSERT INTO users (id,email,display_name,is_active) VALUES ($1,$2,'SaaS scope fixture',true)", [user, `${user}@example.invalid`])
      await client.query("INSERT INTO organizations (id,name,kind) VALUES ($1,'SaaS scope fixture','test')", [org])
      await client.query("INSERT INTO organization_members (organization_id,user_id,role,business_role) VALUES ($1,$2,'owner','recruiter')", [org,user])
      const job = randomUUID(), candidate = randomUUID()
      await client.query("INSERT INTO jobs (id,organization_id,job_no,title,headcount) VALUES ($1,$2,$3,'Test Job',1)", [job,org,`JOB-${job}`])
      await client.query("INSERT INTO candidates (id,organization_id,candidate_no,name) VALUES ($1,$2,$3,'Test Candidate')", [candidate,org,`CAN-${candidate}`])
      await client.query("INSERT INTO applications (id,organization_id,application_no,candidate_id,job_id,status) VALUES ($1,$2,$3,$4,$5,'interviewing')", [app,org,`APP-${app}`,candidate,job])
      await client.query("INSERT INTO interviews (id,organization_id,application_id,interview_no,round,stage,type,title,status) VALUES ($1,$2,$3,$4,2,'final','other','Final','completed')", [randomUUID(),org,app,`INT-${app}`])
      await client.query("INSERT INTO interview_stage_reviews (application_id,organization_id,stage,decision,decided_by,decided_at) VALUES ($1,$2,'final','hired',$3,now())", [app,org,user])
    }
    const offerA = await repoA.createOffer({ applicationId: appA })
    const offerB = await repoB.createOffer({ applicationId: appB })
    const versionA = await repoA.createOfferVersion({ offerId: offerA.id, positionTitle: 'A', employmentType: 'full_time', departmentId, content: 'SaaS scope fixture', compensation: { baseSalary: 10000 } })
    const versionB = await repoB.createOfferVersion({ offerId: offerB.id, positionTitle: 'B', employmentType: 'full_time', departmentId, content: 'SaaS scope fixture', compensation: { baseSalary: 20000 } })
    await repoA.updateOffer(offerA.id, { currentVersionId: versionA.id, status: 'accepted' })
    await repoB.updateOffer(offerB.id, { currentVersionId: versionB.id, status: 'accepted' })
    assert.deepEqual((await repoA.listOffers()).map(x => x.id), [offerA.id])
    assert.deepEqual((await repoB.listOffers()).map(x => x.id), [offerB.id])
    assert.deepEqual((await repoA.listOfferVersions()).map(x => x.id), [versionA.id])
    await assert.rejects(repoA.getOffer(offerB.id), notFound)
    await assert.rejects(repoA.updateOffer(offerB.id, { status: 'cancelled' }), notFound)
    await assert.rejects(repoA.updateOffer(offerA.id, { currentVersionId: versionB.id }), notFound)
    await assert.rejects(repoA.createOffer({ applicationId: appB }), notFound)
    await assert.rejects(repoA.createOfferVersion({ offerId: offerB.id, positionTitle: 'foreign', employmentType: 'full_time', departmentId, content: 'foreign fixture', compensation: {} }), notFound)
    assert.deepEqual(await repoA.listOfferVersions(offerB.id), [])
    const onboardA = await repoA.createOnboarding({ applicationId: appA, offerId: offerA.id })
    const onboardB = await repoB.createOnboarding({ applicationId: appB, offerId: offerB.id })
    assert.equal((await repoA.createOnboarding({ applicationId: appA, offerId: offerA.id })).id, onboardA.id)
    assert.deepEqual((await repoA.listOnboarding()).map(x => x.id), [onboardA.id])
    assert.equal(await repoA.getOnboardingByOfferId(offerB.id), undefined)
    await assert.rejects(repoA.getOnboarding(onboardB.id), notFound)
    await assert.rejects(repoA.updateOnboarding(onboardB.id, { status: 'cancelled' }), notFound)
    await assert.rejects(repoA.createOnboarding({ applicationId: appB, offerId: offerB.id }), notFound)
    await repoA.updateOnboarding(onboardA.id, { notes: 'own notes' })
    assert.equal((await repoA.getOnboarding(onboardA.id)).notes, 'own notes')
    for (const table of ['offers','offer_versions','onboarding_records']) {
      const rows = await client.query(`SELECT DISTINCT organization_id FROM ${table} WHERE organization_id IN ($1,$2)`, [orgA,orgB])
      assert.deepEqual(rows.rows.map(x => x.organization_id).sort(), [orgA,orgB].sort())
    }
    // Historical mismatches are hidden, not silently reassigned to a customer.
    const badOffer = randomUUID()
    await client.query("INSERT INTO offers (id,organization_id,application_id) VALUES ($1,$2,$3)", [badOffer,orgA,appB])
    assert.deepEqual((await repoA.listOffers()).map(x => x.id), [offerA.id])
    await assert.rejects(repoA.getOffer(badOffer), notFound)
    const serviceA = new RecruitingService(undefined, undefined, undefined, repoA)
    await assert.rejects(serviceA.assertApplicationInScope(appB), notFound)
    await assert.rejects(serviceA.assertOfferInScope(offerB.id), /未找到 Offer/)
    await assert.rejects(serviceA.assertOnboardingInScope(onboardB.id), /未找到入职/)
    const admin = new AdminService(adapter as unknown as Pool)
    assert.deepEqual(await admin.listInterviewerOptions(orgA), [])
    assert.deepEqual(await admin.listInterviewerOptions(orgB), [])
    await client.query("INSERT INTO user_roles (user_id,role_id) SELECT $1,id FROM roles WHERE code='hr_admin'", [userA])
    await client.query("INSERT INTO user_roles (user_id,role_id) SELECT $1,id FROM roles WHERE code='hiring_manager'", [userB])
    await client.query("UPDATE organization_members SET business_role='approver' WHERE organization_id=$1 AND user_id=$2", [orgA,userA])
    assert.deepEqual((await admin.listInterviewerOptions(orgA)).map(x => x.id), [userA])
    assert.deepEqual((await admin.listInterviewerOptions(orgB)).map(x => x.id), [userB])
    assert.deepEqual(await admin.listInterviewerOptions(), [])
    await client.query("UPDATE user_roles SET role_id=(SELECT id FROM roles WHERE code='admin') WHERE user_id=$1", [userA])
    assert.deepEqual((await admin.listInterviewerOptions(orgA)).map(x => x.id), [userA])
    await client.query('UPDATE users SET is_active=false WHERE id=$1', [userA])
    assert.deepEqual(await admin.listInterviewerOptions(orgA), [])
    await client.query('UPDATE users SET is_active=true WHERE id=$1', [userA])
    for (const role of ['interviewer', 'approver', 'recruiter']) {
      await client.query('UPDATE user_roles SET role_id=(SELECT id FROM roles WHERE code=$1) WHERE user_id=$2', [role,userA])
      assert.deepEqual(await admin.listInterviewerOptions(orgA), [])
    }
    await client.query("UPDATE organization_members SET business_role='recruiter' WHERE organization_id=$1 AND user_id=$2", [orgA,userA])
    const sessions = new PostgresSessionRepository(adapter)
    const session = await sessions.createSession({ id: userA, name: 'fixture', email: `${userA}@example.invalid`, role: 'recruiter', departmentId: '' })
    await sessions.selectWorkspace(session.session.sessionId, userA, orgA)
    await assert.rejects(sessions.selectWorkspace(session.session.sessionId, userA, orgB), /无权访问/)
    await client.query('DELETE FROM organization_members WHERE organization_id=$1 AND user_id=$2', [orgA,userA])
    assert.equal((await sessions.findSessionByToken(session.token))?.user.workspaceId, undefined)
  } finally { await client.query('ROLLBACK'); client.release(); await pool.end() }
})
