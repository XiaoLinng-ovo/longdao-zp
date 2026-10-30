import { describe, expect, it } from 'vitest'
import { isWorkspaceAvailable, workspaceServiceLabel } from './workspace-service'
const workspace={id:'w',name:'企业',kind:'test' as const,status:'active' as const,role:'owner' as const,createdAt:'2026-10-12'}
describe('workspace lifecycle labels',()=>{
  it('preserves old enabled workspaces',()=>{expect(isWorkspaceAvailable(workspace)).toBe(true)})
  it('rejects suspended, archived, expired and server-denied workspaces',()=>{
    for(const item of [{...workspace,serviceStatus:'suspended' as const},{...workspace,status:'archived' as const},{...workspace,serviceStatus:'trial' as const,trialEndsAt:'2020-01-01T00:00:00Z'},{...workspace,serviceAvailable:false}]) expect(isWorkspaceAvailable(item)).toBe(false)
    expect(workspaceServiceLabel({...workspace,serviceStatus:'suspended'})).toBe('服务已暂停')
    expect(workspaceServiceLabel({...workspace,serviceStatus:'trial',trialEndsAt:'2020-01-01T00:00:00Z'})).toBe('试用已到期')
  })
})
