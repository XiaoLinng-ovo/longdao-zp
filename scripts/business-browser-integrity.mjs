import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

export function integrityFlows({ pool, instance, json, responseAfter, waitFor, origin, workspaceIds, report, activate }) {
  async function deletion(company) {
    const page = company.page; activate(page)
    const schema = '"' + company.schema + '"'
    const protectedId = (await pool.query('SELECT candidate_id FROM ' + schema + '.applications WHERE id=$1', [company.applicationId])).rows[0].candidate_id
    for (const [path, code] of [['/candidates/' + protectedId, 'CANDIDATE_IN_USE'], ['/applications/' + company.applicationId, 'APPLICATION_IN_USE']]) {
      const denied = await json(page, 'DELETE', path)
      assert.equal(denied.status, 409)
      assert.equal(denied.body.error.code, code)
    }
    const snapshots = (await pool.query(`SELECT c.id,c.candidate_no,c.name,r.id AS resume_id,r.storage_key,a.id AS application_id
      FROM ${schema}.candidates c JOIN ${schema}.resumes r ON r.candidate_id=c.id
      JOIN ${schema}.applications a ON a.candidate_id=c.id ORDER BY c.id`)).rows
    assert.equal(snapshots.length, 3)
    const storagePath = key => {
      const root = resolve(instance.env.RECRUITING_QUARANTINE_ROOT), target = resolve(root, key)
      assert.ok(target.startsWith(root + sep), '仅读取专用测试存储中的对象')
      return target
    }
    for (const row of snapshots) assert.ok((await readFile(storagePath(row.storage_key))).length > 0)
    await page.goto(origin + '/candidates')
    const deletableRow = () => page.locator('.candidate-table tbody tr').filter({ has: page.getByRole('button', { name: '初试邀约', exact: true }) }).last()
    await deletableRow().getByRole('button', { name: '详情', exact: true }).click()
    await page.waitForURL(/\/candidates\/[^/?]+/)
    const reference = decodeURIComponent(new URL(page.url()).pathname.split('/').at(-1))
    const target = snapshots.find(row => row.id === reference || row.candidate_no === reference)
    assert.ok(target && target.id !== protectedId)
    await page.goto(origin + '/candidates')
    page.once('dialog', dialog => dialog.accept())
    await responseAfter(page, 'DELETE', '/applications/' + target.application_id, () => deletableRow().getByRole('button', { name: /^删除岗位申请/ }).click())
    for (const [table, id] of [['candidates', target.id], ['resumes', target.resume_id]]) assert.equal((await pool.query('SELECT count(*)::int n FROM ' + schema + '.' + table + ' WHERE id=$1', [id])).rows[0].n, 1)
    for (const table of ['analysis_tasks', 'analysis_results']) assert.equal((await pool.query('SELECT count(*)::int n FROM ' + schema + '.' + table + ' WHERE application_id=$1', [target.application_id])).rows[0].n, 0)
    assert.equal((await pool.query('SELECT count(*)::int n FROM public.object_cleanup_tasks WHERE storage_key=$1', [target.storage_key])).rows[0].n, 0)
    assert.ok((await readFile(storagePath(target.storage_key))).length > 0, '删除申请不能删除共享简历')
    page.once('dialog', dialog => dialog.accept())
    await responseAfter(page, 'DELETE', '/candidates/' + target.id, () => page.getByRole('button', { name: /^删除候选人/ }).click())
    for (const [table, column, id] of [['candidates', 'id', target.id], ['applications', 'candidate_id', target.id], ['resumes', 'candidate_id', target.id], ['analysis_tasks', 'resume_id', target.resume_id], ['analysis_results', 'resume_id', target.resume_id]]) {
      assert.equal((await pool.query('SELECT count(*)::int n FROM ' + schema + '.' + table + ' WHERE ' + column + '=$1', [id])).rows[0].n, 0, '删除档案后不能残留：' + table)
    }
    await waitFor(async () => {
      const task = (await pool.query('SELECT status,last_error FROM public.object_cleanup_tasks WHERE organization_id=$1 AND storage_key=$2', [company.id, target.storage_key])).rows[0]
      assert.ok(task)
      assert.notEqual(task.status, 'failed', '真实后台对象清理失败：' + task.last_error)
      return task.status === 'completed'
    }, '真实后台清理简历文件', 25000)
    await assert.rejects(readFile(storagePath(target.storage_key)), { code: 'ENOENT' })
    assert.equal((await pool.query('SELECT status FROM public.object_write_intents WHERE storage_key=$1', [target.storage_key])).rows[0].status, 'deleted')
    for (const sibling of snapshots.filter(row => row.id !== target.id)) {
      assert.equal((await pool.query('SELECT count(*)::int n FROM ' + schema + '.candidates WHERE id=$1', [sibling.id])).rows[0].n, 1)
      assert.ok((await readFile(storagePath(sibling.storage_key))).length > 0, '不能误删同名人员简历')
    }
    assert.equal((await json(page, 'GET', '/candidates/' + target.id)).status, 404)
    await page.reload()
    await page.getByRole('button', { name: '上传简历并建档', exact: true }).waitFor()
    await page.screenshot({ path: join(instance.directory, 'deletion-siblings-retained.png'), fullPage: true })
    return { deletedCandidateId: target.id, deletedResumeId: target.resume_id, applicationDeletionRetainedResume: true, physicalFileDeletedByBackground: true, sameNameSiblingsRetained: 2, protectedWorkflowDenied: true }
  }
  async function workspace(company) {
    const page = company.page; activate(page)
    const stale = await page.context().newPage()
    stale.setDefaultTimeout(12000)
    stale.on('pageerror', error => report.browserErrors.push(error.message))
    workspaceIds.set(stale, company.id)
    await stale.goto(origin + '/candidates')
    await stale.getByRole('button', { name: '上传简历并建档', exact: true }).waitFor()
    await page.goto(origin + '/workspaces')
    await page.getByLabel('企业名称', { exact: true }).fill('合成第三家公司')
    const created = await responseAfter(page, 'POST', '/workspaces', () => page.getByRole('button', { name: '新建企业', exact: true }).click(), 201)
    await page.waitForURL(origin + '/')
    workspaceIds.set(page, created.id)
    const current = await json(page, 'GET', '/me')
    assert.equal(current.body.data.user.workspaceId, created.id)
    assert.equal(current.body.data.user.role, 'recruiter')
    assert.ok(!current.body.data.user.isSystemAdmin)
    assert.equal((await json(page, 'GET', '/candidates')).body.data.length, 0)
    const schema = 'company_' + created.id.replaceAll('-', '')
    assert.equal((await pool.query('SELECT count(*)::int n FROM pg_namespace WHERE nspname=$1', [schema])).rows[0].n, 1)
    const before = (await pool.query('SELECT id,candidate_no FROM "' + company.schema + '".candidates ORDER BY id')).rows
    const rejected = []
    for (const [method, path, body] of [['GET', '/candidates', undefined], ['POST', '/candidates', { fullName: '旧页不应创建' }], ['DELETE', '/candidates/' + before[0].id, undefined]]) {
      const result = await json(stale, method, path, body)
      assert.equal(result.status, 409)
      assert.equal(result.body.error.code, 'WORKSPACE_CONTEXT_CHANGED')
      rejected.push({ method, path, code: result.body.error.code })
    }
    assert.deepEqual((await pool.query('SELECT id,candidate_no FROM "' + company.schema + '".candidates ORDER BY id')).rows, before)
    assert.equal((await pool.query('SELECT count(*)::int n FROM "' + schema + '".candidates')).rows[0].n, 0)
    await page.goto(origin + '/workspaces')
    await responseAfter(page, 'POST', '/workspaces/' + company.id + '/select', () => page.locator('article.workspace-row').filter({ hasText: '隔离浏览器企业1' }).getByRole('button', { name: '切换', exact: true }).click())
    await page.waitForURL(origin + '/')
    workspaceIds.set(page, company.id)
    assert.equal((await json(page, 'GET', '/candidates')).body.data.length, 2)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(origin + '/candidates')
    await waitFor(async () => await page.locator('.candidate-table tbody tr').count() === 2, '移动端真实候选人数据呈现')
    assert.equal(await page.locator('.loading-note').count(), 0)
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), '移动端页面不能整体横向溢出')
    await page.screenshot({ path: join(instance.directory, 'candidate-mobile.png'), fullPage: true })
    await page.setViewportSize({ width: 1440, height: 1000 })
    await stale.close()
    company.additionalWorkspaceId = created.id
    return { additionalWorkspaceId: created.id, emptyIsolatedSchema: true, staleReadWriteDeleteRejected: rejected, switchedBackCount: 2, mobileViewport: '390x844' }
  }
  async function administrator(owner, ordinary) {
    // This process contains only synthetic data; no business environment file is changed.
    assert.ok(!process.env.SYSTEM_ADMIN_USER_NO)
    process.env.SYSTEM_ADMIN_USER_NO = owner.userNo
    const own = await json(owner.page, 'GET', '/me'), other = await json(ordinary.page, 'GET', '/me')
    assert.equal(own.body.data.user.isSystemAdmin, true)
    assert.ok(!other.body.data.user.isSystemAdmin)
    for (const path of ['/admin/users', '/platform/users', '/admin/operational-recovery', '/platform/payments']) {
      assert.equal((await json(owner.page, 'GET', path)).status, 200, '唯一管理员应可访问：' + path)
      assert.equal((await json(ordinary.page, 'GET', path)).status, 403, '公司所有者不等于平台管理员：' + path)
    }
    assert.equal((await json(owner.page, 'POST', '/workspaces/' + owner.additionalWorkspaceId + '/select', {})).status, 200)
    workspaceIds.set(owner.page, owner.additionalWorkspaceId)
    assert.equal((await json(owner.page, 'GET', '/me')).body.data.user.isSystemAdmin, true, '管理员绑定账号而非公司')
    assert.equal((await json(owner.page, 'GET', '/admin/users')).status, 200)
    assert.equal((await json(owner.page, 'POST', '/workspaces/' + owner.id + '/select', {})).status, 200)
    workspaceIds.set(owner.page, owner.id)
    await owner.page.goto(origin + '/platform/users')
    await owner.page.locator('.platform-users-page').getByRole('heading', { name: '用户管理', exact: true }).waitFor()
    await owner.page.screenshot({ path: join(instance.directory, 'unique-platform-administrator.png'), fullPage: true })
    return { administratorUserNo: owner.userNo, companyOwnerNotAdministrator: true, sameAccountAcrossWorkspaces: true, protectedResources: 4 }
  }
  return { deletion, workspace, administrator }
}
