// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import WorkspaceInvitationManager from './WorkspaceInvitationManager.vue'
import * as api from '../api/invitations'
import { copyText } from '../utils/invitations'
vi.mock('../api/invitations',()=>({createInvitation:vi.fn(),listInvitations:vi.fn(),listWorkspaceMembers:vi.fn(),listInvitationDepartments:vi.fn(),revokeInvitation:vi.fn(),updateWorkspaceMember:vi.fn()}))
vi.mock('../session',()=>({authSession:{user:{id:'self'}}}))
vi.mock('../utils/invitations', async(importOriginal)=>({...await importOriginal<typeof import('../utils/invitations')>(),copyText:vi.fn()}))
let app:App,root:HTMLDivElement
const invitation={id:'i',workspaceId:'w',workspaceName:'测试企业',workspaceKind:'test',email:null,membershipRole:'member',businessRole:'interviewer',departmentId:null,departmentName:null,createdAt:'2026-10-09',expiresAt:'2099-01-01',acceptedAt:null,status:'pending',code:'ABCDEF-123456-ABCDEF-123456'} as api.Invitation
async function flush(){for(let i=0;i<8;i++){await Promise.resolve();await nextTick()}}
async function mount(role='owner') {
 vi.mocked(api.listInvitations).mockResolvedValue([])
 vi.mocked(api.listWorkspaceMembers).mockResolvedValue([
  {id:'self',name:'自己',email:'self@example.invalid',membershipRole:'owner',businessRole:'recruiter',departmentId:null,departmentName:null,joinedAt:'2026-10-09'},
  {id:'other',name:'同事',email:'other@example.invalid',membershipRole:'member',businessRole:'interviewer',departmentId:null,departmentName:null,joinedAt:'2026-10-09'},
 ])
 vi.mocked(api.listInvitationDepartments).mockResolvedValue([])
 root=document.createElement('div');document.body.appendChild(root)
 app=createApp(WorkspaceInvitationManager,{workspace:{id:'w',name:'测试企业',kind:'test',status:'active',role,createdAt:'2026-10-09'}});app.mount(root);await flush()
}
function button(text:string){return [...root.querySelectorAll('button')].find(b=>b.textContent?.trim()===text)!}
afterEach(()=>{app?.unmount();root?.remove();vi.resetAllMocks();vi.restoreAllMocks()})
describe('WorkspaceInvitationManager',()=>{
 it('explains separate enterprise identities and keeps Offer approvers available without changing role codes',async()=>{
  await mount()
  const guide=root.querySelector('[aria-label="企业身份与业务角色说明"]')!
  expect(guide.tagName).toBe('DETAILS')
  expect(guide.hasAttribute('open')).toBe(false)
  expect(root.querySelector('.invite-form')!.compareDocumentPosition(guide) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(guide.textContent).toContain('企业管理员身份不代表自动获得录用审批权')
  expect(guide.textContent).toContain('更改角色不会自动替你审批或发放 Offer')
  const option=root.querySelector('.invite-form option[value="approver"]')!
  expect(option.textContent).toBe('录用审批人')
  const select=option.parentElement as HTMLSelectElement
  select.value='approver';select.dispatchEvent(new Event('change',{bubbles:true}));await flush()
  vi.mocked(api.createInvitation).mockResolvedValue({...invitation,businessRole:'approver'})
  button('生成邀请').click();await flush()
  expect(api.createInvitation).toHaveBeenCalledWith('w',expect.objectContaining({businessRole:'approver'}))
 })
 it('creates an invitation and copies the link without claiming automatic sending',async()=>{
  await mount();vi.mocked(api.createInvitation).mockResolvedValue(invitation)
  button('生成邀请').click();await flush()
  expect(api.createInvitation).toHaveBeenCalledWith('w',expect.objectContaining({membershipRole:'member',businessRole:'recruiter',expiresInDays:7}))
  button('复制邀请链接').click();await flush()
  expect(copyText).toHaveBeenCalledWith(expect.stringContaining('/workspaces?invite='))
  expect(root.textContent).toContain('已复制')
  expect(root.textContent).toContain('本机地址')
 })
 it('only owners can grant enterprise administrator and never offers platform administrators',async()=>{
  await mount('admin')
  expect(root.querySelector('.invite-form option[value=admin]')).toBeNull()
  expect(root.querySelector('option[value=hr_admin]')).toBeNull()
  expect(root.querySelector('select[aria-label="自己的业务角色"]')).toBeNull()
  expect(root.querySelector('select[aria-label="同事的业务角色"]')).not.toBeNull()
 })
 it('confirms revocation and immediately disables sharing a revoked invite',async()=>{
  await mount();vi.mocked(api.createInvitation).mockResolvedValue({...invitation})
  button('生成邀请').click();await flush()
  vi.spyOn(window,'confirm').mockReturnValue(false);button('撤销').click();await flush()
  expect(api.revokeInvitation).not.toHaveBeenCalled()
  vi.mocked(window.confirm).mockReturnValue(true);vi.mocked(api.revokeInvitation).mockResolvedValue({ok:true})
  button('撤销').click();await flush()
  expect(api.revokeInvitation).toHaveBeenCalledWith('w','i');expect(root.textContent).toContain('已撤销')
  expect(root.textContent).not.toContain('新邀请码')
 })
})
