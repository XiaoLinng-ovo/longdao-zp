import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { assertDevelopmentSeedAllowed, seedDevelopmentData } from '../lib/dev-seed.mjs'
import { startProductionApi } from '../start-api-production.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const read = (path) => readFileSync(resolve(root, path), 'utf8')
const authorized = { NODE_ENV: 'development', ALLOW_DEV_SEED: 'true' }
const cleanEnv = () => Object.fromEntries(
  Object.entries(process.env).filter(([key]) => /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC)$/i.test(key)),
)

test('A: production start launches only the prebuilt API, never migrations or seed', () => {
  const scripts = JSON.parse(read('package.json')).scripts
  assert.equal(scripts.start, 'node scripts/start-api-production.mjs')
  assert.equal(scripts['start:production'], scripts.start)
  assert.equal(scripts['start:dev'], 'node scripts/start-api-local.mjs')
  const calls = []
  const child = new EventEmitter()
  child.kill = () => true
  const before = process.exitCode
  startProductionApi({
    env: { ...authorized },
    spawnProcess: (...args) => { calls.push(args); return child },
  })
  child.emit('exit', 0, null)
  process.exitCode = before
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], process.execPath)
  assert.deepEqual(calls[0][1], [resolve(root, 'apps/api/dist/src/index.js')])
  assert.equal(calls[0][2].env.NODE_ENV, 'production')
  assert.equal(calls[0][2].shell, undefined)
  const dockerfile = read('deploy/Dockerfile.api')
  assert.match(dockerfile, /CMD \["node", "apps\/api\/dist\/src\/index\.js"\]/)
  assert.doesNotMatch(dockerfile, /seed-dev-postgres|migrate-postgres/)
})

for (const [label, env] of [
  ['production, even with opt-in', { NODE_ENV: 'production', ALLOW_DEV_SEED: 'true' }],
  ['missing NODE_ENV, even with opt-in', { ALLOW_DEV_SEED: 'true' }],
  ['development without opt-in', { NODE_ENV: 'development' }],
  ['development with false opt-in', { NODE_ENV: 'development', ALLOW_DEV_SEED: 'false' }],
  ['test environment', { NODE_ENV: 'test', ALLOW_DEV_SEED: 'true' }],
]) {
  test(`B/C: actual seed entry refuses ${label} before importing database/configuration`, () => {
    const loader = `
      export function resolve(specifier, context, next) {
        if (specifier.includes('/dist/') || specifier === 'pg') {
          console.log('FORBIDDEN_DEPENDENCY_IMPORT');
          throw new Error('Database/configuration import forbidden by test');
        }
        return next(specifier, context);
      }`
    const probe = `
      import { register } from 'node:module';
      register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(loader)}`)}, import.meta.url);
      await import(${JSON.stringify(new URL('../seed-dev-postgres.mjs', import.meta.url).href)});
    `
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
      cwd: root, env: { ...cleanEnv(), ...env }, encoding: 'utf8', timeout: 10000,
    })
    assert.equal(result.error, undefined)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Development seed refused/)
    assert.doesNotMatch(result.stdout + result.stderr, /FORBIDDEN_DEPENDENCY_IMPORT/)
  })
}

for (const [label, env, expectsSeed] of [
  ['default development startup', {}, false],
  ['development without opt-in', { NODE_ENV: 'development' }, false],
  ['explicitly authorized development startup', authorized, true],
]) {
  test(`G: ${label} preserves the development chain without executing real commands`, () => {
    const stub = `
      import { EventEmitter } from 'node:events';
      export function spawnSync(command, args) { console.log(JSON.stringify({args, env: process.env.NODE_ENV})); return {status: 0}; }
      export function spawn(command, args) {
        console.log(JSON.stringify({args, env: process.env.NODE_ENV}));
        const child = new EventEmitter(); child.kill = () => true;
        queueMicrotask(() => child.emit('exit', 0, null)); return child;
      }
    `
    const mockUrl = `data:text/javascript,${encodeURIComponent(stub)}`
    const loader = `export function resolve(specifier, context, next) {
      return specifier === 'node:child_process' ? {url: ${JSON.stringify(mockUrl)}, shortCircuit: true} : next(specifier, context);
    }`
    const probe = `import { register } from 'node:module';
      register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(loader)}`)}, import.meta.url);
      await import(${JSON.stringify(new URL('../start-api-local.mjs', import.meta.url).href)});`
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
      cwd: root, env: { ...cleanEnv(), ...env }, encoding: 'utf8', timeout: 10000,
    })
    assert.equal(result.error, undefined)
    assert.equal(result.status, 0)
    const calls = result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line))
    assert.equal(calls.length, expectsSeed ? 4 : 3)
    assert.deepEqual(calls[0].args, ['--prefix', 'apps/api', 'run', 'build'])
    assert.equal(calls[1].args[0], resolve(root, 'scripts/migrate-postgres.mjs'))
    assert.deepEqual(calls.at(-1).args, ['--prefix', 'apps/api', 'start'])
    assert.equal(calls.some((call) => call.args.includes(resolve(root, 'scripts/seed-dev-postgres.mjs'))), expectsSeed)
    assert.ok(calls.every((call) => call.env === 'development'))
  })
}

