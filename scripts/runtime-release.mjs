import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { cp, lstat, mkdir, readFile, readdir, readlink, realpath, statfs, writeFile } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { verifyReleaseOriginPolicy } from './runtime-origin-check.mjs'

const digest = content => createHash('sha256').update(content).digest('hex')
const inside = (root, path) => { const child = relative(root, path); return child === '' || (!child.startsWith('..') && !isAbsolute(child)) }

export async function releaseFiles(root) {
  const files = [], pending = []
  const visit = async dir => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name), name = relative(root, file).replaceAll('\\', '/')
      if (name === 'release-manifest.json') continue
      if (entry.isSymbolicLink()) {
        if (!inside(root, await realpath(file))) throw new Error('RELEASE_LINK: Dependency escapes release: ' + name)
        files.push({ path: name, link: await readlink(file) })
      } else if (entry.isDirectory()) await visit(file)
      else if (entry.isFile()) pending.push({ file, name })
      else throw new Error('RELEASE_TYPE: Unsupported artifact ' + name)
    }
  }
  await visit(root)
  // Bound concurrent reads: dependency manifests contain many small files.
  let next = 0
  await Promise.all(Array.from({ length: Math.min(8, pending.length) }, async () => {
    while (next < pending.length) {
      const { file, name } = pending[next++]
      files.push({ path: name, sha256: digest(await readFile(file)) })
    }
  }))
  return files.sort((a, b) => a.path.localeCompare(b.path, 'en'))
}

export async function verifyRelease(root) {
  const manifest = JSON.parse(await readFile(join(root, 'release-manifest.json'), 'utf8'))
  if (manifest.format !== 1 || !/^[a-zA-Z0-9_.-]+$/.test(manifest.id)) throw new Error('RELEASE_MANIFEST: Invalid release identity')
  const actual = await releaseFiles(root)
  if (digest(JSON.stringify(actual)) !== manifest.sha256 || JSON.stringify(actual) !== JSON.stringify(manifest.files)) throw new Error('RELEASE_CHANGED: Artifact checksums differ; rebuild a candidate, never repair a running release.')
  return manifest
}

export async function assertReleaseCapacity(destination, minimumBytes = 2n * 1024n ** 3n) {
  let parent = resolve(destination)
  while (true) {
    try {
      const disk = await statfs(parent,{bigint:true}),available=disk.bavail*disk.bsize
      if(available < minimumBytes) throw Error('RELEASE_DISK_SPACE: At least 2 GiB of free space is required before building a new candidate')
      return
    } catch(error) {
      if(error.code !== 'ENOENT' || dirname(parent) === parent) throw error
      parent=dirname(parent)
    }
  }
}

export async function retainPreviousWebAssets(destination, previousRoot, olderRoot) {
  if (!previousRoot) return
  const previous = await verifyRelease(previousRoot)
  const older = olderRoot ? await verifyRelease(olderRoot) : previous
  const generations = [
    { root: previousRoot, manifest: previous, prefix: 'web/dist/assets/', generation: 1 },
    { root: olderRoot || previousRoot, manifest: older, prefix: olderRoot ? 'web/dist/assets/' : 'web/dist/previous-assets/1/assets/', generation: 2 },
  ]
  // Only public build assets survive, with a fixed two-release retention window.
  for (const { root, manifest, prefix, generation } of generations) {
    for (const file of manifest.files.filter(file => file.path.startsWith(prefix))) {
      if (file.link || !inside(root, resolve(root, file.path))) throw new Error('RELEASE_ASSET: Invalid previous asset')
      const target = join(destination, 'web/dist/previous-assets', String(generation), 'assets', file.path.slice(prefix.length))
      const content = await readFile(join(root, file.path))
      if (digest(content) !== file.sha256) throw new Error('RELEASE_ASSET: Previous asset changed: ' + file.path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content, { flag: 'wx' })
    }
  }
}

