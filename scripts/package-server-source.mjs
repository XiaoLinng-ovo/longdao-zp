import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync, rmdirSync, renameSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { credentialSignatures } from './check-release-credentials.mjs'
import { parseRuntimeEnv } from './runtime-config.mjs'

const root = resolve(import.meta.dirname, '..')
const output = resolve(process.argv[2] ?? resolve(root, '..', 'SmartRecruit-source.zip'))
const run = (program, args, options = {}) => execFileSync(program, args, {
  cwd: root, windowsHide: true, maxBuffer: 32 * 1024 * 1024, ...options,
})
const scopes = 'apps packages web db deploy scripts ocr-service funasr-service faster-whisper-service .github'.split(' ')
const primary = 'Dockerfile Dockerfile.dockerignore compose.production.yml .dockerignore .gitignore .env.example package.json pnpm-lock.yaml pnpm-workspace.yaml README.md'.split(' ')
const docs = ['workspace-invitations', 'funasr-only-transcription', 'interview-audio-capture', 'open-registration-user-management'].map(name => `docs/${name}.md`)
const excluded = /(?:^|\/)(?:node_modules|dist(?:-[^/]+)?|coverage|\.git|\.venv|__pycache__|\.vite|\.cache|\.pnpm-store|\.pytest_cache|logs|tmp|backups?|uploads|recordings)(?:\/|$)|^(?:apps\/[^/]+|web|packages\/[^/]+)\/data\/|(?:^|\/)(?:_tmp_|\.codex|\.tmp-)|\.(?:pem|key|pfx|p12|sqlite3?|db|dump|bak\w*|log|zip|pdf|docx?|xlsx?|csv|mp3|wav|webm|7z|gz|tar|bin)$/iu
const privateConfig = /(?:^|\/)\.env(?:\.|$)|\.env(?:\.|$)|(?:^|\/)(?:\.npmrc|\.pgpass|\.netrc|\.git-credentials)$/iu
const candidates = run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...scopes], { encoding: 'utf8' }).split('\0')
const selected = [...new Set([...primary, ...docs, ...candidates])].filter(path =>
  path && !excluded.test(path) && (!privateConfig.test(path) || path.endsWith('.env.example')) && existsSync(join(root, path)),
).sort()
const migrations = readdirSync(join(root, 'db/migrations')).filter(name => /^\d+.*\.sql$/u.test(name))
for (const file of [...primary, 'deploy/PRODUCTION.md', ...migrations.map(name => `db/migrations/${name}`)]) {
  if (!selected.includes(file)) throw new Error(`Required source missing: ${file}`)
}

// Compare text with real local secrets, but recognize the repository's documented development placeholder.
const devPlaceholders = new Set(['change-me-in-development', 'password', 'your_password', 'changeme', 'example', 'replace-me'])
const localSecrets = new Map()
for (const file of readdirSync(root).filter(name => /^\.env(?:$|\.(?!example$))/u.test(name))) {
  if (!lstatSync(join(root, file)).isFile()) continue
  for (const [key, value] of Object.entries(parseRuntimeEnv(readFileSync(join(root, file), 'utf8')))) {
    if (!/PASSWORD|SECRET|TOKEN|API_KEY|DATABASE_URL|PRIVATE_KEY|ENCRYPTION_KEY/iu.test(key)) continue
    let secret = value
    if (key === 'DATABASE_URL') {
      try { secret = decodeURIComponent(new URL(value).password) } catch { continue }
    }
    if (secret.length >= 8 && !devPlaceholders.has(secret)) localSecrets.set(secret, key)
  }
}
const findings = []
for (const file of selected) {
  const path = join(root, file)
  if (!lstatSync(path).isFile()) throw new Error(`Unexpected file type: ${file}`)
  const content = readFileSync(path)
  if (content.includes(0)) throw new Error(`Unreviewed binary: ${file}`)
  const text = content.toString('utf8')
  for (const { rule, line } of credentialSignatures(text)) {
    if (rule === 'private-key' && /\.test\.[cm]?[jt]sx?$/.test(file) && text.split('\n')[line - 1]?.includes('fixture-private-key')) continue
    findings.push({ file, rule, line })
  }
  for (const [secret, key] of localSecrets) {
    if (text.includes(secret)) findings.push({ file, rule: `matches-local-${key}` })
  }
}
if (findings.length) throw new Error(`Credential review failed: ${JSON.stringify(findings)}`)
if (existsSync(output)) throw new Error(`Refusing to overwrite ${output}`)

const temporary = mkdtempSync(join(dirname(output), '.source-package-'))
try {
  const tar = process.platform === 'win32' ? 'tar.exe' : 'bsdtar'
  const list = join(temporary, 'files.nul')
  const archive = join(temporary, basename(output))
  writeFileSync(list, selected.join('\0') + '\0')
  run(tar, ['--format', 'zip', '-cf', archive, '--null', '-T', list])
  const entries = run(tar, ['-tf', archive], { encoding: 'utf8' }).trim().split(/\r?\n/u).sort()
  if (JSON.stringify(entries) !== JSON.stringify(selected)) throw new Error('Archive entry list differs from the reviewed source list')
  renameSync(archive, output)
  console.log(JSON.stringify({ path: output, files: selected.length, migrations: migrations.length, bytes: lstatSync(output).size }))
} finally {
  for (const file of readdirSync(temporary)) rmSync(join(temporary, file))
  rmdirSync(temporary)
}
