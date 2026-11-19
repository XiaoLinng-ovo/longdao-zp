// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import EnterpriseAiUsagePage from './EnterpriseAiUsagePage.vue'
import { getAiUsage, getUsageReviews, addUsageReview, type AiUsageReport, type UsageItem } from '../api/ai-usage'
import { authSession } from '../../auth/session'
vi.mock('../api/payments', () => ({ getEnterpriseBilling: vi.fn(async () => ({ enabled: false, rules: {}, resources: [], tasks: [] })) }))
vi.mock('../api/ai-usage', () => ({ getAiUsage: vi.fn(), getUsageReviews: vi.fn(), addUsageReview: vi.fn() }))
vi.mock('../../auth/session', async () => ({ authSession: (await import('vue')).reactive({ user: { id: 'owner', workspaceId: 'org-a' }, sessionId: 'session-a' }) }))
const report: AiUsageReport = { billingSource: 'platform_model', chargeAmount: null, unit: 'successful_generation', scope: ['job_spec', 'jd'], summary: { total: 0, settled: 0, released: 0, reserved: 0, reconciliation: 0 }, items: [], page: 1, pageSize: 20, filteredTotal: 0 }
const item = (props: Partial<UsageItem> = {}): UsageItem => ({ id: 'task-a', operation: 'jd', model: 'fixture-model', state: 'uncertain', settledUnits: 0, createdAt: '2026-10-13T00:00:00.000Z', finishedAt: null, requestId: null, durationMs: null, failureCategory: null, needsReconciliation: true, reviewCount: 0, ...props })
let app: App, root: HTMLDivElement
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await nextTick(); await new Promise(r => setTimeout(r, 0)) }
const button = (text: string) => Array.from(root.querySelectorAll('button')).find(b => b.textContent?.includes(text))!
async function mount(data: AiUsageReport = report) { vi.mocked(getAiUsage).mockResolvedValue(data); root = document.createElement('div'); document.body.appendChild(root); app = createApp(EnterpriseAiUsagePage); app.mount(root); await flush() }
async function open() { button('查看 / 添加核对').click(); await flush() }
async function inputNote(text = '等待服务商账单核对') { const field = root.querySelector('textarea')!; field.value = text; field.dispatchEvent(new Event('input')); await nextTick() }
beforeEach(() => { Object.assign(authSession, { user: { id: 'owner', workspaceId: 'org-a' }, sessionId: 'session-a' }); vi.mocked(getUsageReviews).mockResolvedValue({ items: [], limit: 20 }); vi.stubGlobal('crypto', { randomUUID: () => 'a4e04b87-f1cd-46db-95a3-f0ab090e095b' }) })
afterEach(() => { app?.unmount(); root?.remove(); vi.resetAllMocks(); vi.unstubAllGlobals() })
describe('enterprise AI usage diagnostics and reconciliation', () => {
 it('states the ledger scope, counting basis and snapshot freshness without claiming cost coverage', async () => {
  await mount()
  const scope = root.querySelector('[aria-label="用量统计口径"]')!.textContent!
  expect(scope).toContain('岗位说明书、JD')
  expect(scope).toContain('不涵盖简历分析、面试分析及语音转写的全部消耗')
  expect(scope).toContain('不随筛选变化')
  expect(scope).toContain('企业可用余额和扣费流水见上方共享额度')
  expect(scope).toContain('非实时同步时间')
  expect(scope).not.toContain('未记录')
 })
 it('treats filter input as Beijing time regardless of the browser timezone', async () => {
  await mount()
  const fields = root.querySelectorAll<HTMLInputElement>('input[type="datetime-local"]')
  for (const [index, value] of ['2026-11-10T09:00', '2026-11-10T18:00'].entries()) {
   fields[index]!.value = value; fields[index]!.dispatchEvent(new Event('input'))
  }
  await nextTick(); root.querySelector('form')!.dispatchEvent(new Event('submit')); await flush()
  expect(getAiUsage).toHaveBeenLastCalledWith(1, { from: '2026-11-10T01:00:00.000Z', to: '2026-11-10T10:00:00.000Z' })
 })
 it('rejects reversed time ranges without fetching another report', async () => {
  await mount()
  const fields = root.querySelectorAll<HTMLInputElement>('input[type="datetime-local"]')
  fields[0]!.value = '2026-11-10T18:00'; fields[1]!.value = '2026-11-10T09:00'
  fields.forEach(field => field.dispatchEvent(new Event('input')))
  await nextTick(); root.querySelector('form')!.dispatchEvent(new Event('submit')); await flush()
  expect(root.querySelector('[role="alert"]')?.textContent).toContain('结束时间必须晚于开始时间')
  expect(getAiUsage).toHaveBeenCalledTimes(1)
 })
 it('uses Chinese fallbacks for future ledger enums and does not show member identifiers as names', async () => {
  vi.mocked(getUsageReviews).mockResolvedValue({ items: [{ id: 'note', actorId: 'internal-member-uuid', outcome: 'future_outcome' as never, note: '已记录证据', createdAt: '2026-11-10T01:00:00Z' }], limit: 20 })
  await mount({ ...report, scope: ['future_operation'], items: [item({ operation: 'future_operation' as never, failureCategory: 'future_failure' as never })] })
  await open()
  expect(root.textContent).toContain('其他生成类型')
  expect(root.textContent).toContain('失败原因待核实')
  expect(root.textContent).toContain('处理进度待确认')
  expect(root.textContent).toContain('企业成员（姓名未记录）')
  expect(root.textContent).toContain('2026-11-10 09:00:00')
  for (const raw of ['internal-member-uuid', 'future_operation', 'future_failure', 'future_outcome']) expect(root.textContent).not.toContain(raw)
 })
 it('redacts technical errors in both list and detail failures', async () => {
  await mount({ ...report, items: [item()] })
  vi.mocked(getUsageReviews).mockRejectedValueOnce(new Error('读取失败：TypeError: private stack'))
  await open()
  expect(root.querySelector('.review-panel [role="alert"]')?.textContent).toBe('读取核对记录失败')
  vi.mocked(getAiUsage).mockRejectedValueOnce(new Error('读取失败：duplicate key violates constraint private_table'))
  button('刷新用量').click(); await flush()
  expect(root.querySelector('[role="alert"]')?.textContent).toBe('读取 AI 用量失败')
  expect(root.querySelector('[aria-label="用量统计口径"]')).toBeNull()
 })
 it('hides model names for enterprise accounts including enterprise administrators', async () => {
  Object.assign(authSession.user!, { role: 'admin' })
  await mount({ ...report, filteredTotal: 1, items: [item({ model: 'private-model-name' })] })
  expect(root.querySelector('table[aria-label="AI 调用记录"] th')?.textContent).toBe('生成类型')
  expect(root.textContent).not.toContain('private-model-name')
  expect(root.querySelector('table[aria-label="AI 调用记录"] tbody td')?.textContent).toBe('JD')
 })
 it('shows model names only for platform admins and hides them when the identity changes', async () => {
  Object.assign(authSession.user!, { platformRole: 'admin' })
  await mount({ ...report, filteredTotal: 1, items: [item({ model: 'admin-model-name' })] })
  expect(root.querySelector('table[aria-label="AI 调用记录"] th')?.textContent).toBe('生成类型 / 模型')
  expect(root.textContent).toContain('admin-model-name')
  Object.assign(authSession.user!, { platformRole: 'viewer' })
  await nextTick()
  expect(root.querySelector('table[aria-label="AI 调用记录"] th')?.textContent).toBe('生成类型')
  expect(root.textContent).not.toContain('admin-model-name')
 })
 it('shows empty filtered results without the removed BYOK notice', async () => {
  await mount(); expect(getAiUsage).toHaveBeenCalledWith(1, {}); expect(root.textContent).toContain('暂无调用记录'); expect(root.textContent).not.toContain('企业自带模型 · 不扣款'); expect(root.textContent).not.toContain('不是 Token 数或账单金额'); expect(root.textContent).not.toContain('语音转写尚不计入')
 })
 it('shows safe diagnostics and historical missing evidence without claiming a refund', async () => {
  await mount({ ...report, filteredTotal: 3, summary: { total: 3, settled: 1, released: 1, reserved: 0, reconciliation: 1 }, items: [item({ id: '1', state: 'settled', settledUnits: 1, needsReconciliation: false }), item({ id: '2', state: 'released', needsReconciliation: false, failureCategory: 'upstream_rejected', durationMs: 1234 }), item({ id: '3' })] })
  expect(root.querySelectorAll('table[aria-label="AI 调用记录"] tbody tr')).toHaveLength(3); expect(root.textContent).toContain('已结算'); expect(root.textContent).toContain('已释放（生成未完成）'); expect(root.textContent).toContain('服务商拒绝请求'); expect(root.textContent).toContain('1.23 秒'); expect(root.textContent).toContain('暂无失败分类证据'); expect(root.textContent).toContain('结果不确定时不会自动再次调用')
 })
 it('uses filtered count for pagination and prevents duplicate refresh', async () => {
  await mount({ ...report, filteredTotal: 21, summary: { ...report.summary, total: 88 } }); let finish!: (r: AiUsageReport) => void
  vi.mocked(getAiUsage).mockImplementationOnce(() => new Promise(resolve => { finish = resolve })); button('下一页').click(); await nextTick(); expect(button('读取中').disabled).toBe(true); button('读取中').click(); expect(getAiUsage).toHaveBeenCalledTimes(2)
  finish({ ...report, filteredTotal: 21, page: 2 }); await flush(); expect(root.textContent).toContain('第 2 页'); expect(button('下一页').disabled).toBe(true); button('上一页').click(); await flush(); expect(getAiUsage).toHaveBeenLastCalledWith(1, {})
 })
 it('applies operation and review filters then resets the page', async () => {
  await mount(); const field = root.querySelector('select')!; field.value = 'jd'; field.dispatchEvent(new Event('change')); root.querySelector<HTMLInputElement>('[type=checkbox]')!.click(); await nextTick(); root.querySelector('form')!.dispatchEvent(new Event('submit')); await flush(); expect(getAiUsage).toHaveBeenLastCalledWith(1, { operation: 'jd', reviewOnly: true }); button('重置').click(); await flush(); expect(getAiUsage).toHaveBeenLastCalledWith(1, {})
 })
 it('clears old enterprise data when refresh fails', async () => {
  await mount({ ...report, summary: { ...report.summary, total: 88 } }); vi.mocked(getAiUsage).mockRejectedValueOnce(new Error('企业资格已变化')); button('刷新用量').click(); await flush(); expect(root.querySelector('[role=alert]')?.textContent).toContain('企业资格已变化'); expect(root.querySelector('.stats')).toBeNull(); button('刷新用量').click(); await flush(); expect(root.querySelector('.stats')).not.toBeNull()
 })
 it('keeps stale reservation in reconciliation and allows a note without altering state', async () => {
  const record = item({ state: 'reserved' }); await mount({ ...report, filteredTotal: 1, items: [record] }); await open(); expect(root.querySelector('table[aria-label="AI 调用记录"] tbody')?.textContent).toContain('待对账'); expect(root.textContent).toContain('历史记录未保存请求编号'); await inputNote(); vi.mocked(addUsageReview).mockResolvedValue({ item: { id: 'note-1', outcome: 'awaiting_provider', note: '等待服务商账单核对', createdAt: record.createdAt, actorId: 'owner' }, replayed: false }); button('保存核对记录').click(); await flush(); expect(addUsageReview).toHaveBeenCalledTimes(1); expect(record.state).toBe('reserved'); expect(record.settledUnits).toBe(0); expect(root.textContent).toContain('调用状态与结算次数保持不变'); expect(root.querySelectorAll('.reviews li')).toHaveLength(1)
 })
 it('retries lost responses with identical durable key and content; prevents another note', async () => {
  await mount({ ...report, filteredTotal: 1, items: [item()] }); await open(); await inputNote(); vi.mocked(addUsageReview).mockRejectedValueOnce(new Error('network lost')); button('保存核对记录').click(); await flush(); expect(root.querySelector('textarea')?.disabled).toBe(true); expect(button('刷新用量').disabled).toBe(true); button('重试保存同一记录').click(); await flush(); expect(vi.mocked(addUsageReview).mock.calls[1]).toEqual(vi.mocked(addUsageReview).mock.calls[0])
 })
 it('clears an old delayed response after workspace switch', async () => {
  await mount(); let finish!: (r: AiUsageReport) => void; vi.mocked(getAiUsage).mockImplementationOnce(() => new Promise(resolve => { finish = resolve })); button('刷新用量').click(); await nextTick(); Object.assign(authSession, { user: { id: 'owner', workspaceId: 'org-b' } }); await flush(); expect(getAiUsage).toHaveBeenCalledTimes(3); finish({ ...report, items: [item({ model: 'PRIVATE ORG A' })] }); await flush(); expect(root.textContent).not.toContain('PRIVATE ORG A'); expect(root.querySelector('.review-panel')).toBeNull()
 })
 it('ignores delayed detail from another selected task', async () => {
  await mount({ ...report, items: [item(), item({ id: 'task-b' })], filteredTotal: 2 }); let finish!: (r: Awaited<ReturnType<typeof getUsageReviews>>) => void; vi.mocked(getUsageReviews).mockImplementationOnce(() => new Promise(resolve => { finish = resolve })); button('查看 / 添加核对').click(); await nextTick(); root.querySelectorAll<HTMLButtonElement>('table[aria-label="AI 调用记录"] tbody button')[1]!.click(); await flush(); finish({ items: [{ id: 'old-note', outcome: 'evidence_recorded', note: 'OTHER TASK PRIVATE', createdAt: '2026-10-13T00:00:00Z', actorId: 'owner' }], limit: 20 }); await flush(); expect(root.textContent).not.toContain('OTHER TASK PRIVATE'); expect(root.querySelector('.trace')?.textContent).toContain('task-b')
 })
 it('does not show note form for settled calls', async () => { await mount({ ...report, items: [item({ state: 'settled', needsReconciliation: false })], filteredTotal: 1 }); button('查看追踪').click(); await flush(); expect(root.querySelector('.review-form')).toBeNull() })
})
