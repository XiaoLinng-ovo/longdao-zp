import assert from 'node:assert/strict'
import { stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { mixedDiskFree, reconcileMixedRun } from './business-browser-mixed-audit.mjs'

const fullCycleIntervalMs = 120000
const sampleIntervalMs = 30000
const maxRss = 4 * 1024 ** 3

export function drainMixedRequestDiagnostics(evidence) {
  assert.equal(evidence.droppedRequests, 0, '请求诊断达到容量上限，不能丢失后继续验收')
  assert.equal(evidence.droppedSocketErrors, 0)
  const settled = evidence.requests.filter(record => record.finished || record.closed)
  evidence.requests = evidence.requests.filter(record => !record.finished && !record.closed)
  assert.ok(evidence.requests.length < 128, '长期未结束请求超过预算')
  return settled
}

export function mixedRequestLatency(records) {
  const values = records.filter(row => row.finished && Number.isFinite(row.elapsedMs)).map(row => row.elapsedMs).sort((a, b) => a - b)
  assert.ok(values.length > 0, '缺少已完成请求延迟证据')
  const percentile = fraction => values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)]
  return { count: values.length, p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), max: values.at(-1) }
}

export function verifyMixedNetworkFailures(network, diagnostics, interviewId) {
  const base = '/api/v1/interviews/' + interviewId
  const candidates = diagnostics.filter(row => row.method === 'GET' && row.path === base + '/question-preparation' && row.finished && row.status === 200)
  for (const entry of network) {
    const knownRead = [base + '/recordings/full', base + '/recordings/transcription'].includes(entry.path)
    const at = Date.parse(entry.at)
    const index = entry.path !== base + '/question-preparation' ? -1 : candidates.findIndex(row => {
      const started = Date.parse(row.startedAt)
      return started <= at && at <= started + row.elapsedMs + 250
    })
    assert.ok(entry.code === 'net::ERR_ABORTED' && entry.method === 'GET' && (knownRead || index !== -1),
      '混合运行出现未分类网络故障：' + JSON.stringify(entry))
    if (index !== -1) candidates.splice(index, 1)
  }
}

