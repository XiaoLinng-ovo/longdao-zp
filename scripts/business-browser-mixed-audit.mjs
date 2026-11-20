import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { statfs } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { capacityObjectInventory } from './capacity-object-inventory.mjs'

const ledgerLimit = 10000
const ids = rows => rows.map(row => row.id).sort()

export async function mixedDiskFree(directory) {
  const { bavail, bsize } = await statfs(directory)
  const freeBytes = bavail * bsize
  assert.ok(freeBytes >= 2 * 1024 ** 3, '隔离混合验收卷剩余空间低于 2 GiB')
  return freeBytes
}

export function reconcileMixedBilling({ orders, events, grants, trialGrants, tasks }, { memberId, subscriptionId, addonIds, importedResumes }) {
  const expected = [subscriptionId, ...addonIds]
  assert.equal(new Set(expected).size, expected.length)
  assert.deepEqual(ids(orders), expected.sort(), '存在未登记订单或实际订单缺失')
  assert.deepEqual(events.map(row => row.order_id).sort(), expected, '每笔订单只能产生一条付款事件')
  assert.ok(events.every(row => row.source === 'callback'))
  const usage = new Map(), grantsById = new Map(grants.map(grant => [grant.id, grant]))
  assert.equal(grantsById.size, grants.length)
  const trial = grants.filter(grant => grant.order_id === null)
  assert.deepEqual(ids(trial), ids(trialGrants), '非订单额度必须来自可核实的初始试用规则')
  assert.equal(grants.length - trial.length, expected.length * 3)
  for (const order of orders) {
    const subscription = order.id === subscriptionId
    assert.equal(order.organization_id, memberId)
    assert.equal(order.billing_kind, subscription ? 'subscription' : 'addon')
    assert.equal(order.status, 'fulfilled')
    assert.ok(order.transaction_id && order.paid_at)
    assert.deepEqual(grants.filter(grant => grant.order_id === order.id).map(grant => {
      assert.equal(grant.organization_id, memberId)
      assert.equal(grant.revoked_at, null)
      assert.equal(Boolean(grant.expires_at), subscription)
      return [grant.resource, Number(grant.total)]
    }).sort(), [['ai_points', 100], ['interview_seconds', 300], ['ocr_pages', 20]])
  }
  const resumeCharges = new Set()
  for (const task of tasks) {
    assert.equal(task.organization_id, memberId)
    assert.ok(['settled', 'released'].includes(task.state), '存在未结算或结果未知的计费任务')
    assert.ok(Array.isArray(task.allocations))
    let units = 0
    const used = new Set()
    for (const allocation of task.allocations) {
      const grant = grantsById.get(allocation.id), amount = Number(allocation.units)
      assert.ok(grant && grant.organization_id === task.organization_id && grant.resource === task.resource && !used.has(grant.id) && Number.isSafeInteger(amount) && amount > 0)
      used.add(grant.id)
      units += amount
      if (task.state === 'settled') usage.set(grant.id, (usage.get(grant.id) ?? 0) + amount)
    }
    assert.equal(units, Number(task.units))
    if (task.operation === 'resume_analysis' && task.state === 'settled') {
      assert.equal(units, 1)
      assert.ok(task.request_key && !resumeCharges.has(task.request_key), '同一简历分析被重复扣费')
      resumeCharges.add(task.request_key)
    }
  }
  assert.equal(resumeCharges.size, importedResumes, '真实简历分析与扣费任务不一一对应')
  for (const grant of grants) assert.equal(Number(grant.total) - Number(grant.remaining), usage.get(grant.id) ?? 0)
  return { orders: orders.length, paymentEvents: events.length, orderGrants: grants.length - trial.length, trialGrants: trial.length, billingTasks: tasks.length, resumeCharges: resumeCharges.size }
}

