import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, mkdtempSync, writeFileSync, mkdirSync, rmSync, renameSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { credentialSignatures } from './check-release-credentials.mjs'
import { parseRuntimeEnv } from './runtime-config.mjs'
import { sourceExclusionReason } from './lib/server-source-policy.mjs'

const root = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const targets = args.filter(arg => arg !== '--dry-run')
if (targets.length > 1 || targets.some(arg => arg.startsWith('--'))) throw new Error('Usage: node scripts/package-server-source.mjs [output.zip] [--dry-run]')
const output = resolve(targets[0] ?? resolve(root, '..', 'SmartRecruit-source.zip'))
if (!output.endsWith('.zip')) throw new Error('Output must be a .zip file')
const run = (program, args, options = {}) => execFileSync(program, args, {
  cwd: root, windowsHide: true, maxBuffer: 32 * 1024 * 1024, ...options,
})
const scopes = 'apps packages web db deploy scripts ocr-service funasr-service faster-whisper-service docs .github'.split(' ')
const primary = 'Dockerfile Dockerfile.dockerignore compose.production.yml .dockerignore .gitignore .env.example package.json pnpm-lock.yaml pnpm-workspace.yaml README.md'.split(' ')
const candidates = run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...scopes], { encoding: 'utf8' }).split('\0').filter(Boolean)
const reviewed = [...new Set([...primary, ...candidates])].sort()
const selected = reviewed.filter(path => !sourceExclusionReason(path) && existsSync(join(root, path)))
const excluded = reviewed.filter(path => sourceExclusionReason(path)).map(path => ({ path, reason: sourceExclusionReason(path) }))
const migrations = readdirSync(join(root, 'db/migrations')).filter(name => /^\d+.*\.sql$/u.test(name))
for (const file of [...primary, 'deploy/PRODUCTION.md', 'deploy/PACKAGING.md', 'deploy/runtime.production.env.example', ...migrations.map(name => `db/migrations/${name}`)]) {
  if (!selected.includes(file)) throw new Error(`Required source missing: ${file}`)
}

// Compare text with real local secrets, but recognize the repository's documented development placeholder.
const devPlaceholders = new Set(['change-me-in-development', 'password', 'your_password', 'changeme', 'example', 'replace-me'])
const localSecrets = new Map()
for (const directory of ['', 'apps', 'apps/api', 'apps/worker', 'web', 'deploy', 'deploy/modelscope']) {
  for (const name of readdirSync(join(root, directory)).filter(name => /(?:^\.env(?:$|\.)|\.env(?:$|\.))/u.test(name) && !name.endsWith('.env.example'))) {
    const file = join(root, directory, name)
    if (!lstatSync(file).isFile()) continue
    for (const [key, value] of Object.entries(parseRuntimeEnv(readFileSync(file, 'utf8')))) {
      if (!/PASSWORD|SECRET|TOKEN|API_KEY|DATABASE_URL|PRIVATE_KEY|ENCRYPTION_KEY/iu.test(key)) continue
      let secret = value
      if (key === 'DATABASE_URL') {
        try { secret = decodeURIComponent(new URL(value).password) } catch { continue }
      }
      if (secret.length >= 8 && !devPlaceholders.has(secret)) localSecrets.set(secret, key)
    }
  }
}
const findings = []
const snapshots = new Map()
for (const file of selected) {
  const path = join(root, file)
  if (!lstatSync(path).isFile()) throw new Error(`Unexpected file type: ${file}`)
  const content = readFileSync(path)
  snapshots.set(file, content)
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
const sha256 = content => createHash('sha256').update(content).digest('hex')
const manifest = {
  format: 1, createdAt: new Date().toISOString(),
  source: 'saved-working-tree-including-uncommitted-and-untracked-files',
  migrations: migrations.length,
  files: selected.map(path => ({ path, bytes: snapshots.get(path).length, sha256: sha256(snapshots.get(path)) })),
  excludedCandidates: excluded,
  exclusionNotes: 'Ignored dependency, runtime, secret and cache directories are not enumerated. See deploy/PACKAGING.md.',
}
if (dryRun) {
  console.log(JSON.stringify({ ...manifest, sourceBytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0) }, null, 2))
} else {
  if (existsSync(output) || existsSync(output + '.sha256')) throw new Error('Refusing to overwrite an existing archive or checksum: ' + output)
  const temporary = mkdtempSync(join(dirname(output), '.source-package-'))
  try {
    const tar = process.platform === 'win32' ? 'tar.exe' : 'bsdtar'
    const staging = join(temporary, 'source')
    mkdirSync(staging)
    // Archive the exact buffers that passed credential review, not changing live files.
    for (const [file, content] of snapshots) {
      const destination = join(staging, file)
      mkdirSync(dirname(destination), { recursive: true })
      writeFileSync(destination, content, { flag: 'wx' })
    }
    writeFileSync(join(staging, 'SOURCE-MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
    const expected = [...selected, 'SOURCE-MANIFEST.json'].sort()
    const list = join(temporary, 'files.nul')
    const archive = join(temporary, basename(output))
    writeFileSync(list, expected.join('\0') + '\0')
    run(tar, ['--format', 'zip', '-cf', archive, '--null', '-T', list], { cwd: staging })
    const entries = run(tar, ['-tf', archive], { encoding: 'utf8' }).trim().split(/\r?\n/u).sort()
    if (JSON.stringify(entries) !== JSON.stringify(expected)) throw new Error('Archive entry list differs from the reviewed source list')
    const checksum = sha256(readFileSync(archive))
    writeFileSync(output + '.sha256', checksum + '  ' + basename(output) + '\n', { flag: 'wx' })
    renameSync(archive, output)
    console.log(JSON.stringify({ path: output, files: expected.length, migrations: migrations.length, bytes: lstatSync(output).size, sha256: checksum }))
  } finally {
    if (dirname(resolve(temporary)) !== dirname(output) || !basename(temporary).startsWith('.source-package-')) throw new Error('Unsafe temporary cleanup path')
    rmSync(temporary, { recursive: true, force: true })
  }
}
