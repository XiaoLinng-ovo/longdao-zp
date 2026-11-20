import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { projectRoot } from './isolated-environment.mjs'

async function locationMismatchApi(instance, expectStartupRejection = false) {
  const applicationName = 'closure-file-recovery-location-check'
  const child = fork(join(projectRoot, 'scripts/lifecycle-process-child.mjs'), [expectStartupRejection ? 'api' : 'cleanup-location-fault'], {
    cwd: projectRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    execArgv: ['--require', join(projectRoot, 'scripts/isolated-network-guard.cjs')],
    env: { ...instance.env, PGAPPNAME: applicationName, OBJECT_CLEANUP_POLL: 'on', ISOLATED_FAULT_ROOT: instance.directory,
      ...(expectStartupRejection ? { RECRUITING_QUARANTINE_ROOT: join(instance.directory, 'different-empty-storage') } : {}) },
  })
  const evidence = { pid: child.pid, applicationName, events: [], stdout: '', stderr: '' }
  child.stdout.on('data', data => { evidence.stdout += String(data) })
  child.stderr.on('data', data => { evidence.stderr += String(data) })
  const exit = new Promise(resolve => child.once('exit', (code, signal) => { evidence.exit = { code, signal }; resolve() }))
  let timer
  const ready = expectStartupRejection ? undefined : new Promise((resolve, reject) => {
    child.on('message', message => {
      evidence.events.push(message)
      if (message.type === 'ready') resolve()
      if (message.type === 'failure') reject(new Error(message.message))
    })
    child.once('error', reject)
    timer = setTimeout(() => reject(new Error('独立存储核对API启动超时')), 30000)
  })
  async function stop() {
    clearTimeout(timer)
    if (!evidence.exit) {
      if (child.connected) child.send({ type: 'stop' })
      let timeout
      try {
        await Promise.race([exit, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('独立存储核对API未自然退出')), 10000) })])
      } finally {
        clearTimeout(timeout)
        if (!evidence.exit) { evidence.forcedKill = true; child.kill(); await exit }
      }
    }
    assert.deepEqual(evidence.exit, { code: 0, signal: null })
    assert.equal(evidence.events.filter(event => event.type === 'closed').length, 1)
  }
  try {
    if (expectStartupRejection) {
      await Promise.race([exit, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('错误存储API未按预期拒绝启动')), 30000) })])
      clearTimeout(timer)
      assert.deepEqual(evidence.exit, { code: 1, signal: null })
      assert.match(evidence.stderr, /发布门禁：已登记文件与当前存储位置不一致/)
      assert.equal(evidence.events.some(event => event.type === 'ready'), false)
      return { evidence }
    }
    await Promise.race([ready, exit.then(() => { throw new Error('独立存储核对API提前退出：' + evidence.stderr) })])
    clearTimeout(timer)
    return { evidence, stop }
  } catch (error) {
    clearTimeout(timer)
    if (!evidence.exit) { child.kill(); await exit }
    throw error
  }
}

