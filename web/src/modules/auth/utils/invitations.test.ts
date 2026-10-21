// @vitest-environment jsdom
import { describe,it,expect,vi,afterEach } from 'vitest'
import {extractInvitationCode,invitationLink,copyText,invitationText} from './invitations'
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
afterEach(()=>{
 vi.restoreAllMocks()
 if (originalClipboard) Object.defineProperty(navigator,'clipboard',originalClipboard)
 else Reflect.deleteProperty(navigator,'clipboard')
})
describe('invitation helpers',()=>{
 it('supports codes and invitation links without evaluating URL contents',()=>{
  const code='ABCDEF123456ABCDEF123456'
  expect(extractInvitationCode(' abcdef-123456-abcdef-123456 ')).toBe(code)
  expect(extractInvitationCode('https://example.com/workspaces?invite=abcdef-123456-abcdef-123456')).toBe(code)
  expect(invitationLink(code,'https://example.com')).toBe('https://example.com/workspaces?invite='+code)
 })
 it('includes a code, destination, validity and account instructions in share text',()=>{
  const text=invitationText({workspaceName:'测试企业',code:'ABCDEF-123456-ABCDEF-123456',expiresAt:'2026-10-16T00:00:00Z'})
  expect(text).toContain('测试企业');expect(text).toContain('/workspaces?invite=');expect(text).toContain('不是登录密码')
 })
 it('copies via clipboard',async()=>{
  const writeText=vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator,'clipboard',{value:{writeText},configurable:true})
  await copyText('CODE');expect(writeText).toHaveBeenCalledWith('CODE')
 })
})
