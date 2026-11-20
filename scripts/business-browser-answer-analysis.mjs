import assert from 'node:assert/strict'
import { join } from 'node:path'
import { syntheticAnswer } from './local-model-boundary.mjs'
import { browserAction } from './browser-action.mjs'

export function answerAnalysisFlow({ pool, instance, json, responseAfter, waitFor, origin, asr, model, activate }) {
  return async function analyze(company, outsider, interviewId) {
    const page = company.page; activate(page)
    const schema = '"' + company.schema + '"'
    const workflow = async () => (await pool.query(`SELECT i.status AS interview_status,a.status AS application_status,
      (SELECT count(*)::int FROM ${schema}.workflow_events WHERE subject_id=i.id) AS events
      FROM ${schema}.interviews i JOIN ${schema}.applications a ON a.id=i.application_id WHERE i.id=$1`, [interviewId])).rows[0]
    const before = await workflow()
    const modelCount = () => model.requests.filter(request => request.kind === 'answer').length
    const startingCalls = modelCount()
    asr.setAvailable(false)
    try {
      await page.goto(origin + '/interviews/' + interviewId + '/live')
      const authorization = page.getByRole('dialog', { name: '开始面试录音', exact: true })
      await authorization.waitFor()
      await authorization.getByRole('checkbox', { name: '我已告知参与者并取得录音、转写及 AI 辅助分析同意', exact: true }).check()
      await authorization.getByRole('button', { name: '稍后设置', exact: true }).click()
      const session = await responseAfter(page, 'POST', '/interviews/' + interviewId + '/live-sessions',
        () => page.getByRole('button', { name: '仅手动记录', exact: true }).click(), 201)
      const entry = page.locator('.manual-entry')
      await entry.locator('select').selectOption('candidate')
      await entry.getByPlaceholder('输入本轮发言内容', { exact: true }).fill(syntheticAnswer)
      const automatic = page.waitForResponse(response => /\/interview-live-segments\/[^/]+\/analyze$/.test(new URL(response.url()).pathname)
        && response.request().method() === 'POST')
      const [response, [segment]] = await Promise.all([automatic,
        responseAfter(page, 'POST', '/interview-live-sessions/' + session.id + '/segments',
          () => entry.getByRole('button', { name: '添加发言', exact: true }).click(), 201)])
      assert.equal(segment.text, syntheticAnswer); assert.equal(segment.role, 'candidate')
      assert.equal(response.status(), 200, await response.text())
      const analysis = (await response.json()).data
      assert.equal(analysis.advisoryOnly, true); assert.equal(analysis.applicationStatusMutation, 'none')
      assert.deepEqual(analysis.evidence, [syntheticAnswer]); assert.equal(analysis.scores[0].score, 8)
      assert.equal(analysis.sourceSegments[0].id, segment.id)
      assert.equal(modelCount(), startingCalls + 1)
      const utterance = page.locator('.utterance[data-role="candidate"]')
      await utterance.locator('.refined-answer').getByText(syntheticAnswer, { exact: true }).waitFor()
      const endpoint = '/interview-live-segments/' + segment.id
      const countBeforeDenied = modelCount()
      for (const [suffix, body] of [
        ['/role', { role: 'interviewer', segmentIds: [segment.id] }],
        ['/analyze', { question: '跨公司伪造提问', segmentIds: [segment.id] }],
        ['/refinement', { text: '不应保存', expectedText: syntheticAnswer, sourceSegments: analysis.sourceSegments }],
      ]) {
        const denied = await json(outsider.page, 'POST', endpoint + suffix, body)
        assert.equal(denied.status, 404)
        assert.equal(denied.body.error.code, 'LIVE_SEGMENT_NOT_FOUND')
      }
      assert.equal(modelCount(), countBeforeDenied, '越权请求不能触发模型调用')
      const forged = await json(page, 'POST', endpoint + '/analyze', { question: '伪造的参考问题，不属于真实对话', segmentIds: [segment.id] })
      assert.equal(forged.status, 200, JSON.stringify(forged.body))
      assert.equal(modelCount(), startingCalls + 2)
      const stored = async () => (await pool.query(`SELECT s.text,s.role,a.question,a.evidence,a.scores,a.source_segments,a.transcript_refinement
        FROM ${schema}.interview_live_segments s JOIN ${schema}.interview_live_analyses a ON a.segment_id=s.id WHERE s.id=$1`, [segment.id])).rows[0]
      assert.equal((await stored()).question, '')
      let editedText = syntheticAnswer + '（人工核对标注）'
      await utterance.getByRole('button', { name: '编辑整理后的回答', exact: true }).click()
      await utterance.getByRole('textbox', { name: '编辑整理后的回答', exact: true }).fill(editedText)
      const refinement = await responseAfter(page, 'POST', endpoint + '/refinement',
        () => utterance.getByRole('button', { name: '保存修改', exact: true }).click())
      assert.equal(refinement.text, editedText); assert.equal(refinement.editedBy, company.userId)
      await utterance.getByText('已手动编辑', { exact: true }).waitFor()
      const stale = await json(page, 'POST', endpoint + '/refinement', { text: '旧页面不应覆盖', expectedText: syntheticAnswer, sourceSegments: analysis.sourceSegments })
      assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'TRANSCRIPT_REFINEMENT_CONFLICT')
      const saved = await stored()
      assert.equal(saved.text, syntheticAnswer); assert.equal(saved.role, 'candidate')
      assert.equal(saved.transcript_refinement.text, editedText)
      assert.deepEqual(saved.evidence, [syntheticAnswer]); assert.equal(saved.scores[0].score, 8)
      assert.deepEqual(saved.source_segments, analysis.sourceSegments)
      const faultPath = origin + '/api/v1' + endpoint + '/refinement'
      const editor = utterance.locator('.refinement-editor')
      const draftInput = () => editor.getByRole('textbox', { name: '编辑整理后的回答', exact: true })
      const saveButton = () => editor.getByRole('button', { name: '保存修改', exact: true })
      const failedRequest = () => page.waitForEvent('requestfailed', request => request.method() === 'POST' && request.url() === faultPath)
      const blockedDraft = editedText + '（请求未发送）'
      const block = route => route.abort('connectionreset')
      await page.route(faultPath, block)
      try {
        await editor.getByRole('button', { name: '编辑整理后的回答', exact: true }).click()
        await draftInput().fill(blockedDraft)
        await browserAction(failedRequest(), () => saveButton().click())
        await editor.getByRole('alert').waitFor()
        assert.equal(await draftInput().inputValue(), blockedDraft)
        assert.equal((await stored()).transcript_refinement.text, editedText)
      } finally { await page.unroute(faultPath, block) }
      const retried = await responseAfter(page, 'POST', endpoint + '/refinement', () => saveButton().click())
      assert.equal(retried.text, blockedDraft); editedText = blockedDraft
      const uncertainDraft = editedText + '（真实提交后响应丢失）'
      let committed = false
      const loseResponse = async route => {
        const actual = await route.fetch({ maxRetries: 0 })
        assert.equal(actual.status(), 200)
        assert.equal((await actual.json()).data.text, uncertainDraft)
        await actual.dispose(); committed = true
        await route.abort('connectionreset')
      }
      await page.route(faultPath, loseResponse)
      try {
        await editor.getByRole('button', { name: '编辑整理后的回答', exact: true }).click()
        await draftInput().fill(uncertainDraft)
        await browserAction(failedRequest(), () => saveButton().click())
        await editor.getByRole('alert').waitFor()
        assert.ok(committed); assert.equal(await draftInput().inputValue(), uncertainDraft)
        assert.equal((await stored()).transcript_refinement.text, uncertainDraft)
      } finally { await page.unroute(faultPath, loseResponse) }
      const conflict = page.waitForResponse(response => response.url() === faultPath && response.request().method() === 'POST')
      const rejected = await browserAction(conflict, () => saveButton().click())
      assert.equal(rejected.status(), 409); assert.equal((await rejected.json()).error.code, 'TRANSCRIPT_REFINEMENT_CONFLICT')
      assert.equal(await draftInput().inputValue(), uncertainDraft)
      assert.equal((await stored()).transcript_refinement.text, uncertainDraft)
      await editor.getByRole('button', { name: '取消', exact: true }).click()
      editedText = uncertainDraft
      assert.deepEqual(await workflow(), before, '分析和编辑不能擅自推进业务状态或写录用结论')
      await page.screenshot({ path: join(instance.directory, 'answer-analysis-edited.png'), fullPage: true })
      await page.getByRole('button', { name: '结束面试', exact: true }).click()
      await page.waitForURL(origin + '/interviews/' + interviewId + '?backgroundSave=1')
      await waitFor(async () => (await pool.query(`SELECT status FROM ${schema}.interview_live_sessions WHERE id=$1`, [session.id])).rows[0]?.status === 'completed', '手动会话正常结束')
      await page.goto(origin + '/interviews/' + interviewId + '/live')
      await page.locator('.refined-answer').getByText(editedText, { exact: true }).waitFor()
      await page.getByText('已手动编辑', { exact: true }).waitFor()
      assert.equal(modelCount(), startingCalls + 2, '刷新已结束面试不能额外分析')
      assert.deepEqual(model.failures, [])
      await page.screenshot({ path: join(instance.directory, 'answer-analysis-reloaded.png'), fullPage: true })
      return { sessionId: session.id, segmentId: segment.id, manualUiCreatedSpeech: true, automaticAnalysisSaved: true,
        realModelHttpCalls: modelCount() - startingCalls, crossCompany404: 3, deniedRequestsDidNotCallModel: true,
        forgedQuestionIgnored: true, originalSpeechPreserved: true, staleEditRejected: true, editedTextReloaded: true,
        noWorkflowMutation: true, requestFailureDraftPreserved: true, manualRetryAfterUnsentSucceeded: true,
        realCommitResponseLost: true, uncertainRetryConflictNoOverwrite: true, uncertainResultReloaded: true,
        realModelQualityVerified: false, realRecognitionAccuracyVerified: false }
    } finally { asr.setAvailable(true) }
  }
}
