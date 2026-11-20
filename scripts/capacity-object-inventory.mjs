import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, open, opendir } from 'node:fs/promises'
import { join } from 'node:path'

export async function capacityObjectInventory(root, deletingKeys = new Set(), {
  maxEntries = 50000, maxDepth = 12, maxBytes = 1024 ** 3, openFile = open,
} = {}) {
  for (const limit of [maxEntries, maxDepth, maxBytes]) assert.ok(Number.isSafeInteger(limit) && limit >= 0)
  const result = [], buffer = Buffer.alloc(64 * 1024)
  let entries = 0, total = 0
  async function visit(directory, prefix, depth) {
    assert.ok(depth <= maxDepth, '对象目录深度超出预算')
    assert.ok((await lstat(directory)).isDirectory(), '对象根或子目录不是实体目录')
    for await (const item of await opendir(directory)) {
      assert.ok(++entries <= maxEntries, '对象目录条目超出预算')
      const path = join(directory, item.name), key = prefix + item.name
      if (item.isDirectory()) {
        await visit(path, key + '/', depth + 1)
        continue
      }
      assert.ok(item.isFile(), '对象目录不允许链接或特殊文件')
      let handle
      try {
        const before = await lstat(path)
        assert.ok(before.isFile() && before.nlink === 1, '对象必须是独立的普通文件')
        handle = await openFile(path, 'r')
        const opened = await handle.stat()
        assert.ok(opened.isFile() && opened.dev === before.dev && opened.ino === before.ino && opened.nlink === 1, '对象身份在打开时改变')
        assert.ok(opened.size <= maxBytes - total, '对象总字节超出预算')
        const hash = createHash('sha256')
        let bytes = 0
        for (;;) {
          const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, maxBytes - total + 1), null)
          if (!bytesRead) break
          total += bytesRead
          bytes += bytesRead
          assert.ok(total <= maxBytes && bytes <= opened.size, '对象字节超出预算或在扫描中增长')
          hash.update(buffer.subarray(0, bytesRead))
        }
        const after = await lstat(path)
        assert.ok(after.isFile() && after.nlink === 1 && after.dev === opened.dev && after.ino === opened.ino &&
          bytes === after.size && bytes === opened.size && after.mtimeMs === opened.mtimeMs, '对象在扫描中变化')
        result.push({ key, bytes, hash: hash.digest('hex') })
      } catch (error) {
        if (error.code !== 'ENOENT' || !deletingKeys.has(key)) throw error
      } finally {
        await handle?.close()
      }
    }
  }
  await visit(root, '', 0)
  return result
}
