import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, open, unlink, rm, mkdir, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { capacityObjectInventory } from '../capacity-object-inventory.mjs'

for (const allowed of [false, true]) test('枚举后文件被删，仅允许明确登记的删除键：' + allowed, async () => {
  const root = await mkdtemp(join(tmpdir(), 'capacity-inventory-'))
  try {
    await writeFile(join(root, 'deleted.txt'), 'fixture')
    const openFile = async path => { await unlink(path); return open(path, 'r') }
    const scan = capacityObjectInventory(root, new Set(allowed ? ['deleted.txt'] : []), { openFile })
    if (allowed) assert.deepEqual(await scan, [])
    else await assert.rejects(scan, { code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('逐块散列并限制目录、条目、总字节，拒绝硬链接', async () => {
  const root = await mkdtemp(join(tmpdir(), 'capacity-inventory-'))
  try {
    await mkdir(join(root, 'nested'))
    const data = Buffer.alloc(140000, 42), path = join(root, 'nested', 'sample')
    await writeFile(path, data)
    assert.deepEqual(await capacityObjectInventory(root, new Set(), { maxBytes: data.length }),
      [{ key: 'nested/sample', bytes: data.length, hash: createHash('sha256').update(data).digest('hex') }])
    for (const limits of [{ maxEntries: 1 }, { maxDepth: 0 }, { maxBytes: data.length - 1 }]) {
      await assert.rejects(capacityObjectInventory(root, new Set(), limits), /预算/)
    }
    await link(path, join(root, 'hardlink'))
    await assert.rejects(capacityObjectInventory(root), /独立的普通文件/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('完整对象以真实字节数和散列对账', async () => {
  const root = await mkdtemp(join(tmpdir(), 'capacity-inventory-'))
  try {
    await writeFile(join(root, 'kept.txt'), 'fixture')
    assert.deepEqual(await capacityObjectInventory(root), [{ key: 'kept.txt', bytes: 7, hash: createHash('sha256').update('fixture').digest('hex') }])
  } finally { await rm(root, { recursive: true, force: true }) }
})
