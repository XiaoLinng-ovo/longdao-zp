import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isSystemAdministrationPath, requireSystemAdministrator } from './system-administrator.js'

test('AI configuration maintenance routes require current system-account authorization',()=>{
  for (const path of ['ai-diagnostics','ai-generation-test','ai-legacy-preview','ai-legacy-import']) {
    assert.equal(isSystemAdministrationPath('/api/v1/admin/'+path),true)
  }
  assert.equal(isSystemAdministrationPath('/api/v1/admin/enterprise-ai-settings'),false)
  assert.throws(()=>requireSystemAdministrator(undefined),error=>error instanceof Error && 'status' in error && error.status===401)
  const user={id:'ordinary',name:'ordinary',email:'ordinary@example.invalid',role:'recruiter' as const,departmentId:''}
  assert.throws(()=>requireSystemAdministrator({method:'session',sessionId:'synthetic',user}),error=>error instanceof Error && 'status' in error && error.status===403)
  requireSystemAdministrator({method:'session',sessionId:'synthetic',user:{...user,isSystemAdmin:true}})
})
