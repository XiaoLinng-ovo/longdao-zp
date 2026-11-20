import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openEvidenceJournal } from '../bounded-evidence-journal.mjs'

test('并发追加按调用顺序排空，关闭后核对字节、条数和散列', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'evidence-journal-'))
  const path = join(directory, 'test.jsonl'), journal = await openEvidenceJournal(path, 16384)
  try {
    await Promise.all(Array.from({ length: 50 }, (_, index) => journal.append({ index, value: '合成证据' })))
    const result = await journal.close(), bytes = await readFile(path)
    assert.deepEqual(bytes.toString().trim().split('\n').map(line => JSON.parse(line).index), Array.from({ length: 50 }, (_, index) => index))
    assert.equal(result.bytes, bytes.length); assert.equal(result.records, 50); assert.equal(result.closed, true)
    assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'))
    assert.deepEqual(await journal.close(), result)
    await assert.rejects(journal.append({ forbidden: true }), /关闭/)
    await assert.rejects(journal.close(), /关闭/)
  } finally { await journal.close().catch(() => {}); await rm(directory, { recursive: true, force: true }) }
})
test('达到磁盘预算即失败，不截断、不丢记录、不继续写入并保留失败状态', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'evidence-journal-'))
  const path = join(directory, 'test.jsonl'), journal = await openEvidenceJournal(path, 16)
  try {
    await journal.append({ a: 1 })
    await assert.rejects(journal.append({ tooLong: '不允许超过预算' }), /预算/)
    await assert.rejects(journal.append({ b: 2 }), /预算/)
    await assert.rejects(journal.close(), /预算/)
    assert.equal((await readFile(path)).toString(), '{"a":1}\n'); assert.equal(journal.evidence.closed, true)
    await assert.rejects(openEvidenceJournal(path, 16), { code: 'EEXIST' })
  } finally { await journal.close().catch(() => {}); await rm(directory, { recursive: true, force: true }) }
})
