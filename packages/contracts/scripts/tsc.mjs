import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const compilerCandidates = [
  resolve(packageRoot, 'node_modules/typescript/bin/tsc'),
  resolve(packageRoot, '../../web/node_modules/typescript/bin/tsc'),
]
const compiler = compilerCandidates.find((candidate) => existsSync(candidate))

if (!compiler) {
  console.error('TypeScript compiler not found. Install the package devDependencies first.')
  process.exit(1)
}

const result = spawnSync(process.execPath, [compiler, ...process.argv.slice(2)], {
  cwd: packageRoot,
  stdio: 'inherit',
})

if (result.error) {
  console.error(result.error)
  process.exit(1)
}

process.exit(result.status ?? 1)
