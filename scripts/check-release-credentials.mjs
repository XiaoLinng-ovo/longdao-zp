import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const sensitivePath = /(?:^|\/)(?:environment-(?:before|after)-release|\.env(?:\.(?!example$)[^/]*)?|\.pgpass|\.netrc|\.git-credentials|[^/]+\.(?:pem|key|p12|pfx|dump|backup|bak))$/i
const maxBytes = 8 * 1024 * 1024

export function credentialSignatures(text) {
  const findings = []
  for (const [rule, pattern] of [
    ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g],
    ['provider-secret', /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{24,}|AKIA[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{30,})\b/g],
    ['credential-url', /\b(?:postgres(?:ql)?|mysql|redis|smtps?):\/\/[^\s:/]+:([^\s@/]{8,})@/g],
  ]) {
    for (const match of text.matchAll(pattern)) {
      if (rule === 'credential-url' && /^(?:password|your_password|changeme|example|replace[_-]me|change-me-in-development|\$\{[^}]+\}|<[^>]+>)$/i.test(match[1])) continue
      findings.push({ rule, line: text.slice(0, match.index).split('\n').length })
    }
  }
  return findings
}

export function inspectReleaseCredentials(directory = root) {
  const git = args => execFileSync('git', args, { cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).toString('utf8')
  const findings = [], skipped = []
  // Include new release files as well as tracked and staged versions; never run hooks.
  const tracked = git(['ls-files', '--cached', '--deduplicate', '-z']).split('\0').filter(Boolean)
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)
  const trackedSet = new Set(tracked)
  const files = [...new Set([...tracked, ...untracked])]
  const changed = new Set(git(['diff', '--name-only', '-z', '--no-ext-diff', '--no-textconv']).split('\0').filter(Boolean))
  for (const file of files) {
    if (sensitivePath.test(file)) { findings.push({ file, rule: 'sensitive-path' }); continue }
    const scan = (source, content) => {
      if (content.includes(0)) { skipped.push({ file, source, reason: 'binary' }); return }
      const text = content.toString('utf8')
      for (const hit of credentialSignatures(text)) {
        const line = text.split('\n')[hit.line - 1]
        if (hit.rule === 'private-key' && /\.test\.[cm]?[jt]sx?$/.test(file) && /PRIVATE KEY-----\\nfixture-private-key\\n-----END (?:RSA )?PRIVATE KEY-----/.test(line)) continue
        findings.push({ file, source, ...hit })
      }
    }
    const path = resolve(directory, file)
    try {
      const meta = lstatSync(path)
      if (!meta.isFile()) findings.push({ file, rule: 'unexpected-working-tree-file-type' })
      else if (meta.size <= maxBytes) scan('working-tree', readFileSync(path))
      else skipped.push({ file, source: 'working-tree', reason: 'size-limit' })
    } catch (error) {
      if (error.code === 'ENOENT') changed.add(file)
      else findings.push({ file, rule: 'unreadable-working-tree-file' })
    }
    if (trackedSet.has(file) && changed.has(file)) {
      const object = ':' + file
      if (Number(git(['cat-file', '-s', object])) > maxBytes) skipped.push({ file, source: 'index', reason: 'size-limit' })
      else scan('index', Buffer.from(git(['cat-file', 'blob', object])))
    }
  }
  return { findings, skipped, scope: { tracked: tracked.length, untracked: untracked.length, ignoredFiles: 'not-scanned', archives: 'not-expanded', history: 'not-scanned' } }
}

export function assertReleaseCredentials(directory = root) {
  const { findings, skipped } = inspectReleaseCredentials(directory)
  if (findings.length) throw new Error('发布凭据检查未通过：' + JSON.stringify(findings))
  return { skipped: skipped.length }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify({ passed: true, ...assertReleaseCredentials() })) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
