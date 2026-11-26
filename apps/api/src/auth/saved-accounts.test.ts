import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildSavedAccountsCookie, readSavedAccountSessions, type SavedAccountSession } from './saved-accounts.js'
import { buildAuthCookie } from './security.js'

function account(id: string, token = `secret-${id}`): SavedAccountSession {
  return { token, auth: { sessionId: `session-${id}`, method: 'session', user: { id, name: id, email: `${id}@example.com`, role: 'recruiter', departmentId: 'hr' } } }
}

describe('saved accounts cookie', () => {
  it('keeps session secrets HttpOnly and uses Secure host cookies in production', () => {
    const cookie = buildSavedAccountsCookie([account('one')], { production: true })
    assert.match(cookie, /^__Host-smartrecruit_accounts=/)
    assert.match(cookie, /; Path=\/; HttpOnly; SameSite=Lax; Secure; Max-Age=43200$/)
  })
  it('deduplicates account identities using the latest session and bounds cookie size', async () => {
    const entries = Array.from({ length: 9 }, (_, i) => account(String(i)))
    entries.push(account('8', 'replacement'))
    const cookie = buildSavedAccountsCookie(entries)
    const sessions = await readSavedAccountSessions({ authenticateToken: async token => entries.find(item => item.token === token)?.auth }, cookie)
    assert.equal(sessions.length, 6)
    assert.equal(sessions.at(-1)?.token, 'replacement')
    assert.ok(!sessions.some(item => item.token === 'secret-8'))
  })
  it('drops revoked/expired sessions and safely adopts the currently signed-in session', async () => {
    const old = account('one', 'old')
    const current = account('one', 'current')
    const revoked = account('two')
    const cookie = `${buildSavedAccountsCookie([old, revoked]).split(';')[0]}; ${buildAuthCookie(current.token).split(';')[0]}`
    const entries = [old, current]
    const sessions = await readSavedAccountSessions({ authenticateToken: async token => entries.find(item => item.token === token)?.auth }, cookie)
    assert.deepEqual(sessions, [current])
  })
  it('does not prevent login when the saved-account cookie is malformed', async () => {
    for (const value of ['%ZZ', 'null', '42', '%7B%7D', '[1,true,null]']) {
      const sessions = await readSavedAccountSessions({ authenticateToken: async () => undefined }, `smartrecruit_accounts=${value}`)
      assert.deepEqual(sessions, [])
    }
    assert.match(buildSavedAccountsCookie([]), /Max-Age=0$/)
  })
})