test('G: development launcher refuses production before any build or migration', () => {
  const result = spawnSync(process.execPath, [resolve(root, 'scripts/start-api-local.mjs')], {
    cwd: root, env: { ...cleanEnv(), NODE_ENV: 'production', ALLOW_DEV_SEED: 'true' }, encoding: 'utf8', timeout: 10000,
  })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /start:dev requires/)
  assert.equal(result.stdout, '')
  assert.match(read('scripts/start-all.mjs'), /set PORT=\$\{apiPort\.port\}&& npm run start:dev/)
})

function fakeDatabase(initial = {}) {
  let state = { departments: [], roles: [], users: [], bindings: [], workspaceRoles: [], ...structuredClone(initial) }
  let snapshot
  let releases = 0
  const sql = []
  const query = async (text, values = []) => {
    sql.push(text)
    if (text === 'BEGIN') { snapshot = structuredClone(state); return { rows: [] } }
    if (text === 'COMMIT') { snapshot = undefined; return { rows: [] } }
    if (text === 'ROLLBACK') { state = snapshot; return { rows: [] } }
    assert.doesNotMatch(text, /\b(UPDATE|DELETE|TRUNCATE|DROP)\b/i)
    if (/INSERT INTO (departments|roles) /.test(text)) {
      assert.match(text, /ON CONFLICT \(code\) DO NOTHING RETURNING id/)
      const table = /INSERT INTO (\w+)/.exec(text)[1]
      if (state[table].some((row) => row.code === values[0])) return { rows: [] }
      const row = { id: `${table}-${state[table].length + 1}`, code: values[0], name: values[1], is_active: true }
      state[table].push(row)
      return { rows: [{ id: row.id }] }
    }
    if (/INSERT INTO users /.test(text)) {
      assert.match(text, /ON CONFLICT \(email\) DO NOTHING RETURNING id/)
      if (state.users.some((row) => row.email === values[0])) return { rows: [] }
      const row = {
        id: `00000000-0000-4000-8000-${String(state.users.length + 1).padStart(12, '0')}`,
        email: values[0], display_name: values[1], password_hash: values[2],
        department_id: state.departments.find((department) => department.code === values[3])?.id ?? null,
        is_active: true,
      }
      state.users.push(row)
      return { rows: [{ id: row.id }] }
    }
    if (/INSERT INTO user_roles /.test(text)) {
      const role = state.roles.find((row) => row.code === values[1])
      if (!role) return { rows: [] }
      state.bindings.push({ user_id: values[0], role_id: role.id })
      return { rows: [{ user_id: values[0] }] }
    }
    throw new Error('Unexpected seed query')
  }
  return {
    connect: async () => ({ query, release: () => { releases++ } }),
    get state() { return structuredClone(state) },
    get releases() { return releases },
    sql,
  }
}

const fixtures = {
  env: authorized,
  departments: [{ code: 'fictional-department', name: 'Fictional department' }],
  roles: [{ code: 'recruiter', name: 'Fictional role' }],
  users: [{ email: 'fictional-user@example.invalid', name: 'Fictional user', department: 'fictional-department', role: 'recruiter', password: 'fictional-test-only' }],
  hashPassword: async () => 'fictional-hash-only',
}

test('D: repeated seed preserves existing account, disabled department, global and workspace roles', async () => {
  const db = fakeDatabase({
    departments: [{ id: 'original-department', code: 'fictional-department', name: 'Original department', is_active: false }],
    roles: [{ id: 'original-role', code: 'recruiter', name: 'Original role' }],
    users: [{ id: 'original-user', email: fixtures.users[0].email, display_name: 'Original name', password_hash: 'unchanged-hash', department_id: 'another-department', is_active: false }],
    bindings: [{ user_id: 'original-user', role_id: 'another-role' }, { user_id: 'original-user', role_id: 'second-role' }],
    workspaceRoles: [{ user_id: 'original-user', role: 'custom-workspace-role' }],
  })
  const before = db.state
  for (let i = 0; i < 2; i++) {
    const summary = await seedDevelopmentData(db, { ...fixtures, passwordOverride: 'fictional-override-only' })
    assert.equal(summary.users, 0)
    assert.equal(summary.usersSkipped, 1)
    assert.equal(summary.roleBindings, 0)
    assert.deepEqual(db.state, before)
  }
  assert.equal(db.releases, 2)
})

