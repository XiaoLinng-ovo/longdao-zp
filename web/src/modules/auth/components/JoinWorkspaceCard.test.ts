// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import JoinWorkspaceCard from './JoinWorkspaceCard.vue'
import { previewInvitation, acceptInvitation, type Invitation } from '../api/invitations'
import { switchWorkspace } from '../session'
vi.mock('vue-router', () => ({ useRoute: () => ({ query: { invite: 'ABCDEF-123456-ABCDEF-123456' } }) }))
vi.mock('../api/invitations', () => ({ previewInvitation: vi.fn(), acceptInvitation: vi.fn() }))
vi.mock('../session', () => ({ switchWorkspace: vi.fn() }))
const invitation = { id:'i', workspaceId:'w',workspaceName:'测试企业',workspaceKind:'test',businessRole:'interviewer',membershipRole:'member',expiresAt:'2099-01-01',status:'pending' } as Invitation
let app: App, root: HTMLDivElement
async function flush() { for(let i=0;i<8;i++) { await Promise.resolve(); await nextTick() } }
function button(text:string) { return [...root.querySelectorAll('button')].find(b=>b.textContent?.trim()===text)! }
beforeEach(async()=>{ root=document.createElement('div');document.body.appendChild(root); app=createApp(JoinWorkspaceCard);app.mount(root);await flush() })
afterEach(()=>{app.unmount();root.remove();vi.resetAllMocks()})
describe('JoinWorkspaceCard',()=>{
 it('prepopulates links, previews privileges before accepting and switches enterprise',async()=>{
  expect(root.querySelector('input')!.value).toBe('ABCDEF123456ABCDEF123456')
  vi.mocked(previewInvitation).mockResolvedValue(invitation)
  button('验证邀请码').click();await flush()
  expect(root.textContent).toContain('面试官');expect(acceptInvitation).not.toHaveBeenCalled()
  vi.mocked(acceptInvitation).mockResolvedValue({workspaceId:'w',workspaceName:'测试企业'})
  vi.mocked(switchWorkspace).mockResolvedValue(undefined)
  button('确认加入企业').click();await flush()
  expect(acceptInvitation).toHaveBeenCalledWith('ABCDEF123456ABCDEF123456')
  expect(switchWorkspace).toHaveBeenCalledWith('w');expect(root.textContent).toContain('当前已切换')
 })
 it('invalidates preview if input changes and rejects malformed codes locally',async()=>{
  vi.mocked(previewInvitation).mockResolvedValue(invitation)
  button('验证邀请码').click();await flush()
  const input=root.querySelector('input')!;input.value='wrong';input.dispatchEvent(new Event('input',{bubbles:true}));await nextTick()
  expect(root.textContent).not.toContain('确认加入企业')
  button('验证邀请码').click();await flush()
  expect(previewInvitation).toHaveBeenCalledTimes(1);expect(root.textContent).toContain('24 位')
 })
 it('does not falsely report joining failed when only switching fails',async()=>{
  vi.mocked(previewInvitation).mockResolvedValue(invitation)
  vi.mocked(acceptInvitation).mockResolvedValue({workspaceId:'w',workspaceName:'测试企业'})
  vi.mocked(switchWorkspace).mockRejectedValue(new Error('网络失败'))
  button('验证邀请码').click();await flush();button('确认加入企业').click();await flush()
  expect(root.textContent).toContain('已成功加入');expect(root.textContent).toContain('不需要再次使用邀请码')
  expect(root.querySelector('[role=alert]')).toBeNull()
 })
 it('shows server rejection without consuming a code',async()=>{
  vi.mocked(previewInvitation).mockRejectedValue(new Error('此邀请已过期'))
  button('验证邀请码').click();await flush()
  expect(root.querySelector('[role=alert]')?.textContent).toContain('过期');expect(acceptInvitation).not.toHaveBeenCalled()
 })
})
