import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isPlatformManagementPath } from './access.js'
test('enterprise AI usage endpoint is not platform operations',()=>{
 assert.equal(isPlatformManagementPath('/api/v1/admin/ai-usage'),false)
 assert.equal(isPlatformManagementPath('/api/v1/admin/settings'),true)
 assert.equal(isPlatformManagementPath('/api/v1/platform/customers'),true)
})

test('sandbox order paths are enterprise-scoped while unknown admin remains platform-only',()=>{for(const suffix of ['', '/orders','/orders/abc/simulate'])assert.equal(isPlatformManagementPath('/api/v1/admin/billing-sandbox'+suffix),false);assert.equal(isPlatformManagementPath('/api/v1/admin/billing-sandbox-other'),true)})

test('AI usage reviews remain enterprise-scoped with a strict path boundary', () => {
 assert.equal(isPlatformManagementPath('/api/v1/admin/ai-usage/task/reviews'), false)
 assert.equal(isPlatformManagementPath('/api/v1/admin/ai-usage-other'), true)
})