test('E: new fictional development account is initialized once and subsequent runs are no-ops', async () => {
  const db = fakeDatabase()
  assertDevelopmentSeedAllowed(authorized)
  const summary = await seedDevelopmentData(db, fixtures)
  assert.deepEqual(summary, { departments: 1, roles: 1, users: 1, usersSkipped: 0, roleBindings: 1 })
  const state = db.state
  assert.equal(state.users[0].password_hash, 'fictional-hash-only')
  assert.equal(state.users[0].is_active, true)
  assert.equal(state.users[0].department_id, state.departments[0].id)
  assert.equal(state.bindings[0].role_id, state.roles[0].id)
  const repeated = await seedDevelopmentData(db, fixtures)
  assert.equal(repeated.usersSkipped, 1)
  assert.deepEqual(db.state, state)
})

test('seed helper refuses unauthorized callers before acquiring a connection', async () => {
  let connections = 0
  const db = { connect: async () => { connections++; throw new Error('Forbidden connection') } }
  await assert.rejects(seedDevelopmentData(db, { ...fixtures, env: { NODE_ENV: 'production', ALLOW_DEV_SEED: 'true' } }), /Development seed refused/)
  assert.equal(connections, 0)
})

test('seed rolls back all new data and releases its client if role binding fails', async () => {
  const db = fakeDatabase()
  await assert.rejects(seedDevelopmentData(db, { ...fixtures, users: [{ ...fixtures.users[0], role: 'nonexistent-role' }] }), /role binding failed/)
  assert.deepEqual(db.state, { departments: [], roles: [], users: [], bindings: [], workspaceRoles: [] })
  assert.equal(db.sql.at(-1), 'ROLLBACK')
  assert.equal(db.releases, 1)
})

test('F/static only: sensitive file categories have exclusions, with no later allow rules', () => {
  const rules = read('.dockerignore').split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
  const required = ['**/.env', '**/.env.*', '**/*.key', '**/*.pem', '**/*.dump', '**/*.sql', '**/*.log', '**/data', '**/uploads', '**/resumes', '**/recordings', '**/*.docx', '**/*.pdf', '**/*.wav', '**/.aws', '**/.wrangler', '**/.venv', '**/node_modules', '**/*credentials*.json', '**/*state*.json']
  for (const rule of required) assert.ok(rules.includes(rule), `Missing exclusion ${rule}`)
  assert.ok(rules.every((rule) => !rule.startsWith('!')))
  assert.deepEqual(read('ocr-service/.dockerignore').split(/\r?\n/).filter((line) => line && !line.startsWith('#')), ['**', '!Dockerfile', '!.dockerignore', '!requirements.txt', '!main.py'])
})

test('F/static only: API/Worker, Web and OCR COPY sources are restricted and exist', () => {
  for (const [path, context, allowed] of [
    ['deploy/Dockerfile.api', root, ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'apps/api/package.json', 'apps/worker/package.json', 'web/package.json', 'packages/contracts/package.json', 'packages/resume-intelligence/package.json', 'packages/object-storage/package.json', 'packages/enterprise-ai/package.json', 'apps/api/src', 'apps/api/tsconfig.json', 'apps/worker/src', 'apps/worker/scripts', 'apps/worker/tsconfig.json', 'packages/contracts/tsconfig*.json', 'packages/contracts/src', 'packages/contracts/scripts', 'packages/resume-intelligence/tsconfig*.json', 'packages/resume-intelligence/src', 'packages/resume-intelligence/scripts', 'packages/object-storage/tsconfig.json', 'packages/object-storage/src', 'packages/enterprise-ai/index.js', 'packages/enterprise-ai/index.d.ts']],
    ['deploy/Dockerfile.web', root, ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'web/package.json', 'web/index.html', 'web/tsconfig.json', 'web/vite.config.ts', 'web/src', 'web/public']],
    ['ocr-service/Dockerfile', resolve(root, 'ocr-service'), ['requirements.txt', 'main.py']],
  ]) {
    const sources = read(path).split(/\r?\n/).filter((line) => line.startsWith('COPY ')).flatMap((line) => line.trim().split(/\s+/).slice(1, -1))
    assert.deepEqual(sources, allowed)
    for (const source of sources) {
      if (source.endsWith('/tsconfig*.json')) {
        assert.ok(readdirSync(resolve(context, source.slice(0, -'tsconfig*.json'.length))).some((name) => /^tsconfig.*\.json$/.test(name)))
      } else {
        assert.ok(existsSync(resolve(context, source)), `Missing COPY input ${source}`)
      }
    }
  }
  const compose = read('deploy/docker-compose.yml')
  assert.equal((compose.match(/dockerfile: deploy\/Dockerfile\.api/g) ?? []).length, 2)
  assert.match(compose, /command: \["node", "apps\/worker\/dist\/src\/index\.js"\]/)
})
