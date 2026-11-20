import assert from 'node:assert/strict'
import { join } from 'node:path'
import { browserAction } from './browser-action.mjs'

async function downloadedBytes(download) {
  assert.equal(await download.failure(), null)
  const chunks = []
  for await (const chunk of await download.createReadStream()) chunks.push(chunk)
  return Buffer.concat(chunks)
}

export function supportFlow({ pool, instance, json, responseAfter, origin, activate }) {
  return async function verifySupport(administrator, member) {
    const page = member.page; activate(page)
    const base = '/payments/workspaces/' + member.id + '/service'
    const source = Buffer.from('合成附件：仅用于本机隔离工单验收。\n', 'utf8')
    await page.goto(origin + '/enterprise/payments#enterprise-service')
    const panel = page.getByRole('region', { name: '企业数据与服务支持', exact: true })
    await panel.getByLabel('问题说明', { exact: true }).fill('合成服务问题：请核对企业服务状态')
    await panel.locator('form').first().getByLabel('添加附件', { exact: true }).setInputFiles({ name: '合成说明.txt', mimeType: 'text/plain', buffer: source })
    const submitted = await responseAfter(page, 'POST', base + '/requests', () => panel.getByRole('button', { name: '提交服务工单', exact: true }).click())
    assert.equal(submitted.existing, false)
    const id = submitted.request.id, path = base + '/requests/' + id
    const rows = async () => (await pool.query(`SELECT m.id,a.id AS attachment_id,a.content FROM public.enterprise_service_messages m
      LEFT JOIN public.enterprise_service_attachments a ON a.message_id=m.id WHERE m.request_id=$1 ORDER BY m.created_at,m.id`, [id])).rows
    const initial = await rows()
    assert.equal(initial.length, 1)
    assert.deepEqual(initial[0].content, source)
    await panel.getByRole('button', { name: '企业已有待处理工单', exact: true }).waitFor()
    assert.ok(await panel.getByLabel('问题说明', { exact: true }).isDisabled())
    const duplicate = await json(page, 'POST', base + '/requests', { message: '重复创建不应增加消息', attachments: [] })
    assert.equal(duplicate.status, 200)
    assert.equal(duplicate.body.data.existing, true)
    assert.equal(duplicate.body.data.request.id, id)
    assert.equal((await rows()).length, 1)

    const rejected = []
    for (const [method, target, body, expected] of [
      ['GET', path, undefined, 403],
      ['GET', '/payments/workspaces/' + administrator.id + '/service/requests/' + id, undefined, 404],
      ['GET', '/payments/workspaces/' + administrator.id + '/service/requests/' + id + '/attachments/' + initial[0].attachment_id, undefined, 404],
      ['POST', '/payments/workspaces/' + administrator.id + '/service/requests/' + id + '/messages', { message: '不能跨公司回复', attachments: [] }, 404],
    ]) {
      const response = await json(administrator.page, method, target, body, {}, target === path ? member.id : administrator.id)
      assert.equal(response.status, expected, target)
      rejected.push({ method, code: response.body.error.code })
    }
    assert.equal((await json(page, 'GET', '/platform/payments/service-requests/' + id)).status, 403)
    const before = await rows()
    for (const attachments of [
      [{ filename: '伪装图片.png', base64: Buffer.from('<script>not an image</script>').toString('base64') }],
      [{ filename: '../越界.txt', base64: source.toString('base64') }],
      Array.from({ length: 4 }, () => ({ filename: '重复.txt', base64: source.toString('base64') })),
    ]) assert.equal((await json(page, 'POST', path + '/messages', { message: '无效附件不能入库', attachments })).status, 400)
    const resolveDenied = await json(page, 'POST', path + '/messages', { message: '普通用户不能完成工单', attachments: [], resolve: true })
    assert.equal(resolveDenied.status, 403)
    assert.deepEqual(await rows(), before)

    await panel.getByRole('button', { name: '查看会话 / 附件 / 继续追问', exact: true }).click()
    const thread = panel.getByRole('region', { name: '工单会话', exact: true })
    const downloadPending = page.waitForEvent('download')
    const download = await browserAction(downloadPending, () => thread.getByRole('button', { name: /^下载 合成说明\.txt/ }).click())
    assert.equal(download.suggestedFilename(), '合成说明.txt')
    assert.deepEqual(await downloadedBytes(download), source)
    await download.delete()
    await thread.getByLabel('继续追问 / 补充说明', { exact: true }).fill('合成追问：附件已核对')
    await responseAfter(page, 'POST', path + '/messages', () => thread.getByRole('button', { name: '发送追问', exact: true }).click())
    assert.equal((await rows()).length, 2)

    activate(administrator.page)
    await administrator.page.goto(origin + '/platform/payments')
    await administrator.page.getByRole('tab', { name: '企业服务工单', exact: true }).click()
    const adminPanel = administrator.page.getByRole('region', { name: '企业服务工单', exact: true })
    await adminPanel.getByRole('button', { name: '查看会话 / 附件 / 继续追问', exact: true }).click()
    const adminThread = adminPanel.getByRole('region', { name: '工单会话', exact: true })
    await adminThread.getByLabel('回复企业成员', { exact: true }).fill('合成管理员回复：已核对本机测试记录')
    const reply = await responseAfter(administrator.page, 'POST', '/platform/payments/service-requests/' + id + '/messages', () => adminThread.getByRole('button', { name: '回复并完成工单', exact: true }).click())
    assert.equal(reply.request.status, 'resolved')
    assert.equal(reply.messages.length, 3)
    assert.equal(reply.messages.at(-1).authorKind, 'administrator')
    const resolved = (await pool.query('SELECT status,resolved_by FROM public.enterprise_service_requests WHERE id=$1', [id])).rows[0]
    assert.equal(resolved.status, 'resolved')
    assert.equal(resolved.resolved_by, administrator.userId)

    activate(page)
    await page.reload()
    await panel.getByRole('button', { name: '查看会话 / 附件 / 继续追问', exact: true }).click()
    await thread.getByText('合成管理员回复：已核对本机测试记录', { exact: true }).waitFor()
    await thread.getByLabel('继续追问 / 补充说明', { exact: true }).fill('合成再次追问：验证重新打开')
    const reopened = await responseAfter(page, 'POST', path + '/messages', () => thread.getByRole('button', { name: '发送追问', exact: true }).click())
    assert.equal(reopened.request.status, 'open')
    assert.equal(reopened.messages.length, 4)
    const stored = (await pool.query('SELECT status,resolved_by,resolved_at FROM public.enterprise_service_requests WHERE id=$1', [id])).rows[0]
    assert.equal(stored.status, 'open'); assert.equal(stored.resolved_by, null); assert.equal(stored.resolved_at, null)
    await page.screenshot({ path: join(instance.directory, 'support-thread-reopened.png'), fullPage: true })
    return { requestId: id, messages: 4, attachmentBytes: source.length, browserDownloadMatches: true, duplicateCreateKeptSingleThread: true, invalidAttachmentsRejected: 3, ordinaryResolveDenied: true, crossCompanyDenied: rejected, administratorResolved: true, memberReopened: true }
  }
}