export function fileRecoveryFlow({ pool, instance, json, responseAfter, waitFor, origin, restartApi, suspendApi, browser, activate }) {
  return async function recovery(owner, ordinary) {
    const page = owner.page; activate(page)
    const schema = '"' + owner.schema + '"'
    const snapshots = (await pool.query(`SELECT c.id,c.candidate_no,r.id AS resume_id,r.storage_key,a.id AS application_id
      FROM ${schema}.candidates c JOIN ${schema}.resumes r ON r.candidate_id=c.id JOIN ${schema}.applications a ON a.candidate_id=c.id ORDER BY c.id`)).rows
    assert.equal(snapshots.length, 2)
    const protectedPerson = snapshots.find(row => row.application_id === owner.applicationId)
    assert.ok(protectedPerson)
    const target = snapshots.find(row => row.id !== protectedPerson.id)
    const storagePath = key => {
      const root = resolve(instance.env.RECRUITING_QUARANTINE_ROOT), path = resolve(root, key)
      assert.ok(path.startsWith(root + sep)); return path
    }
    const originalBytes = await readFile(storagePath(target.storage_key))
    const siblingBytes = await readFile(storagePath(protectedPerson.storage_key))
    const quietPages = async () => { for (const context of browser.contexts()) for (const current of context.pages()) await current.goto('about:blank') }
    await quietPages(); await restartApi(false)
    await page.goto(origin + '/candidates')
    const row = page.locator('.candidate-table tbody tr').filter({ has: page.getByRole('button', { name: '初试邀约', exact: true }) })
    await row.waitFor()
    assert.equal(await row.count(), 1)
    page.once('dialog', dialog => dialog.accept())
    await responseAfter(page, 'DELETE', '/applications/' + target.application_id, () => row.getByRole('button', { name: /^删除岗位申请/ }).click())
    page.once('dialog', dialog => dialog.accept())
    await responseAfter(page, 'DELETE', '/candidates/' + target.id, () => page.getByRole('button', { name: /^删除候选人/ }).click())
    const task = async () => (await pool.query('SELECT id,status,attempts,last_error,xmin::text AS recovery_version FROM public.object_cleanup_tasks WHERE organization_id=$1 AND storage_key=$2', [owner.id, target.storage_key])).rows[0]
    assert.equal((await task()).status, 'pending')
    assert.deepEqual(await readFile(storagePath(target.storage_key)), originalBytes)
    await quietPages(); await suspendApi()
    let differentLocation, failed, startupRejection
    try {
      startupRejection = await locationMismatchApi(instance, true)
      assert.equal((await task()).status, 'pending')
      differentLocation = await locationMismatchApi(instance)
      await waitFor(async () => (await task()).status === 'failed', '真实后台因存储位置改变而阻止物理删除', 25000)
      failed = await task()
      assert.equal(failed.attempts, 1)
      assert.match(failed.last_error, /存储位置未知或当前配置已变化/)
      assert.deepEqual(await readFile(storagePath(target.storage_key)), originalBytes)
      assert.deepEqual(await readFile(storagePath(protectedPerson.storage_key)), siblingBytes)
      assert.notEqual((await pool.query('SELECT status FROM public.object_write_intents WHERE storage_key=$1', [target.storage_key])).rows[0].status, 'deleted')
    } finally {
      try { await differentLocation?.stop() } finally { await restartApi(true) }
    }
    assert.equal((await pool.query('SELECT count(*)::int n FROM pg_stat_activity WHERE application_name=$1', [differentLocation.evidence.applicationName])).rows[0].n, 0)
    const endpoint = '/admin/operational-recovery/cleanup/' + failed.id + '/resolve'
    const decision = { action: 'retry', note: '已核实隔离API已恢复原存储位置，原文件仍存在且无业务引用，允许重新排队', version: failed.recovery_version }
    await ordinary.page.goto(origin + '/candidates')
    await page.goto(origin + '/administration?module=smtp')
    assert.equal((await json(ordinary.page, 'POST', endpoint, decision)).status, 403)
    assert.equal((await json(page, 'POST', endpoint, { ...decision, version: String(Number(failed.recovery_version) + 1) })).status, 409)
    assert.equal((await task()).status, 'failed')
    assert.equal((await json(page, 'POST', endpoint, { ...decision, note: '短' })).status, 400)
    await page.goto(origin + '/administration?module=smtp')
    const panel = page.getByRole('region', { name: '异常任务核对', exact: true })
    await panel.getByRole('tab', { name: '文件清理', exact: true }).click()
    const failedRow = panel.locator('tbody tr').filter({ has: page.locator('[title="' + failed.id + '"]') })
    await failedRow.getByRole('button', { name: '重新排队', exact: true }).waitFor()
    await page.screenshot({ path: join(instance.directory, 'file-recovery-location-guard.png'), fullPage: true })
    await failedRow.getByRole('button', { name: '重新排队', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '重新排队清理文件', exact: true })
    assert.equal(await dialog.getByRole('button', { name: '记录核对结果', exact: true }).isDisabled(), true)
    await dialog.getByLabel('核对依据', { exact: true }).fill(decision.note)
    await dialog.getByRole('checkbox', { name: /已核实服务日志及业务记录/ }).check()
    await responseAfter(page, 'POST', endpoint, () => dialog.getByRole('button', { name: '记录核对结果', exact: true }).click())
    await panel.getByText('核对结果已记录', { exact: true }).waitFor()
    assert.equal((await json(page, 'POST', endpoint, decision)).status, 409)
    await waitFor(async () => {
      const latest = await task()
      assert.notEqual(latest.status, 'failed', latest.last_error)
      return latest.status === 'completed'
    }, '恢复原存储后真实后台完成删除', 25000)
    await assert.rejects(readFile(storagePath(target.storage_key)), { code: 'ENOENT' })
    assert.deepEqual(await readFile(storagePath(protectedPerson.storage_key)), siblingBytes)
    assert.equal((await pool.query('SELECT status FROM public.object_write_intents WHERE storage_key=$1', [target.storage_key])).rows[0].status, 'deleted')
    assert.equal((await pool.query('SELECT count(*)::int n FROM public.stored_object_locations WHERE storage_key=$1', [target.storage_key])).rows[0].n, 0)
    for (const table of ['candidates', 'resumes', 'applications', 'analysis_tasks', 'analysis_results']) {
      const column = table === 'candidates' ? 'id' : ['resumes', 'applications'].includes(table) ? 'candidate_id' : 'resume_id'
      const id = ['analysis_tasks', 'analysis_results'].includes(table) ? target.resume_id : target.id
      assert.equal((await pool.query('SELECT count(*)::int n FROM ' + schema + '.' + table + ' WHERE ' + column + '=$1', [id])).rows[0].n, 0, '删除后不能残留：' + table)
    }
    assert.equal((await pool.query('SELECT candidate_no FROM ' + schema + '.candidates WHERE id=$1', [protectedPerson.id])).rows[0].candidate_no, protectedPerson.candidate_no)
    const audit = (await pool.query("SELECT actor_user_id,organization_id,metadata FROM public.platform_audit_logs WHERE action='operations.task.resolve' AND metadata->>'id'=$1", [failed.id])).rows
    assert.equal(audit.length, 1); assert.equal(audit[0].actor_user_id, owner.userId); assert.equal(audit[0].organization_id, owner.id)
    assert.equal(audit[0].metadata.kind, 'cleanup'); assert.equal(audit[0].metadata.note, decision.note)
    await panel.getByRole('button', { name: '刷新异常任务', exact: true }).click()
    await panel.getByText('暂无异常任务', { exact: true }).waitFor()
    await page.screenshot({ path: join(instance.directory, 'file-recovery-completed.png'), fullPage: true })
    return { taskId: failed.id, wrongStorageBlockedDeletion: true, realApiRestarts: 2, startupGateRejected: startupRejection.evidence,
      independentCleanupProcess: differentLocation.evidence, ordinaryUserDenied: true,
      staleVersionRejected: true, invalidNoteRejected: true, replayRejected: true, administratorUiRetry: true, auditCount: audit.length,
      naturalBackgroundDeletion: true, associationRemovalVerified: true, sameNamePersonPreserved: true, businessDatabaseModified: false }
  }
}