export async function reconcileMixedRun({ pool, instance, companies, memberId, subscriptionId, addonIds, importedResumes, sessions }) {
  const root = resolve(instance.env.RECRUITING_QUARANTINE_ROOT)
  const fallback = resolve(instance.env.INTERVIEW_STORAGE_ROOT)
  assert.equal(root, join(instance.directory, 'storage'))
  assert.equal(fallback, join(instance.directory, 'interviews'))
  const location = createHash('sha256').update(JSON.stringify(['local', process.platform === 'win32' ? root.toLowerCase() : root])).digest('hex')
  const db = await pool.connect()
  const rows = async sql => {
    const result = (await db.query(`${sql} LIMIT ${ledgerLimit + 1}`)).rows
    assert.ok(result.length <= ledgerLimit, '数据库对账行数超过验收预算')
    return result
  }
  const checkEmpty = async (sql, message) => assert.deepEqual((await db.query(`${sql} LIMIT 1`)).rows, [], message)
  const references = new Map(), recordings = new Map(), liveSessions = new Map()
  const add = (key, ref) => {
    assert.ok(key && !references.has(key), '多个引用共用同一物理对象')
    references.set(key, ref)
  }
  let billing, segmentJobs = 0, cleanupTasks
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    for (const company of companies) {
      assert.match(company.id, /^[a-f0-9-]{36}$/)
      assert.equal(company.schema, 'company_' + company.id.replaceAll('-', ''))
      assert.match(company.schema, /^company_[a-f0-9]{32}$/)
      const schema = `"${company.schema}"`
      for (const row of await rows(`SELECT organization_id,candidate_id,storage_key,size_bytes,content_hash FROM ${schema}.resumes`)) {
        assert.equal(row.organization_id, company.id)
        add(row.storage_key, { company, parentId: row.candidate_id, logicalKey: row.storage_key, kind: 'resume', bytes: Number(row.size_bytes), hash: row.content_hash })
      }
      for (const row of await rows(`SELECT id,status FROM ${schema}.interview_live_sessions`)) {
        assert.equal(row.status, 'completed')
        assert.ok(!liveSessions.has(row.id))
        liveSessions.set(row.id, company)
      }
      for (const row of await rows(`SELECT session_id,object_key,byte_length FROM ${schema}.interview_audio_recordings`)) {
        assert.equal(liveSessions.get(row.session_id), company)
        assert.ok(!recordings.has(row.object_key))
        recordings.set(row.object_key, row)
      }
      await checkEmpty(`SELECT id,status FROM ${schema}.analysis_tasks WHERE status<>'completed'`, '简历分析任务未排空')
      await checkEmpty(`SELECT object_key,status,error FROM ${schema}.interview_audio_transcription_jobs WHERE status<>'completed' OR claim IS NOT NULL OR error IS NOT NULL`, '录音分段任务未排空')
      segmentJobs += Number((await db.query(`SELECT count(*) AS n FROM ${schema}.interview_audio_transcription_jobs`)).rows[0].n)
    }
    for (const row of await rows('SELECT organization_id,session_id,storage_key,schema_name,physical_key FROM public.interview_stored_objects')) {
      const company = liveSessions.get(row.session_id), recording = recordings.get(row.storage_key)
      assert.ok(company && company.id === row.organization_id && company.schema === row.schema_name)
      assert.ok(row.physical_key?.startsWith('interviews/' + row.session_id + '/versions/'))
      if (recording) assert.equal(recording.session_id, row.session_id)
      add(row.physical_key, { company, parentId: row.session_id, logicalKey: row.storage_key, kind: 'interview', bytes: recording && Number(recording.byte_length) })
      recordings.delete(row.storage_key)
    }
    assert.equal(recordings.size, 0, '录音分段缺少物理对象映射')
    assert.deepEqual([...liveSessions.keys()].sort(), [...sessions].sort())
    const fullTasks = await rows('SELECT organization_id,schema_name,source,session_id,status,progress,inference_pending,lease_token,lease_until FROM public.full_audio_transcription_tasks')
    assert.deepEqual(fullTasks.map(row => row.session_id).sort(), [...sessions].sort())
    for (const row of fullTasks) assert.deepEqual([row.organization_id,row.schema_name,row.source,row.status,row.progress,row.inference_pending,row.lease_token,row.lease_until],
      [memberId,liveSessions.get(row.session_id).schema,'all','completed',100,false,null,null])
    await checkEmpty('SELECT * FROM public.analysis_execution_leases', '简历分析租约未释放')
    await checkEmpty("SELECT id,status,last_error FROM public.object_cleanup_tasks WHERE status<>'completed' OR lease_token IS NOT NULL OR last_error IS NOT NULL", '物理清理未排空')
    cleanupTasks = Number((await db.query('SELECT count(*) AS n FROM public.object_cleanup_tasks')).rows[0].n)
    const locations = await rows('SELECT organization_id,storage_kind,storage_key,location_id FROM public.stored_object_locations')
    assert.equal(locations.length, references.size)
    const intents = await rows('SELECT organization_id,schema_name,storage_kind,parent_id,logical_key,storage_key,location_id,content_version,status FROM public.object_write_intents')
    const bound = new Map()
    for (const intent of intents) {
      assert.ok(['bound', 'deleted'].includes(intent.status), '存在未绑定或未清理的对象写入意图')
      if (intent.status === 'bound') bound.set(intent.storage_key, intent)
      else assert.ok(!references.has(intent.storage_key), '已删除的对象仍被引用')
    }
    assert.equal(bound.size, references.size)
    for (const row of locations) {
      const ref = references.get(row.storage_key), intent = bound.get(row.storage_key)
      assert.ok(ref && intent && !ref.verified)
      assert.deepEqual([row.organization_id, row.storage_kind, row.location_id], [ref.company.id, ref.kind, location])
      assert.deepEqual([intent.organization_id, intent.schema_name, intent.storage_kind, intent.parent_id, intent.logical_key, intent.location_id],
        [ref.company.id, ref.company.schema, ref.kind, ref.parentId, ref.logicalKey, location])
      assert.match(intent.content_version, /^[a-f0-9]{64}$/)
      if (ref.kind === 'resume') assert.equal(intent.content_version, ref.hash)
      ref.hash = intent.content_version
      ref.verified = true
    }
    billing = reconcileMixedBilling({ orders: await rows('SELECT id,organization_id,billing_kind,status,transaction_id,paid_at FROM public.payment_orders'),
      events: await rows('SELECT order_id,source FROM public.payment_events'),
      grants: await rows('SELECT id,organization_id,resource,total,remaining,order_id,expires_at,revoked_at FROM public.billing_grants'),
      trialGrants: await rows(`SELECT g.id FROM public.billing_grants g JOIN public.billing_trial_grants t USING (organization_id,resource)
        JOIN public.billing_policy_versions p ON p.id=t.policy_version JOIN public.organizations o ON o.id=g.organization_id
        LEFT JOIN public.payment_orders active ON active.id=o.active_payment_order_id AND active.organization_id=o.id
        WHERE g.order_id IS NULL AND g.source_key='trial:initial' AND g.revoked_at IS NULL
          AND g.expires_at=date_trunc('milliseconds', COALESCE(o.trial_ends_at,(active.before_entitlements->>'trialEndsAt')::timestamptz))
          AND g.total=(p.config->'trial'->>CASE g.resource WHEN 'ai_points' THEN 'aiPoints' WHEN 'interview_seconds' THEN 'interviewSeconds' ELSE 'ocrPages' END)::bigint`),
      tasks: await rows('SELECT organization_id,resource,operation,request_key,state,units,allocations FROM public.billing_tasks') },
    { memberId, subscriptionId, addonIds, importedResumes })
    const active = (await db.query('SELECT id FROM public.organizations WHERE active_payment_order_id=$1', [subscriptionId])).rows
    assert.deepEqual(active, [{ id: memberId }])
    await db.query('COMMIT')
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {})
    throw error
  } finally { db.release() }
  assert.deepEqual(await capacityObjectInventory(fallback), [], '本地隔离场景不能写入录音回退目录')
  const files = await capacityObjectInventory(root)
  assert.equal(files.length, references.size, '实际文件与数据库对象引用数量不一致')
  for (const file of files) {
    const ref = references.get(file.key)
    assert.ok(ref?.verified, '出现未登记的物理文件')
    assert.equal(file.hash, ref.hash)
    if (ref.bytes !== undefined) assert.equal(file.bytes, ref.bytes)
  }
  return { objects: files.length, bytes: files.reduce((n, file) => n + file.bytes, 0), segmentJobs, fullAudioTasks: sessions.length, cleanupTasks, ...billing }
}