export async function prepareRelease(root, destination, { pnpmCli, pnpmStore } = {}) {
  if(pnpmStore && !isAbsolute(pnpmStore)) throw Error('BUILD_TOOL: pnpm store must be absolute')
  await assertReleaseCapacity(destination)
  await mkdir(dirname(destination), { recursive: true })
  await mkdir(destination) // Never reuse or overwrite a candidate, including a failed build.
  const filter = file => !/(?:^|[\\/])(?:node_modules|dist|dist-test|coverage|\.env(?:\..*)?|\.git)(?:[\\/]|$)/u.test(relative(root, file))
  for (const path of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'apps/api/package.json', 'apps/api/src', 'apps/api/tsconfig.json', 'apps/api/tsconfig.build.json', 'apps/worker/package.json', 'apps/worker/src', 'apps/worker/scripts', 'apps/worker/tsconfig.json', 'apps/worker/tsconfig.build.json', 'packages', 'web/package.json', 'web/index.html', 'web/vite.config.ts', 'web/tsconfig.json', 'web/src', 'web/public']) {
    await mkdir(dirname(join(destination, path)), { recursive: true })
    await cp(join(root, path), join(destination, path), { recursive: true, filter, errorOnExist: true, force: false })
  }
  for (const path of ['db/migrations', 'scripts']) {
    await mkdir(join(destination, path), { recursive: true })
    const names = path === 'scripts' ? ['runtime-config.mjs', 'runtime-log.mjs', 'runtime-role.mjs', 'runtime-doctor.mjs', 'runtime-origin-check.mjs', 'runtime-release.mjs', 'runtime-control.mjs', 'serve-web-production.mjs', 'check-company-schemas.mjs', 'company-data-model.mjs', 'company-data-maintenance.mjs', 'maintenance-company-data.mjs', 'runtime-probes.mjs', 'maintenance-migrations.mjs', 'migration-approval.mjs', 'runtime-recovery-audit.mjs', 'private-recovery-files.mjs'] : await readdir(join(root, path))
    for (const name of names) await cp(join(root, path, name), join(destination, path, name), { errorOnExist: true, force: false })
  }
  for (const name of ['company-conflict-repair.mjs','maintenance-five-decisions.mjs','recovery-snapshot.mjs'])
    await cp(join(root,'scripts',name),join(destination,'scripts',name),{errorOnExist:true,force:false})
  await import(pathToFileURL(join(destination, 'scripts/runtime-control.mjs')).href)
  await import(pathToFileURL(join(destination, 'scripts/maintenance-company-data.mjs')).href)
  await import(pathToFileURL(join(destination, 'scripts/maintenance-five-decisions.mjs')).href)
  await import(pathToFileURL(join(destination, 'scripts/runtime-recovery-audit.mjs')).href)
  if (!pnpmCli) {
    for (const dir of (process.env.PATH || '').split(delimiter)) {
      const candidate = join(dir, 'node_modules/pnpm/bin/pnpm.cjs')
      try { await lstat(candidate); pnpmCli = candidate; break } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
  }
  if (!pnpmCli || !isAbsolute(pnpmCli)) throw new Error('BUILD_TOOL: Pass --pnpm-cli <absolute pnpm.cjs>')
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC|APPDATA|LOCALAPPDATA|USERPROFILE|HOME|PATHEXT|SYSTEMDRIVE|NUMBER_OF_PROCESSORS)$/iu.test(key)))
  env.CI = 'true'
  const run = args => new Promise((yes, no) => {
    const child = spawn(process.execPath, [pnpmCli, ...args], { cwd: destination, env, stdio: 'inherit', windowsHide: true })
    child.once('error', no)
    child.once('exit', code => code === 0 ? yes() : no(new Error('Candidate build failed (' + code + '); active release unchanged')))
  })
  await run(['install', '--frozen-lockfile', '--offline', '--ignore-scripts', '--package-import-method=copy', ...(pnpmStore ? ['--store-dir',pnpmStore] : [])])
  for (const name of ['@smartrecruit-pro/contracts', '@smartrecruit-pro/object-storage', '@smartrecruit-pro/resume-intelligence', '@smartrecruit-pro/enterprise-ai', '@smartrecruit-pro/api', '@smartrecruit-pro/worker']) {
    await run(['--filter', name, name.endsWith('/api') || name.endsWith('/worker') ? 'build:production' : 'build'])
  }
  await run(['--dir', 'web', 'build'])
  await verifyReleaseOriginPolicy(destination)
  let previousRelease
  try { previousRelease = JSON.parse(await readFile(join(root, 'logs/runtime/active-release.json'), 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  if (previousRelease) {
    if (!inside(join(root, 'logs/runtime/releases'), resolve(previousRelease.directory))) throw new Error('RELEASE_ASSET: Previous release escapes runtime directory')
    await retainPreviousWebAssets(destination, previousRelease.directory)
  }
  const files = await releaseFiles(destination)
  const id = destination.split(/[\\/]/u).at(-1)
  const manifest = { format: 1, id, createdAt: new Date().toISOString(), node: process.version, manager: 'pm2@7.1.2', sha256: digest(JSON.stringify(files)), files }
  await writeFile(join(destination, 'release-manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' })
  return { id, directory: destination, files: files.length, sha256: manifest.sha256 }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const root = resolve(import.meta.dirname, '..')
    const index = process.argv.indexOf('--output')
    const destination = index < 0 ? join(root, 'logs/runtime/releases', new Date().toISOString().replace(/[:.]/gu, '-') + '-candidate') : resolve(process.argv[index + 1])
    const cli = process.argv.indexOf('--pnpm-cli')
    const store = process.argv.indexOf('--pnpm-store')
    console.log(JSON.stringify(await prepareRelease(root, destination, { pnpmCli: cli < 0 ? undefined : process.argv[cli + 1], pnpmStore: store < 0 ? undefined : process.argv[store + 1] }), null, 2))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
