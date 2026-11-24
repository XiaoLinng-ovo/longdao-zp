// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import WorkspaceInvitationManager from './WorkspaceInvitationManager.vue'
import * as api from '../api/invitations'
import { copyText } from '../utils/invitations'
vi.mock('../api/invitations',()=>({createInvitation:vi.fn(),listInvitations:vi.fn(),listWorkspaceMembers:vi.fn(),listInvitationDepartments:vi.fn(),revokeInvitation:vi.fn(),updateWorkspaceMember:vi.fn(),setWorkspaceMemberStatus:vi.fn(),transferWorkspaceOwnership:vi.fn()}))
vi.mock('../session',()=>({authSession:{user:{id:'self'}}}))
vi.mock('../utils/invitations', async(importOriginal)=>({...await importOriginal<typeof import('../utils/invitations')>(),copyText:vi.fn()}))
let app:App,root:HTMLDivElement
const invitation={id:'i',workspaceId:'w',workspaceName:'测试企业',workspaceKind:'test',email:null,membershipRole:'member',businessRole:'recruiter',departmentId:null,departmentName:null,createdAt:'2026-10-09',expiresAt:'2099-01-01',acceptedAt:null,status:'pending',code:'ABCDEF-123456-ABCDEF-123456'} as api.Invitation
async function flush(){for(let i=0;i<8;i++){await Promise.resolve();await nextTick()}}
async function mount(role='owner', targetRole: 'member' | 'admin' = 'member') {
 vi.mocked(api.listInvitations).mockResolvedValue([])
 vi.mocked(api.listWorkspaceMembers).mockResolvedValue([
  {isActive:true,accountActive:true,id:'self',name:'自己',email:'self@example.invalid',membershipRole:'owner',businessRole:'recruiter',departmentId:null,departmentName:null,joinedAt:'2026-10-09'},
  {isActive:true,accountActive:true,id:'other',name:'同事',email:'other@example.invalid',membershipRole:targetRole,businessRole:'recruiter',departmentId:null,departmentName:null,joinedAt:'2026-10-09'},
 ])
 vi.mocked(api.listInvitationDepartments).mockResolvedValue([])
 root=document.createElement('div');document.body.appendChild(root)
 app=createApp(WorkspaceInvitationManager,{workspace:{id:'w',name:'测试企业',kind:'test',status:'active',role,createdAt:'2026-10-09'}});app.mount(root);await flush()
}
function button(text:string){return [...root.querySelectorAll('button')].find(b=>b.textContent?.trim()===text)!}
afterEach(()=>{app?.unmount();root?.remove();vi.resetAllMocks();vi.restoreAllMocks()})
describe('WorkspaceInvitationManager',()=>{
 it('uses one enterprise-user identity and keeps membership settings editable',async()=>{
  await mount()
  expect(root.textContent).toContain('企业用户')
  expect(root.querySelector('.invite-form select[aria-label="业务角色"]')).toBeNull()
  expect(root.querySelector('select[aria-label="同事的所属部门"]')).not.toBeNull()
  vi.mocked(api.createInvitation).mockResolvedValue({...invitation,businessRole:'recruiter'})
  button('生成邀请').click();await flush()
  expect(api.createInvitation).toHaveBeenCalledWith('w',expect.objectContaining({businessRole:'recruiter'}))
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
  expect(root.querySelector('select[aria-label="同事的业务角色"]')).toBeNull()
 })
 it('owner can invite a sub-administrator without platform or owner role options',async()=>{
  await mount()
  const select=root.querySelector<HTMLSelectElement>('.invite-form select')!
  expect(select.querySelector('option[value=admin]')?.textContent).toBe('企业子管理员')
  expect(root.querySelector('option[value=owner]')).toBeNull()
  select.value='admin';select.dispatchEvent(new Event('change'));await flush()
  vi.mocked(api.createInvitation).mockResolvedValue({...invitation,membershipRole:'admin'})
  button('生成邀请').click();await flush()
  expect(api.createInvitation).toHaveBeenCalledWith('w',expect.objectContaining({membershipRole:'admin',businessRole:'recruiter'}))
 })
 for(const targetRole of ['member','admin'] as const) {
  it('owner can change '+targetRole+' with explicit confirmation',async()=>{
   await mount('owner',targetRole)
   const select=root.querySelector<HTMLSelectElement>('select[aria-label="同事的企业身份"]')!
   expect(select.value).toBe(targetRole)
   const nextRole=targetRole==='member'?'admin':'member'
   select.value=nextRole;select.dispatchEvent(new Event('change'));await flush()
   const confirm=vi.spyOn(window,'confirm').mockReturnValue(false)
   button('保存设置').click();await flush()
   expect(api.updateWorkspaceMember).not.toHaveBeenCalled()
   confirm.mockReturnValue(true)
   vi.mocked(api.updateWorkspaceMember).mockResolvedValue({ok:true})
   button('保存设置').click();await flush()
   expect(api.updateWorkspaceMember).toHaveBeenCalledWith('w','other',expect.objectContaining({membershipRole:nextRole}))
   expect(root.textContent).toContain('成员设置已保存')
  })
 }
 it('sub-administrator cannot edit peers, owner or self, or transfer ownership',async()=>{
  await mount('admin','admin')
  expect(root.querySelector('select[aria-label="同事的企业身份"]')).toBeNull()
  expect(root.querySelector('select[aria-label="同事的所属部门"]')).toBeNull()
  expect(button('保存设置')).toBeUndefined()
  expect(button('停用')).toBeUndefined()
  expect(button('交接')).toBeUndefined()
 })
 it('owner can stop a sub-administrator but cannot stop the chief owner',async()=>{
  await mount('owner','admin')
  vi.spyOn(window,'prompt').mockReturnValue('调整企业权限')
  vi.mocked(api.setWorkspaceMemberStatus).mockResolvedValue({ok:true})
  expect(root.querySelectorAll('button[title="停用企业成员"]')).toHaveLength(1)
  button('停用').click();await flush()
  expect(api.setWorkspaceMemberStatus).toHaveBeenCalledWith('w','other',false,'调整企业权限')
 })
 it('saving errors preserve the actual member role and show server feedback',async()=>{
  await mount()
  const select=root.querySelector<HTMLSelectElement>('select[aria-label="同事的企业身份"]')!
  select.value='admin';select.dispatchEvent(new Event('change'));await flush()
  vi.spyOn(window,'confirm').mockReturnValue(true)
  vi.mocked(api.updateWorkspaceMember).mockRejectedValue(new Error('仅主管理员可以任免'))
  button('保存设置').click();await flush()
  expect(root.querySelector('[role=alert]')?.textContent).toContain('仅主管理员可以任免')
  expect(root.textContent).not.toContain('成员设置已保存')
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
