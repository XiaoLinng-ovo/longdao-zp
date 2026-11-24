import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'

export async function openEvidenceJournal(path, maxBytes) {
  assert.ok(Number.isSafeInteger(maxBytes) && maxBytes > 0)
  const file = await open(path, 'wx', 0o600), hash = createHash('sha256')
  const evidence = { path, maxBytes, bytes: 0, records: 0, closed: false }
  let queue = Promise.resolve(), failure
  return {
    evidence,
    append(record) {
      const operation = queue.then(async () => {
        if (failure) throw failure
        assert.ok(!evidence.closed, '证据日志已关闭')
        const buffer = Buffer.from(JSON.stringify(record) + '\n')
        assert.ok(evidence.bytes + buffer.length <= maxBytes, '证据日志超过预先声明的磁盘预算')
        let written = 0
        while (written < buffer.length) {
          const result = await file.write(buffer, written, buffer.length - written)
          assert.ok(result.bytesWritten > 0, '证据日志写入未取得进展')
          written += result.bytesWritten
        }
        hash.update(buffer); evidence.bytes += buffer.length; evidence.records++
      })
      queue = operation.catch(error => { failure ??= error })
      return operation
    },
    async close() {
      await queue
      if (!evidence.closed) {
        try { await file.sync() }
        finally { await file.close(); evidence.closed = true; evidence.sha256 = hash.digest('hex') }
      }
      if (failure) throw failure
      return evidence
    },
  }
}
