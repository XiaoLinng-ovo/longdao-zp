// @vitest-environment jsdom
import { createApp, nextTick, type App } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import DocumentGenerationSkills from './DocumentGenerationSkills.vue'
import { listAiPromptSkills, createAiPromptSkill, updateAiPromptSkill, deleteAiPromptSkill, type AdminAiPromptSkill } from '../api'
vi.mock('../api', () => ({ listAiPromptSkills: vi.fn(), createAiPromptSkill: vi.fn(), updateAiPromptSkill: vi.fn(), deleteAiPromptSkill: vi.fn() }))
const skill: AdminAiPromptSkill = { id: 'document-1', name: '企业文档规则', content: '简洁准确', targetType: 'both', isActive: true, createdBy: null, createdAt: '', updatedAt: '' }
let app: App | undefined
let root: HTMLDivElement
async function flush() { for (let i = 0; i < 8; i++) { await Promise.resolve(); await nextTick() } }
async function mount(items: AdminAiPromptSkill[] = []) {
  vi.mocked(listAiPromptSkills).mockResolvedValue(items)
  root = document.createElement('div'); document.body.appendChild(root)
  app = createApp(DocumentGenerationSkills); app.mount(root); await flush()
}
async function fill(selector: string, value: string) {
  const field = root.querySelector<HTMLInputElement>(selector)!
  field.value = value; field.dispatchEvent(new Event('input', { bubbles: true })); await flush()
}
async function click(text: string) { [...root.querySelectorAll('button')].find(button => button.textContent?.trim() === text)!.click(); await flush() }
afterEach(() => { app?.unmount(); root?.remove(); vi.resetAllMocks() })
describe('DocumentGenerationSkills', () => {
  it('creates document rules with a live upper-right content counter', async () => {
    await mount()
    expect(root.querySelector('#ai-skill-count')?.textContent).toBe('0/8000')
    await fill('#ai-skill-name', skill.name); await fill('#ai-skill-content', skill.content)
    expect(root.querySelector('#ai-skill-count')?.textContent).toBe('4/8000')
    expect(root.querySelector('#ai-skill-content')?.getAttribute('maxlength')).toBe('8000')
    expect(root.textContent).not.toContain('把你希望模型长期遵循')
    vi.mocked(createAiPromptSkill).mockResolvedValue(skill)
    await click('创建 Skill')
    expect(createAiPromptSkill).toHaveBeenCalledWith({ name: skill.name, content: skill.content, targetType: 'both' })
    expect(root.querySelector('#ai-skill-count')?.textContent).toBe('0/8000')
    expect(root.querySelector('tbody')?.textContent).toContain(skill.name)
  })
  it('filters scoring rules and supports editing, disabling and deleting document rules', async () => {
    await mount([skill, { ...skill, id: 'score-1', name: '评分专用', targetType: 'resume_score' }])
    expect(root.textContent).not.toContain('评分专用')
    await click('编辑'); await fill('#ai-skill-content', '仅写事实')
    vi.mocked(updateAiPromptSkill).mockResolvedValue({ ...skill, content: '仅写事实' })
    await click('保存修改')
    expect(updateAiPromptSkill).toHaveBeenCalledWith(skill.id, { name: skill.name, content: '仅写事实', targetType: 'both' })
    vi.mocked(updateAiPromptSkill).mockResolvedValue({ ...skill, isActive: false })
    await click('停用')
    expect(updateAiPromptSkill).toHaveBeenLastCalledWith(skill.id, { isActive: false })
    vi.mocked(deleteAiPromptSkill).mockResolvedValue({ deleted: true })
    await click('删除'); expect(deleteAiPromptSkill).toHaveBeenCalledWith(skill.id)
    expect(root.querySelector('tbody')?.textContent).not.toContain(skill.name)
  })
  it('preserves the draft after a failed save and can retry loading', async () => {
    await mount(); await fill('#ai-skill-name', skill.name); await fill('#ai-skill-content', skill.content)
    vi.mocked(createAiPromptSkill).mockRejectedValue(new Error('保存失败'))
    await click('创建 Skill')
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('保存失败')
    expect(root.querySelector<HTMLTextAreaElement>('#ai-skill-content')?.value).toBe(skill.content)
    vi.mocked(listAiPromptSkills).mockResolvedValue([skill]); await click('刷新文档 Skill')
    expect(root.querySelector('tbody')?.textContent).toContain(skill.name)
  })
})
