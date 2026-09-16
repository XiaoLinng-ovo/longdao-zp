import test from 'node:test'
import assert from 'node:assert/strict'
import { hashPassword, verifyPassword } from './password.js'
import { LoginRateLimiter } from './rate-limit.js'
import { LocalAuthSessionStore } from './session-store.js'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

test('scrypt hash is salted and verifies password', async () => {
 const h1 = await hashPassword('secret'); const h2 = await hashPassword('secret')
 assert.notEqual(h1,h2); assert.equal(await verifyPassword('secret',h1),true); assert.equal(await verifyPassword('bad',h1),false)
})
test('rate limiter blocks after threshold and resets after window', () => {
 const l = new LoginRateLimiter({maxAttempts:2, windowMs:1000})
 assert.equal(l.allow('a'),true); assert.equal(l.allow('a'),true); assert.equal(l.allow('a'),false)
 l.clear('a'); assert.equal(l.allow('a'),true)
})

test('legacy sha256 password migrates to scrypt after successful login', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'smartrecruit-auth-'))
 const path = join(dir, 'sessions.json')
 const legacy = createHash('sha256').update('legacy-secret').digest('hex')
 await writeFile(path, JSON.stringify({version: 1, sessions: [], users: [{id:'legacy', name:'Legacy', email:'legacy@example.com', role:'recruiter', passwordHash: legacy}]}))
 const store = new LocalAuthSessionStore(path)
 assert.equal((await store.findUserByEmailPassword('legacy@example.com', 'legacy-secret'))?.id, 'legacy')
 const persisted = JSON.parse(await readFile(path, 'utf8'))
 assert.match(persisted.users.find((u: {id:string}) => u.id === 'legacy').passwordHash, /^scrypt\$/)
 assert.equal((await store.findUserByEmailPassword('legacy@example.com', 'legacy-secret'))?.id, 'legacy')
})

test('wrong legacy password does not migrate hash', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'smartrecruit-auth-'))
 const path = join(dir, 'sessions.json')
 const legacy = createHash('sha256').update('legacy-secret').digest('hex')
 await writeFile(path, JSON.stringify({version: 1, sessions: [], users: [{id:'legacy', name:'Legacy', email:'legacy@example.com', role:'recruiter', passwordHash: legacy}]}))
 const store = new LocalAuthSessionStore(path)
 assert.equal(await store.findUserByEmailPassword('legacy@example.com', 'wrong'), undefined)
 const persisted = JSON.parse(await readFile(path, 'utf8'))
 assert.equal(persisted.users.find((u: {id:string}) => u.id === 'legacy').passwordHash, legacy)
})
