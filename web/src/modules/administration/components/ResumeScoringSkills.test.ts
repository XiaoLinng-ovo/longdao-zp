// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import ResumeScoringSkills from './ResumeScoringSkills.vue'
import { listAiPromptSkills, createAiPromptSkill, updateAiPromptSkill, deleteAiPromptSkill, type AdminAiPromptSkill } from '../api'
import { loadJobs, type JobView } from '../../jobs/api'
vi.mock('../api', () => ({ listAiPromptSkills: vi.fn(), createAiPromptSkill: vi.fn(), updateAiPromptSkill: vi.fn(), deleteAiPromptSkill: vi.fn() }))
vi.mock('../../jobs/api', () => ({ loadJobs: vi.fn() }))
const skill: AdminAiPromptSkill = { id: 'skill-1', name: '后端专属', content: '技术 80 分，项目 20 分', targetType: 'resume_score', jobIds: ['job-1'], isActive: true, createdBy: null, createdAt: '2026-10-08', updatedAt: '2026-10-08' }
const jobs = [
  { id: 'JOB-001', entityId: 'job-1', title: '后端工程师', department: '研发' },
  { id: 'JOB-002', entityId: 'job-2', title: '销售经理', department: '销售' },
] as JobView[]
let app: App | undefined
let root: HTMLDivElement
async function flush() { for (let i = 0; i < 8; i++) { await Promise.resolve(); await nextTick() } }
async function mount(skills: AdminAiPromptSkill[] = []) {
  vi.mocked(listAiPromptSkills).mockResolvedValue(skills)
  vi.mocked(loadJobs).mockResolvedValue(jobs)
  root = document.createElement('div'); document.body.appendChild(root)
  app = createApp(ResumeScoringSkills); app.mount(root); await flush()
}
function button(text: string) { return [...root.querySelectorAll('button')].find((element) => element.textContent?.trim() === text)! }
async function fill(selector: string, value: string) {
  const input = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!
  input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); await nextTick()
}
afterEach(() => { app?.unmount(); root?.remove(); vi.resetAllMocks() })
describe('ResumeScoringSkills', () => {
  it('creates a job-specific Skill with the database ID instead of the display code', async () => {
    await mount()
    await fill('#resume-scoring-skill-name', '销售专属')
    button('填入评分模板').click(); await nextTick()
    const checkbox = root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]!
    checkbox.click(); await nextTick()
    vi.mocked(createAiPromptSkill).mockImplementation(async (input) => ({ ...skill, ...input, id: 'skill-2' }))
    button('创建评分 Skill').click(); await flush()
    expect(createAiPromptSkill).toHaveBeenCalledWith(expect.objectContaining({ name: '销售专属', targetType: 'resume_score', jobIds: ['job-2'] }))
    expect(root.textContent).toContain('已有简历需重新解析后生效')
    expect(root.textContent).toContain('销售经理')
  })
  it('separates document Skills and disables jobs owned by another scoring Skill', async () => {
    await mount([skill, { ...skill, id: 'document', name: '岗位写作模板', targetType: 'both', jobIds: [] }])
    expect(root.textContent).not.toContain('岗位写作模板')
    expect(root.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled).toBe(true)
    button('编辑').click(); await nextTick()
    const checkbox = root.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    expect(checkbox.disabled).toBe(false); expect(checkbox.checked).toBe(true)
    expect(root.querySelector<HTMLInputElement>('#resume-scoring-skill-name')!.value).toBe(skill.name)
    vi.mocked(updateAiPromptSkill).mockResolvedValue({ ...skill, content: '技术 100 分' })
    await fill('#resume-scoring-skill-content', '技术 100 分')
    button('保存评分 Skill').click(); await flush()
    expect(updateAiPromptSkill).toHaveBeenCalledWith(skill.id, expect.objectContaining({ content: '技术 100 分', jobIds: ['job-1'] }))
  })
  it('toggles without clearing bindings and confirms before deletion', async () => {
    await mount([skill])
    vi.mocked(updateAiPromptSkill).mockResolvedValue({ ...skill, isActive: false })
    button('停用').click(); await flush()
    expect(updateAiPromptSkill).toHaveBeenCalledWith(skill.id, { isActive: false })
    expect(root.textContent).toContain('后续分析将使用默认规则')
    button('删除').click(); await nextTick()
    expect(deleteAiPromptSkill).not.toHaveBeenCalled()
    vi.mocked(deleteAiPromptSkill).mockResolvedValue({ deleted: true })
    button('确认删除').click(); await flush()
    expect(deleteAiPromptSkill).toHaveBeenCalledWith(skill.id)
    expect(root.textContent).toContain('暂无评分 Skill')
  })
  it('keeps the draft and reports server-side assignment conflicts', async () => {
    await mount(); await fill('#resume-scoring-skill-name', '规则'); await fill('#resume-scoring-skill-content', '项目 100 分')
    vi.mocked(createAiPromptSkill).mockRejectedValue(new Error('岗位已绑定其他评分 Skill'))
    button('创建评分 Skill').click(); await flush()
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('已绑定')
    expect(root.querySelector<HTMLInputElement>('#resume-scoring-skill-name')!.value).toBe('规则')
  })
})
