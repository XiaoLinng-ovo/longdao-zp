import assert from 'node:assert/strict'
import { join } from 'node:path'
import { decodeAudioEvidence, syntheticTranscript } from './local-asr-boundary.mjs'
import { browserAction } from './browser-action.mjs'

export function audioFlows({ pool, instance, json, responseAfter, waitFor, origin, boundary, activate }) {
  async function capture(company, outsider, interviewId, { screenshot = true } = {}) {
    const streamOffset = boundary.streams.length, requestOffset = boundary.requests.length
    const page = company.page; activate(page)
    const base = '/interviews/' + interviewId + '/recordings'
    await page.goto(origin + '/interviews/' + interviewId + '/live')
    const authorization = page.getByRole('dialog', { name: '开始面试录音', exact: true })
    await authorization.waitFor()
    const start = authorization.getByRole('button', { name: '确认授权并开始录音', exact: true })
    assert.equal(await start.isDisabled(), true, '没有告知同意不能开始录音')
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM "' + company.schema + '".interview_live_sessions WHERE interview_id=$1', [interviewId])).rows[0].n, 0)
    await authorization.getByLabel('确认录音采集方式', { exact: true }).selectOption('microphone')
    await authorization.locator('summary').click()
    await authorization.getByLabel('授权弹窗：本机麦克风角色', { exact: true }).selectOption('interviewer')
    await authorization.getByLabel('授权弹窗：本机麦克风包含多人', { exact: true }).uncheck()
    await authorization.getByRole('checkbox', { name: '我已告知参与者并取得录音、转写及 AI 辅助分析同意', exact: true }).check()
    const session = await responseAfter(page, 'POST', '/interviews/' + interviewId + '/live-sessions', () => start.click(), 201)
    company.audio = { interviewId, sessionId: session.id }
    await page.getByRole('button', { name: '暂停', exact: true }).waitFor()
    await waitFor(() => boundary.streams.slice(streamOffset).some(stream => stream.nonSilent && stream.bytes >= 64000), '本轮真实浏览器麦克风经计费网关送达本机流式边界')
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    await page.getByRole('button', { name: '继续', exact: true }).waitFor()
    await waitFor(async () => {
      const response = await json(page, 'GET', base)
      assert.equal(response.status, 200)
      return response.body.data.length > 0
    }, '真实录音分段持久化')
    await waitFor(async () => {
      const response = await json(page, 'GET', '/interview-live-sessions/' + session.id + '/transcription')
      assert.equal(response.status, 200)
      return response.body.data.pendingCount === 0 && response.body.data.retryingCount === 0 && response.body.data.segments.some(segment => segment.text.includes(syntheticTranscript))
    }, '真实后台消费分段音频并持久化转写', 30000)
    assert.ok(boundary.requests.length > requestOffset, '不能用先前请求或流式文字冒充本轮后台音频转写')
    const listed = await json(page, 'GET', base)
    const recordingId = listed.body.data[0].id
    for (const path of [base, base + '/' + recordingId, base + '/full?sessionId=' + session.id + '&source=all', '/interview-live-sessions/' + session.id + '/transcription']) {
      assert.equal((await json(outsider.page, 'GET', path)).status, 404, '其他公司不得读取音频或转写')
    }
    await page.getByRole('button', { name: '结束面试', exact: true }).click()
    await page.waitForURL(origin + '/interviews/' + interviewId + '?backgroundSave=1')
    await waitFor(async () => (await pool.query('SELECT status FROM "' + company.schema + '".interview_live_sessions WHERE id=$1', [session.id])).rows[0]?.status === 'completed', '真实后台交接并结束采集会话')
    await page.goto(origin + '/interviews/' + interviewId + '/live')
    await page.getByRole('button', { name: '查看原音频', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '面试整场录音', exact: true })
    const audio = dialog.locator('audio')
    await audio.waitFor()
    await waitFor(() => audio.evaluate(element => element.readyState >= 2 && Number.isFinite(element.duration) && element.duration > 0), '真实整场组装音频可解码播放')
    const playback = await audio.evaluate(async element => { await element.play(); return { duration: element.duration, start: element.currentTime } })
    await waitFor(() => audio.evaluate(element => element.currentTime > 0.2 && !element.error), '浏览器播放位置自然推进')
    await audio.evaluate(element => element.pause())
    const pending = page.waitForEvent('download')
    const download = await browserAction(pending, () => dialog.getByRole('button', { name: '下载整场音频', exact: true }).click())
    assert.equal(await download.failure(), null)
    const chunks = []; for await (const chunk of await download.createReadStream()) chunks.push(chunk)
    const decoded = await decodeAudioEvidence(Buffer.concat(chunks))
    await download.delete()
    assert.ok(decoded.durationMs > 1000)
    await dialog.getByRole('button', { name: '开始转写', exact: true }).click()
    await waitFor(async () => (await dialog.getByLabel('整段转写结果', { exact: true }).count()) > 0 && (await dialog.getByLabel('整段转写结果', { exact: true }).inputValue()).includes(syntheticTranscript), '真实全场音频组装、切片和后台转写', 30000)
    await dialog.getByRole('button', { name: '重新转写', exact: true }).waitFor()
    const tasks = (await pool.query('SELECT status,progress,inference_pending FROM public.full_audio_transcription_tasks WHERE organization_id=$1 AND session_id=$2 AND source=$3', [company.id, session.id, 'all'])).rows
    assert.equal(tasks.length, 1); assert.equal(tasks[0].status, 'completed'); assert.equal(tasks[0].progress, 100); assert.equal(tasks[0].inference_pending, false)
    if (screenshot) await page.screenshot({ path: join(instance.directory, 'audio-playback-transcribed.png'), fullPage: true })
    await dialog.getByRole('button', { name: '关闭原音频', exact: true }).click()
    assert.deepEqual(boundary.failures, [])
    return { interviewId, sessionId: session.id, recordingCount: listed.body.data.length, streamingPcm: boundary.streams.slice(streamOffset), playbackDuration: playback.duration, decodedDownload: decoded, fullTranscriptionCompleted: true, crossCompanyDenied: 4, noConsentPrevented: true, realRecognitionAccuracyVerified: false, answerAnalysisCovered: false }
  }

  async function recovery(administrator, member) {
    const page = administrator.page; activate(page)
    const { interviewId, sessionId } = administrator.audio
    await page.goto(origin + '/interviews/' + interviewId + '/live')
    await page.getByRole('button', { name: '查看原音频', exact: true }).click()
    const audio = page.getByRole('dialog', { name: '面试整场录音', exact: true })
    await audio.getByLabel('回听音源', { exact: true }).selectOption('microphone')
    await audio.getByRole('button', { name: '开始转写', exact: true }).waitFor()
    boundary.failNextTranscription()
    await audio.getByRole('button', { name: '开始转写', exact: true }).click()
    const findTask = async () => (await pool.query('SELECT id,status,attempts,lease_token,inference_pending,xmin::text AS recovery_version FROM public.full_audio_transcription_tasks WHERE organization_id=$1 AND session_id=$2 AND source=$3', [administrator.id, sessionId, 'microphone'])).rows[0]
    await waitFor(async () => (await findTask())?.status === 'unknown', '本机服务503由真实后台落为未知，不直接修改数据库', 30000)
    const task = await findTask(), callCount = boundary.requests.length
    assert.equal(task.inference_pending, true); assert.equal(task.lease_token, null)
    const base = '/admin/operational-recovery', resolve = base + '/audio/' + task.id + '/resolve'
    assert.equal((await json(member.page, 'GET', base)).status, 403)
    const decision = { action: 'stop', note: '已核对本机合成语音服务日志，终止未知任务', version: task.recovery_version }
    assert.equal((await json(member.page, 'POST', resolve, decision)).status, 403)
    const listing = await json(page, 'GET', base)
    assert.equal(listing.status, 200); assert.equal(listing.body.data.audioLookup.supported, false)
    assert.ok(listing.body.data.audio.some(row => row.id === task.id && row.status === 'unknown'))
    assert.equal((await json(page, 'POST', resolve, { ...decision, version: String(Number(task.recovery_version) + 1) })).status, 409)
    assert.equal((await findTask()).status, 'unknown')
    await audio.getByRole('button', { name: '关闭原音频', exact: true }).click()
    await page.goto(origin + '/administration?module=smtp')
    const panel = page.getByRole('region', { name: '异常任务核对', exact: true })
    await panel.getByRole('tab', { name: '整场转写', exact: true }).click()
    await panel.getByRole('button', { name: '核对并终止', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '核对并终止未知转写，不再自动重试', exact: true })
    assert.equal(await dialog.getByRole('button', { name: '记录核对结果', exact: true }).isDisabled(), true)
    await dialog.getByLabel('核对依据', { exact: true }).fill(decision.note)
    await dialog.getByRole('checkbox', { name: /已核实服务日志及业务记录/ }).check()
    await responseAfter(page, 'POST', resolve, () => dialog.getByRole('button', { name: '记录核对结果', exact: true }).click())
    await panel.getByText('核对结果已记录', { exact: true }).waitFor()
    const stopped = await findTask()
    assert.equal(stopped.status, 'failed'); assert.ok(stopped.attempts >= 3); assert.equal(stopped.inference_pending, true)
    assert.equal((await json(page, 'POST', resolve, decision)).status, 409)
    const audit = (await pool.query("SELECT actor_user_id,organization_id,metadata FROM public.platform_audit_logs WHERE action='operations.task.resolve' AND metadata->>'id'=$1", [task.id])).rows
    assert.equal(audit.length, 1); assert.equal(audit[0].actor_user_id, administrator.userId); assert.equal(audit[0].organization_id, administrator.id)
    assert.equal(audit[0].metadata.note, decision.note)
    assert.equal(boundary.requests.length, callCount, '未知任务不能自动重提识别')
    assert.deepEqual(boundary.failures, [])
    await page.screenshot({ path: join(instance.directory, 'audio-recovery-stopped.png'), fullPage: true })
    return { taskId: task.id, generatedByRealBackground503: true, memberDenied: 2, staleVersionRejected: true, duplicateResolveRejected: true, auditedOnce: true, inferenceNotResubmitted: true, providerLookupSupported: false }
  }
  return { capture, recovery }
}
