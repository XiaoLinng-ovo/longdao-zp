import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { sourceExclusionReason } from '../lib/server-source-policy.mjs'

const root = resolve(import.meta.dirname, '../..')

test('keeps deployable source, data modules, SQL migrations and env examples', () => {
  for (const path of ['apps/api/src/auth/request-origin.ts', 'apps/worker/src/db/persisted-poll.ts',
    'web/src/shared/data/demo-recruiting-data.ts', 'packages/database-readiness/structure-contract.json',
    'packages/enterprise-ai/execution.js', 'db/migrations/0108_enterprise_administration.sql',
    '.env.example', 'deploy/runtime.production.env.example', 'deploy/modelscope/runtime.native.env.example',
    'funasr-service/server.py', 'faster-whisper-service/Dockerfile', 'ocr-service/requirements.txt']) {
    assert.equal(sourceExclusionReason(path), null, path)
  }
})

test('excludes private config, backup variants and cloud identities', () => {
  for (const path of ['.env', '.env.bak-20261120', 'apps/api/.env', 'deploy/runtime.production.env',
    'deploy/modelscope/runtime.env', 'deploy/modelscope/runtime.native.env', 'scripts/.npmrc',
    'deploy/.aws/credentials', 'deploy/.cloudflared/tunnel.json', 'deploy/service-account.json',
    'deploy/id_ed25519', 'deploy/server.key', 'deploy/server.pem', 'deploy/environment-before-release']) {
    assert.ok(sourceExclusionReason(path), path)
  }
})

test('excludes dependencies, stale builds, caches, business data and models', () => {
  for (const path of ['node_modules/a/index.js', 'apps/api/dist/src/index.js', 'web/dist-old/index.html',
    'packages/contracts/dist-test/index.js', 'funasr-service/.venv/server.py', 'ocr-service/__pycache__/main.pyc',
    'web/.vite/results.json', 'apps/api/data/state.json', 'apps/worker/tmp/fixture.json',
    'data/auth-sessions.json', 'backups/export.sql', 'reports/report.json', 'models/weights.bin',
    'apps/api/tmp-db-check.mjs', 'scripts/_tmp_probe.mjs', 'docs/manual-screenshots/home.png']) {
    assert.ok(sourceExclusionReason(path), path)
  }
})

test('refuses traversal and platform-dependent archive names', () => {
  for (const path of ['../.env', 'apps/../../secret', '/absolute', 'apps\\api\\src\\index.ts']) {
    assert.equal(sourceExclusionReason(path), 'unsafe-path', path)
  }
})

test('dry run reviews the current working files and includes new migration sources', () => {
  const report = JSON.parse(execFileSync(process.execPath, ['scripts/package-server-source.mjs', '--dry-run'], {
    cwd: root, windowsHide: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  }))
  assert.equal(report.source, 'saved-working-tree-including-uncommitted-and-untracked-files')
  const files = new Map(report.files.map(file => [file.path, file]))
  for (const path of ['Dockerfile', 'Dockerfile.dockerignore', 'compose.production.yml',
    'deploy/PACKAGING.md', 'deploy/PRODUCTION.md', 'deploy/runtime.production.env.example',
    'db/migrations/0107_enterprise_ai_self_service.sql', 'db/migrations/0108_enterprise_administration.sql',
    'apps/api/src/auth/request-origin.ts', 'scripts/lib/server-source-policy.mjs']) assert.ok(files.has(path), path)
  assert.equal(report.migrations, report.files.filter(file => /^db\/migrations\/.*\.sql$/u.test(file.path)).length)
  for (const file of report.files) {
    assert.equal(sourceExclusionReason(file.path), null, file.path)
    const content = readFileSync(resolve(root, file.path))
    assert.equal(file.bytes, content.length, file.path)
    assert.equal(file.sha256, createHash('sha256').update(content).digest('hex'), file.path)
  }
})