export function businessSustainedFlows({ pool, instance, json, responseAfter, waitFor, origin, workspaceIds, report,
  contextPage, login, importResumes, scheduleInitialInterview, audio, payment, journal, sample, healthy }) {
  let alternate, checkout, originalName, subscriptionId
  const table = (member, name) => {
    assert.match(member.schema, /^company_[a-f0-9]{32}$/)
    return `"${member.schema}".${name}`
  }
  async function prepare(owner, member) {
    assert.ok(!process.env.SYSTEM_ADMIN_USER_NO)
    process.env.SYSTEM_ADMIN_USER_NO = owner.userNo
    assert.equal((await json(owner.page, 'GET', '/me')).body.data.user.isSystemAdmin, true)
    const ordinary = (await json(member.page, 'GET', '/me')).body.data.user
    assert.equal(ordinary.role, 'recruiter')
    assert.ok(!ordinary.isSystemAdmin)
    assert.equal((await json(member.page, 'GET', '/admin/users')).status, 403)
    const page = member.page
    originalName = '隔离浏览器企业2'
    const name = '合成混合负载第二工作空间'
    await page.goto(origin + '/workspaces')
    await page.getByLabel('企业名称', { exact: true }).fill(name)
    const created = await responseAfter(page, 'POST', '/workspaces', () => page.getByRole('button', { name: '新建企业', exact: true }).click(), 201)
    await page.waitForURL(origin + '/')
    alternate = { id: created.id, name, schema: 'company_' + created.id.replaceAll('-', '') }
    workspaceIds.set(page, alternate.id)
    await select(page, { id: member.id, name: originalName })
    await payment.configure(owner, member)
    const subscription = await payment.subscribe(owner, member)
    subscriptionId = subscription.orderId
    await payment.setResumeRule(owner, true, { enabled: true, resource: 'ai_points', quantity: 1, unitSize: 1 })
    const checkoutPage = await contextPage()
    await login(checkoutPage, member, member.password, '/workspaces')
    const checkoutRow = checkoutPage.locator('article.workspace-row').filter({ has: checkoutPage.getByText(originalName, { exact: true }) })
    const enter = checkoutRow.getByRole('button', { name: /^(进入|切换)$/ })
    await enter.click()
    await checkoutPage.waitForURL(origin + '/')
    assert.equal((await json(checkoutPage, 'GET', '/me')).body.data.user.workspaceId, member.id)
    checkout = { ...member, page: checkoutPage }
    return { workspace: member.id, alternate: alternate.id, subscription }
  }
  async function select(page, workspace) {
    await page.goto(origin + '/workspaces')
    await responseAfter(page, 'POST', '/workspaces/' + workspace.id + '/select', () => page.locator('article.workspace-row')
      .filter({ has: page.getByText(workspace.name, { exact: true }) }).getByRole('button', { name: '切换', exact: true }).click())
    await page.waitForURL(origin + '/')
    workspaceIds.set(page, workspace.id)
    const result = await json(page, 'GET', '/me')
    assert.equal(result.status, 200)
    assert.equal(result.body.data.user.workspaceId, workspace.id)
    assert.equal(result.body.data.user.role, 'recruiter')
    assert.ok(!result.body.data.user.isSystemAdmin)
  }
  async function verifySwitch(member, candidate) {
    const page = member.page, stale = await page.context().newPage()
    try {
      await stale.goto(origin + '/candidates')
      await stale.getByRole('button', { name: '上传简历并建档', exact: true }).waitFor({ timeout: 12000 })
      workspaceIds.set(stale, member.id)
      await select(page, alternate)
      assert.deepEqual((await json(page, 'GET', '/candidates')).body.data, [])
      for (const [method, path, input] of [['GET', '/candidates'], ['POST', '/candidates', { fullName: '旧页禁止创建' }], ['DELETE', '/candidates/' + candidate.id]]) {
        const denied = await json(stale, method, path, input)
        assert.equal(denied.status, 409)
        assert.equal(denied.body.error.code, 'WORKSPACE_CONTEXT_CHANGED')
      }
      assert.equal((await pool.query(`SELECT count(*)::int n FROM ${table(alternate, 'candidates')}`)).rows[0].n, 0)
      await select(page, { id: member.id, name: originalName })
      assert.equal((await json(page, 'GET', '/candidates/' + candidate.id)).status, 200)
      return 3
    } finally { await stale.close() }
  }
  async function verifyDeletion(member, outsider, target, sibling) {
    const row = (await pool.query(`SELECT id,storage_key FROM ${table(member, 'resumes')} WHERE candidate_id=$1`, [target.id])).rows[0]
    assert.ok(row)
    const root = resolve(instance.env.RECRUITING_QUARANTINE_ROOT), object = resolve(root, row.storage_key)
    assert.ok(object.startsWith(root + sep))
    assert.ok((await stat(object)).isFile())
    for (const method of ['GET', 'DELETE']) assert.equal((await json(outsider.page, method, '/candidates/' + target.id)).status, 404)
    assert.equal((await json(member.page, 'DELETE', '/candidates/' + target.id)).status, 200)
    for (const [name, column, id] of [['candidates', 'id', target.id], ['resumes', 'candidate_id', target.id], ['applications', 'candidate_id', target.id],
      ['analysis_tasks', 'resume_id', row.id], ['analysis_results', 'resume_id', row.id]]) {
      assert.equal((await pool.query(`SELECT count(*)::int n FROM ${table(member, name)} WHERE ${column}=$1`, [id])).rows[0].n, 0)
    }
    const siblingResponse = await json(member.page, 'GET', '/candidates/' + sibling.id)
    assert.equal(siblingResponse.status, 200)
    const siblingObject = (await pool.query(`SELECT storage_key FROM ${table(member, 'resumes')} WHERE candidate_id=$1`, [sibling.id])).rows[0]
    assert.ok(siblingObject)
    const siblingPath = resolve(root, siblingObject.storage_key)
    assert.ok(siblingPath.startsWith(root + sep))
    assert.ok((await stat(siblingPath)).isFile(), '同名档案的物理文件不能被误删')
    await waitFor(async () => {
      const task = (await pool.query('SELECT status,last_error FROM public.object_cleanup_tasks WHERE organization_id=$1 AND storage_key=$2', [member.id, row.storage_key])).rows[0]
      assert.ok(task)
      assert.notEqual(task.status, 'failed', task.last_error)
      return task.status === 'completed'
    }, '本轮真实物理清理', 25000)
    await assert.rejects(stat(object), { code: 'ENOENT' })
    assert.equal((await pool.query('SELECT count(*)::int n FROM public.stored_object_locations WHERE storage_key=$1', [row.storage_key])).rows[0].n, 0)
    assert.equal((await pool.query('SELECT status FROM public.object_write_intents WHERE storage_key=$1', [row.storage_key])).rows[0].status, 'deleted')
    return target.id
  }
  async function run(owner, member, minutes) {
    const started = performance.now(), duration = minutes * 60000, cadence = minutes === 1 ? 0 : fullCycleIntervalMs
    const totals = { requestedMinutes: minutes, scope: minutes === 1 ? '混合工具冒烟，不是长测' : '仅已列明场景，不是全业务耐久验收',
      cycles: 0, imports: 0, recordings: 0, deletions: 0, callbacks: 0, staleDenied: 0, sampleCount: 0, peakRss: 0, wallMs: 0 }
    const resourceSamples = [], requestDurations = [], addonIds = [], sessions = []
    const reconcile = () => reconcileMixedRun({ pool, instance, companies: [owner, member, alternate], memberId: member.id,
      subscriptionId, addonIds, importedResumes: totals.imports, sessions })
    totals.minFreeBytes = await mixedDiskFree(instance.directory)
    let sampling = Promise.resolve(), samplingError, samplingActive = false
    const collect = () => {
      if (samplingActive || samplingError) return
      samplingActive = true
      sampling = sampling.then(async () => {
        const elapsedMs = performance.now() - started
        const [data, freeBytes] = await Promise.all([sample(), mixedDiskFree(instance.directory)])
        assert.ok(data.rssBytes <= maxRss, '混合场景进程树RSS超过预设预算')
        totals.minFreeBytes = Math.min(totals.minFreeBytes, freeBytes)
        resourceSamples.push({ elapsedMs, rss: data.rssBytes, handles: data.processes.reduce((n, p) => n + p.handles, 0) })
        totals.sampleCount++; totals.peakRss = Math.max(totals.peakRss, data.rssBytes)
        await journal.append({ type: 'resources', elapsedMs, freeBytes, ...data })
      }).catch(error => { samplingError ??= error }).finally(() => { samplingActive = false })
    }
    const assertHealthy = () => { if (samplingError) throw samplingError; healthy() }
    collect()
    const timer = setInterval(collect, sampleIntervalMs)
    try {
      while (performance.now() - started < duration || (minutes === 1 && totals.cycles < 2)) {
        assertHealthy()
        const began = performance.now(), offset = report.browserNetworkFailures.length
        const imported = await importResumes(member, 2, { screenshot: false })
        assertHealthy()
        const staleDenied = await verifySwitch(member, member.candidates[0])
        const initial = await scheduleInitialInterview(member, true)
        const application = (await pool.query(`SELECT candidate_id FROM ${table(member, 'applications')} WHERE id=$1`, [initial.applicationId])).rows[0]
        const sibling = member.candidates.find(candidate => candidate.id === application?.candidate_id)
        assert.ok(sibling, '面试必须关联本轮档案')
        const target = member.candidates.find(candidate => candidate.id !== sibling.id)
        const parallel = await Promise.allSettled([audio.capture(member, owner, initial.id, { screenshot: false }),
          payment.sustainedAddon(checkout, owner, totals.cycles === 0)])
        const errors = parallel.filter(item => item.status === 'rejected').map(item => item.reason)
        if (errors.length) throw new AggregateError(errors, errors.map(error => error.message).join('；'))
        const [recording, paymentResult] = parallel.map(item => item.value)
        assertHealthy()
        const deleted = await verifyDeletion(member, owner, target, sibling)
        const network = report.browserNetworkFailures.slice(offset)
        const diagnostics = drainMixedRequestDiagnostics(report.apiRequestDiagnostics)
        verifyMixedNetworkFailures(network, diagnostics, initial.id)
        totals.cycles++; totals.imports += imported.count; totals.recordings++; totals.deletions++; totals.callbacks += paymentResult.callbacks; totals.staleDenied += staleDenied
        addonIds.push(paymentResult.orderId)
        sessions.push(recording.sessionId)
        const reconciliation = await reconcile()
        requestDurations.push(...diagnostics.filter(row => row.finished).map(row => ({ finished: true, elapsedMs: row.elapsedMs })))
        assert.ok(requestDurations.length <= 100000, '延迟统计超过预设记录预算')
        await journal.append({ type: 'cycle', index: totals.cycles, elapsedMs: performance.now() - began, imported, recording, payment: paymentResult, deleted, staleDenied, network, diagnostics, reconciliation })
        console.log('混合周期通过：' + totals.cycles)
        const next = Math.min(started + duration, began + cadence)
        while (performance.now() < next) { assertHealthy(); await delay(Math.min(1000, next - performance.now())) }
      }
      await sampling
      assertHealthy()
      totals.wallMs = performance.now() - started
      assert.ok(totals.wallMs >= duration && totals.cycles >= 2)
      totals.reconciliation = await reconcile()
      totals.minFreeBytes = Math.min(totals.minFreeBytes, await mixedDiskFree(instance.directory))
      totals.requestLatencyMs = mixedRequestLatency(requestDurations)
      assert.ok(totals.requestLatencyMs.p99 < 10000, '真实混合请求P99超过10秒预设预算')
      if (minutes !== 1) {
        assert.ok(totals.cycles >= Math.floor(duration / fullCycleIntervalMs * 0.9), '负载周期不足，不能用低吞吐等待冒充验收')
        assert.ok(resourceSamples.length >= Math.floor(duration / sampleIntervalMs * 0.9), '全程资源采样不足')
        const early = resourceSamples.filter(row => row.elapsedMs >= 300000 && row.elapsedMs < 600000)
        const late = resourceSamples.filter(row => row.elapsedMs >= totals.wallMs - 300000)
        assert.ok(early.length >= 5 && late.length >= 5, '稳定窗口采样不足')
        const median = (records, key) => records.map(row => row[key]).sort((a, b) => a - b)[Math.floor(records.length / 2)]
        totals.trend = { early: early.length, late: late.length, rssGrowth: median(late, 'rss') - median(early, 'rss'), handleGrowth: median(late, 'handles') - median(early, 'handles') }
        assert.ok(totals.trend.rssGrowth <= 512 * 1024 ** 2 && totals.trend.handleGrowth <= 512, '混合运行预热后资源增长超过预算')
      }
      return totals
    } finally { clearInterval(timer); await sampling }
  }
  return { prepare, run }
}
