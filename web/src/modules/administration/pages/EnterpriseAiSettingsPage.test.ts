// @vitest-environment jsdom
import { createApp, nextTick, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import EnterpriseAiSettingsPage from './EnterpriseAiSettingsPage.vue'
import { authSession } from '../../auth/session'
import { getEnterpriseAiSettings, saveEnterpriseAiSettings, testEnterpriseAiConnection, selectEnterpriseAiSource, listAiPromptSkills, createAiPromptSkill } from '../api'

vi.mock('../api', () => ({ getEnterpriseAiSettings: vi.fn(), saveEnterpriseAiSettings: vi.fn(), testEnterpriseAiConnection: vi.fn(), selectEnterpriseAiSource: vi.fn(), listAiPromptSkills: vi.fn(), createAiPromptSkill: vi.fn(), updateAiPromptSkill: vi.fn(), deleteAiPromptSkill: vi.fn() }))
vi.mock('../../jobs/api', () => ({ loadJobs: vi.fn().mockResolvedValue([]) }))
const getSettings = vi.mocked(getEnterpriseAiSettings)
const saveSettings = vi.mocked(saveEnterpriseAiSettings)
const testConnection = vi.mocked(testEnterpriseAiConnection)
const configured = (hasKey = true) => ({
  modelSource: 'enterprise' as const, platformAuthorized: false, configured: hasKey, baseUrlHost: 'https://ai.longdaoec.com', model: hasKey ? 'model-a' : '', timeoutMs: 120000,
  apiKeyConfigured: hasKey, missing: hasKey ? [] : ['OPENAI_API_KEY', 'OPENAI_MODEL'],
  env: {
    OPENAI_BASE_URL: { value: 'https://ai.longdaoec.com', configured: true, masked: false },
    OPENAI_API_KEY: { value: hasKey ? '••••••••' : '', configured: hasKey, masked: true },
    OPENAI_MODEL: { value: hasKey ? 'model-a' : '', configured: hasKey, masked: false },
    OPENAI_TIMEOUT_MS: { value: '120000', configured: true, masked: false },
  },
})
let app: App | undefined, root: HTMLDivElement | undefined
async function flush() { for (let i = 0; i < 8; i++) { await Promise.resolve(); await nextTick() } }
async function mount() {
  root = document.createElement('div'); document.body.appendChild(root)
  app = createApp(EnterpriseAiSettingsPage); app.mount(root); await flush()
}
async function input(selector: string, value: string) {
  const field = root!.querySelector<HTMLInputElement>(selector)!
  field.value = value; field.dispatchEvent(new Event('input', { bubbles: true })); await flush()
}
async function click(label: string) {
  const button = [...root!.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.includes(label))!
  expect(button).toBeTruthy(); button.click(); await flush()
}
async function submit() { root!.querySelector('form:not(.source-form)')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await flush() }

describe('enterprise AI self-service configuration', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    authSession.user = { id: 'member', name: 'Member', email: 'member@example.invalid', role: 'recruiter', departmentId: '', workspaceId: 'org-a' }
    authSession.workspaces = [{ id: 'org-a', name: 'Enterprise A', kind: 'test', status: 'active', role: 'owner', createdAt: '2026-11-20' }]
    vi.mocked(listAiPromptSkills).mockResolvedValue([])
    getSettings.mockResolvedValue(configured())
    saveSettings.mockResolvedValue(configured())
    testConnection.mockResolvedValue({ ok: true, message: '连接正常', latencyMs: 10, models: ['model-a', 'model-b'] })
  })
  afterEach(() => { app?.unmount(); root?.remove(); app = undefined; root = undefined })

  it('offers both enterprise Skill editors even when the model configuration cannot load', async () => {
    getSettings.mockRejectedValue(new Error('模型配置暂不可用'))
    await mount()
    expect(root!.textContent).toContain('岗位文档生成 Skill')
    expect(root!.textContent).toContain('简历 AI 评分 Skill')
    expect(root!.querySelector('#ai-skill-count')?.textContent).toBe('0/8000')
    await input('#ai-skill-name', '企业写作规则')
    await input('#ai-skill-content', '清晰准确')
    expect(root!.querySelector('#ai-skill-count')?.textContent).toBe('4/8000')
    vi.mocked(createAiPromptSkill).mockResolvedValue({ id: 'own-skill', name: '企业写作规则', content: '清晰准确', targetType: 'both', isActive: true, createdBy: null, createdAt: '', updatedAt: '' })
    await click('创建 Skill')
    expect(createAiPromptSkill).toHaveBeenCalledWith({ name: '企业写作规则', content: '清晰准确', targetType: 'both' })
  })

  it('shows the current workspace and a fixed non-editable endpoint without timeout controls', async () => {
    await mount()
    expect(root!.textContent).toContain('Enterprise A')
    expect(root!.querySelector('[data-testid="fixed-ai-endpoint"]')?.textContent).toBe('https://ai.longdaoec.com')
    expect(root!.querySelectorAll('.ai-settings input').length).toBe(2)
    expect(root!.querySelector<HTMLInputElement>('#enterprise-ai-key')?.value).toBe('')
    expect(root!.querySelector('input[type="number"]')).toBeNull()
  })

  it('tests an unsaved key and selects a returned model, sending only key and model on save', async () => {
    getSettings.mockResolvedValue(configured(false))
    await mount()
    await input('#enterprise-ai-key', 'user-secret')
    await click('测试连接')
    expect(testConnection).toHaveBeenCalledWith({ OPENAI_API_KEY: 'user-secret' })
    root!.querySelector<HTMLButtonElement>('[aria-label="选择模型"]')!.click(); await flush()
    const option = [...root!.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(item => item.textContent?.includes('model-b'))!
    option.click(); await flush(); await submit()
    expect(saveSettings).toHaveBeenCalledWith({ OPENAI_API_KEY: 'user-secret', OPENAI_MODEL: 'model-b' })
    expect(root!.querySelector<HTMLInputElement>('#enterprise-ai-key')?.value).toBe('')
  })

  it('omits a blank key when preserving saved credentials and can test the saved key', async () => {
    await mount(); await click('测试连接')
    expect(testConnection).toHaveBeenCalledWith({})
    await input('#enterprise-ai-model', 'model-b'); await submit()
    expect(saveSettings).toHaveBeenCalledWith({ OPENAI_MODEL: 'model-b' })
  })

  it('requires confirmation before clearing the key without platform fallback', async () => {
    saveSettings.mockResolvedValue(configured(false))
    await mount(); await click('清除企业密钥')
    expect(saveSettings).not.toHaveBeenCalled()
    await click('取消'); expect(saveSettings).not.toHaveBeenCalled()
    await click('清除企业密钥'); await click('确认清除')
    expect(saveSettings).toHaveBeenCalledWith({ OPENAI_API_KEY: '' })
    expect(root!.textContent).toContain('企业自配模型已不可用')
  })

  it('blocks incomplete settings and supports retrying a failed load', async () => {
    getSettings.mockRejectedValueOnce(new Error('暂不可用')).mockResolvedValue(configured(false))
    await mount(); expect(root!.querySelector('form')).toBeNull()
    await click('重新加载'); await submit()
    expect(saveSettings).not.toHaveBeenCalled()
    expect(root!.textContent).toContain('请填写 API Key 并选择模型')
  })

  it('clears stale models when the key changes and does not save after a failed connection test', async () => {
    await mount(); await click('测试连接')
    await input('#enterprise-ai-key', 'another-key')
    expect(root!.textContent).not.toContain('连接正常')
    testConnection.mockResolvedValue({ ok: false, message: '密钥无效', latencyMs: 1, models: [] })
    await click('测试连接')
    expect(root!.textContent).toContain('密钥无效')
    expect(saveSettings).not.toHaveBeenCalled()
  })
})
