import { readdir, access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve, relative, join } from 'node:path'
import { spawn } from 'node:child_process'

const root = fileURLToPath(new URL('../', import.meta.url))
const app = process.argv[2]
if (!['api', 'worker'].includes(app)) throw new Error('Usage: node scripts/run-source-unit-tests.mjs api|worker')
const directory = resolve(root, 'apps', app)
async function collect(folder) {
  const entries = await readdir(folder, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = join(folder, entry.name)
    if (entry.isDirectory()) files.push(...await collect(path))
    else if (entry.name.endsWith('.test.ts') && !entry.name.includes('.integration.')) files.push(path)
  }
  return files
}
const sources = [...await collect(join(directory, 'src')), ...await collect(join(directory, 'tests'))]
const tests = sources.map(file => join(directory, 'dist', relative(directory, file).replace(/\.ts$/, '.js'))).sort()
for (const file of tests) await access(file)
console.log('Running ' + tests.length + ' source-backed test files; PostgreSQL integration tests are excluded.')
const child = spawn(process.execPath, ['--test', '--test-reporter=spec', ...tests], { cwd: root, env: { ...process.env, NODE_ENV: 'test' }, stdio: 'inherit', windowsHide: true })
child.on('error', error => { console.error(error.message); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
