import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isPlatformAdmin, isPlatformRole } from './roles.js'

test('platform role validation accepts only the existing operator roles', () => {
  assert.equal(isPlatformRole('admin'), true)
  assert.equal(isPlatformRole('viewer'), true)
  assert.equal(isPlatformAdmin('admin'), true)
  assert.equal(isPlatformAdmin('viewer'), false)
  for (const role of ['owner', 'recruiter', null, undefined]) {
    assert.equal(isPlatformRole(role), false)
    assert.equal(isPlatformAdmin(role as never), false)
  }
})
