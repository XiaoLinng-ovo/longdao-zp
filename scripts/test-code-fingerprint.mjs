import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'

// Only inspect code and dependency manifests, never environment files or stored business data.
export async function testCodeFingerprint(root) {
  const files = new Set()
  const visit = async directory => {
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) }
    catch (error) { if (error.code === 'ENOENT') return; throw error }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || ['node_modules', '.git', 'coverage', '.cache'].includes(entry.name)) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if ((/\.(?:[cm]?js|ts|vue|css|sql|json|ya?ml)$/.test(entry.name) || entry.name.startsWith('Dockerfile')) && !entry.name.startsWith('.')) files.add(path)
    }
  }
  for (const directory of ['apps/api/src', 'apps/api/dist', 'apps/worker/src', 'apps/worker/dist', 'web/src', 'packages', 'scripts', 'db/migrations', 'deploy']) await visit(join(root, directory))
  for (const path of ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.dockerignore', 'apps/api/package.json', 'apps/worker/package.json', 'web/package.json', 'web/package-lock.json']) {
    try { await readFile(join(root, path)); files.add(join(root, path)) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const hashes = []
  for (const file of [...files].sort()) hashes.push({ path: relative(root, file).replaceAll('\\', '/'), sha256: createHash('sha256').update(await readFile(file)).digest('hex') })
  return { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim(), sha256: createHash('sha256').update(JSON.stringify(hashes)).digest('hex'), files: hashes }
}
