import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = fileURLToPath(new URL('../..', import.meta.url))
const ts = createRequire(resolve(root, 'web/package.json'))('typescript')
const docker = readFileSync(resolve(root, 'deploy/Dockerfile.api'), 'utf8')
const copied = new Set(docker.split(/\r?\n/).filter(line => line.startsWith('COPY '))
  .flatMap(line => line.trim().split(/\s+/).slice(1, -1)).map(source => resolve(root, source)))

test('生产构建排除测试且不改变普通测试构建范围', () => {
  for (const app of ['api', 'worker']) {
    const directory = resolve(root, 'apps', app)
    const base = JSON.parse(readFileSync(resolve(directory, 'tsconfig.json'), 'utf8'))
    const build = JSON.parse(readFileSync(resolve(directory, 'tsconfig.build.json'), 'utf8'))
    assert.ok(base.include.includes('tests/**/*.ts'))
    assert.deepEqual(build.include, ['src/**/*.ts'])
    assert.ok(build.exclude.includes('src/**/*.test.ts'))
    assert.ok(build.exclude.includes('tests'))
    const manifest = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'))
    assert.match(manifest.scripts['build:production'], /tsconfig\.build\.json/)
    assert.match(docker, new RegExp('@smartrecruit-pro/' + app + ' build:production'))
  }
  assert.ok(copied.has(resolve(root, 'packages/database-readiness/structure-contract.json')))
})

for (const entry of ['packages/enterprise-ai/index.js', 'packages/database-readiness/index.js', 'packages/runtime-lifecycle/index.js']) {
  test('容器共享包相对运行依赖必须完整打包：' + entry, () => {
    const checked = new Set()
    function visit(path) {
      if (checked.has(path)) return
      assert.ok(copied.has(path), '容器缺少运行依赖：' + path)
      checked.add(path)
      const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
      const inspect = node => {
        let specifier
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) specifier = node.arguments[0]
        if (specifier && ts.isStringLiteral(specifier)) {
          if (specifier.text.startsWith('.')) visit(resolve(dirname(path), specifier.text))
          else if (specifier.text.startsWith('@smartrecruit-pro/')) {
            const packageDirectory = resolve(root, 'packages', specifier.text.slice('@smartrecruit-pro/'.length))
            assert.ok(copied.has(resolve(packageDirectory, 'package.json')), '容器缺少工作区包清单：' + specifier.text)
            const manifest = JSON.parse(readFileSync(resolve(packageDirectory, 'package.json'), 'utf8'))
            const target = manifest.exports?.['.']?.import ?? manifest.main
            assert.equal(typeof target, 'string', '无法解析工作区入口：' + specifier.text)
            visit(resolve(packageDirectory, target))
          }
        }
        ts.forEachChild(node, inspect)
      }
      inspect(source)
    }
    visit(resolve(root, entry))
  })
}
