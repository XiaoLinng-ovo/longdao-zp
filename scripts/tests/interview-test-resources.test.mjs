import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertInterviewTestMemory } from '../interview-test-resources.mjs'

test('speech acceptance refuses memory pressure before loading models or starting fixtures', () => {
  assert.deepEqual(assertInterviewTestMemory({ FreeVirtualMemory: 8 * 1024 ** 2, FreePhysicalMemory: 2 * 1024 ** 2 }), { freeCommitMb: 8192, freePhysicalMb: 2048, minimumCommitMb: 6144 })
  assert.throws(() => assertInterviewTestMemory({ FreeVirtualMemory: 3 * 1024 ** 2, FreePhysicalMemory: 2 * 1024 ** 2 }), /INTERVIEW_TEST_MEMORY_PRESSURE/)
  assert.throws(() => assertInterviewTestMemory({ FreeVirtualMemory: 8 * 1024 ** 2, FreePhysicalMemory: 512 * 1024 }), /INTERVIEW_TEST_MEMORY_PRESSURE/)
  assert.throws(() => assertInterviewTestMemory({}), /Cannot establish/)
  assert.throws(() => assertInterviewTestMemory({}, 0), /Invalid acceptance memory threshold/)
})
